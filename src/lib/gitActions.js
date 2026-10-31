import { invoke } from "@tauri-apps/api/core";
import { askConfirm, openForm, openMergeDialog, tell, openPullDialog, openResetDialog, openTagDialog } from "./overlays.js";
import { readJson, writeJson } from "./storage.js";
import { undoHint } from "./confirm.js";
import { githubAccount } from "./github.js";
import { githubRepoOf } from "./githubRemote.js";
import {
  addDivider,
  isArranged,
  labelDivider,
  removeKey,
  renameKey,
  resetOrder,
  topLevelKeys,
} from "./branchOrder.js";

// The Pull dialog's last choices, offered again next time.
const PULL_CHOICES_KEY = "palace.pullChoices";
// Whether the New Branch dialog last published the branch, offered again next time.
const PUBLISH_KEY = "palace.publishNewBranches";

// Branch, merge, rebase and stash actions, and the context menus that offer them.
// `run(titles, command, args, options)` performs a backend command with progress and
// error reporting, resolving to the error message or null; `overview` is the
// repository overview ref. `pullRequest` is { available(), create(branch) }, for
// branches' Create Pull Request.
export function useGitActions({ overview, run, compare, pullRequest }) {
  const current = () => overview.value?.head.branch ?? null;
  const headBranchInfo = () => overview.value?.branches.find((b) => b.is_head) ?? null;
  // Git won't start a merge or rebase while another operation is waiting on the user.
  const midOperation = () => !!overview.value?.operation;

  // Asks first. Most of what's asked about can be undone, except changes to a remote.
  const confirm = (message, title, confirmLabel, danger = true) => askConfirm({ title, message, confirmLabel, danger });

  function checkout(kind, name) {
    return run(["Checking out…", "Checked out", "Checkout failed"], "checkout", { kind, name });
  }

  async function newBranch(start = null, startLabel = null) {
    const remote = tagRemote();
    const values = await openForm({
      title: "New Branch",
      message: startLabel ? `The branch will start at ${startLabel}.` : `The branch will start at ${current() ?? "HEAD"}.`,
      fields: [
        { key: "name", label: "Name", type: "text", placeholder: "feature/my-change" },
        { key: "checkout", label: "Check out the new branch", type: "checkbox", value: true },
        remote && { key: "publish", label: `Publish it to ${remote}`, type: "checkbox", value: readJson(PUBLISH_KEY, false) },
      ].filter(Boolean),
      confirmLabel: "Create Branch",
    });
    if (!values) return;
    const name = values.name.trim();
    if (remote) writeJson(PUBLISH_KEY, values.publish);
    const error = await run(["Creating branch…", "Created branch", "Couldn't create the branch"], "create_branch", {
      name,
      start,
      checkout: values.checkout,
    });
    if (!error && values.publish) await publish(name, remote, name);
  }

  function publish(branch, remote, name) {
    return run(["Publishing…", "Published", "Couldn't publish the branch"], "publish_branch", { branch, remote, name });
  }

  // Pushes a branch that has no upstream yet, choosing the remote and the name there.
  async function publishBranch(branch) {
    const remotes = overview.value.remotes.map((r) => r.name);
    if (!remotes.length) {
      await tell("No Remote", "This repository has no remote to publish to. Add one from the + menu or the Remotes section first.");
      return;
    }
    const preferred = tagRemote() ?? remotes[0];
    const values = await openForm({
      title: "Publish Branch",
      message:
        remotes.length > 1
          ? `Push “${branch}” to a remote and track it there.`
          : `Push “${branch}” to ${preferred} and track it there.`,
      fields: [
        remotes.length > 1 && { key: "remote", label: "Remote", type: "select", options: remotes, value: preferred },
        { key: "name", label: "Name on the remote", type: "text", value: branch },
      ].filter(Boolean),
      confirmLabel: "Publish",
    });
    if (values) await publish(branch, values.remote ?? preferred, values.name.trim());
  }

  // The toolbar's push: publishes a branch the first time, pushes it after that.
  function push() {
    const head = headBranchInfo();
    if (head && !head.upstream && overview.value.remotes.length) return publishBranch(head.name);
    return run(["Pushing…", "Pushed", "Push failed"], "push");
  }

  async function renameBranch(name) {
    const values = await openForm({
      title: "Rename Branch",
      fields: [{ key: "name", label: "New name", type: "text", value: name }],
      confirmLabel: "Rename",
    });
    if (!values || values.name.trim() === name) return;
    const error = await run(["Renaming…", "Renamed", "Couldn't rename the branch"], "rename_branch", {
      old: name,
      new: values.name.trim(),
    });
    if (!error) renameKey(overview.value.path, name, values.name.trim());
  }

  // Renames a branch on its remote (`name` is e.g. "origin/old"). On GitHub, GitHub
  // renames it, which moves its open pull requests along; elsewhere it's pushed under
  // the new name and the old one deleted. Local branches that tracked it follow.
  async function renameRemoteBranch(name) {
    const remote = overview.value.remotes
      .filter((r) => name.startsWith(`${r.name}/`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!remote) return;
    const old = name.slice(remote.name.length + 1);
    const github = githubAccount.value && githubRepoOf(remote.url);
    const values = await openForm({
      title: "Rename Remote Branch",
      message: github
        ? `Rename “${old}” on ${github.owner}/${github.repo}. GitHub moves its open pull requests to the new name.`
        : `Rename “${old}” on ${remote.name}. Palace pushes it under the new name, then deletes the old one, so any open pull requests for it there may close.`,
      fields: [{ key: "name", label: "New name", type: "text", value: old }],
      confirmLabel: "Rename",
    });
    const to = values?.name.trim();
    if (!to || to === old) return;

    const branches = overview.value.branches;
    const followsLocally = branches.some((b) => b.name === old && b.upstream === name) && !branches.some((b) => b.name === to);
    const titles = ["Renaming…", "Renamed", "Couldn't rename the branch"];
    let error;
    if (github) {
      error = await run(titles, "github_rename_branch", { owner: github.owner, repo: github.repo, branch: old, newName: to });
      // GitHub finishes renaming in the background; Palace waits for it, then fetches.
      error ??= await run(titles, "finish_remote_rename", { remote: remote.name, old, new: to });
    } else {
      error = await run(titles, "rename_remote_branch", { name, new: to });
    }
    if (!error && followsLocally) renameKey(overview.value.path, old, to);
  }

  async function deleteBranch(name) {
    if (!(await confirm(`Delete the branch “${name}”?`, "Delete Branch", "Delete"))) return;
    const titles = ["Deleting branch…", "Deleted branch", "Couldn't delete the branch"];
    const notMerged = (e) => e.includes("not fully merged");
    let error = await run(titles, "delete_branch", { name, force: false }, { quietError: notMerged });
    if (error && notMerged(error)) {
      const force = await confirm(
        `“${name}” has commits that aren't merged into any other branch. If you delete it, those commits will be hard to get back.`,
        "Delete Unmerged Branch?",
        "Delete Anyway",
      );
      if (!force) return;
      error = await run(titles, "delete_branch", { name, force: true });
    }
    if (!error) removeKey(overview.value.path, `branch:${name}`);
  }

  // Deletes a branch whose pull request was merged on GitHub. A squash or rebase
  // leaves it looking unmerged to git, so it's forced; Undo brings it back.
  async function deleteMergedBranch(name) {
    const error = await run(["Deleting branch…", "Deleted branch", "Couldn't delete the branch"], "delete_branch", { name, force: true });
    if (!error) removeKey(overview.value.path, `branch:${name}`);
    return error;
  }

  // Asks how to merge `name` (or a branch to choose) into the current branch.
  async function merge(name = null) {
    const head = current();
    const choices = revisionChoices();
    const branches = choices.branches.filter((b) => b !== head);
    const values = await openMergeDialog({
      head,
      branch: name ?? branches[0] ?? choices.remoteBranches[0] ?? null,
      branches,
      remoteBranches: choices.remoteBranches,
      tags: choices.tags,
    });
    if (!values) return;
    await run(["Merging…", "Merged", "Merge failed"], "merge", { branch: values.branch, options: values.options });
  }

  async function rebase(onto) {
    const ok = await confirm(
      `Rebase “${current()}” onto “${onto}”?\n\nThis replays ${current()}'s own commits on top of ${onto}, giving them new hashes. If they've already been pushed, you'll need to force push afterwards.`,
      "Rebase",
      "Rebase",
      false,
    );
    if (ok) await run(["Rebasing…", "Rebased", "Rebase failed"], "rebase", { onto });
  }

  // The toolbar's Merge button: the Merge dialog, with a branch to choose.
  function mergeInto() {
    return merge();
  }

  async function stashSave() {
    const values = await openForm({
      title: "Stash Changes",
      message: "Set your uncommitted changes aside, leaving the working copy clean.",
      fields: [
        { key: "message", label: "Description (optional)", type: "text", optional: true },
        { key: "includeUntracked", label: "Include untracked files", type: "checkbox", value: true },
      ],
      confirmLabel: "Stash",
    });
    if (!values) return;
    await run(["Stashing…", "Stashed", "Couldn't stash"], "stash_save", {
      message: values.message.trim() || null,
      includeUntracked: values.includeUntracked,
    });
  }

  function stashApply(index, pop) {
    return run(
      pop ? ["Popping stash…", "Popped stash", "Couldn't pop the stash"] : ["Applying stash…", "Applied stash", "Couldn't apply the stash"],
      "stash_apply",
      { index, pop },
    );
  }

  async function stashDrop(index) {
    const ok = await confirm(`Delete stash@{${index}}?\n\n${undoHint()}`, "Drop Stash", "Drop");
    if (ok) await run(["Dropping stash…", "Dropped stash", "Couldn't drop the stash"], "stash_drop", { index });
  }

  async function forcePush() {
    const branch = headBranchInfo();
    const target = branch?.upstream ?? "its remote";
    const ok = await confirm(
      `Force push “${current()}” to ${target}?\n\nThis replaces the remote branch with your version, discarding the commits there that you've rewritten. If someone else has pushed commits you haven't pulled, Palace stops instead of overwriting them.`,
      "Force Push",
      "Force Push",
    );
    if (ok) await run(["Force pushing…", "Force pushed", "Force push failed"], "push", { force: true });
  }

  async function deleteRemoteBranch(name) {
    const ok = await confirm(
      `Delete “${name}” from the remote?\n\nThe branch is removed for everyone who uses the remote. Your local branches aren't affected.`,
      "Delete Remote Branch",
      "Delete",
    );
    if (ok) await run(["Deleting remote branch…", "Deleted remote branch", "Couldn't delete the remote branch"], "delete_remote_branch", { name });
  }

  // Opens the Create New Tag dialog on `revision` (the current branch when omitted).
  // Pushing a version tag is how releases are published.
  // Asks which remote branch to pull into the current branch, and how.
  async function pull(from = null) {
    const titles = ["Pulling…", "Pulled", "Pull failed"];
    const o = overview.value;
    const head = headBranchInfo();
    const remotes = o.remotes.filter((r) => r.branches.length).map((r) => ({ name: r.name, branches: r.branches }));
    // Nothing to choose from (a detached HEAD, no remotes): the backend explains why.
    if (!head || !remotes.length) return run(titles, "pull");

    const choices = remotes.flatMap((r) => r.branches.map((b) => `${r.name}/${b}`));
    const saved = readJson(PULL_CHOICES_KEY, {});
    // Until a choice has been made here, start with what git is configured to do.
    const rebase = saved.rebase ?? (await invoke("pull_mode", { path: o.path }).catch(() => "merge")) === "rebase";
    const values = await openPullDialog({
      branch: head.name,
      from: [from, head.upstream].find((b) => choices.includes(b)) ?? choices[0],
      remotes,
      rebase,
      autostash: saved.autostash ?? true,
    });
    if (!values) return;
    writeJson(PULL_CHOICES_KEY, { rebase: values.rebase, autostash: values.autostash });
    return run(titles, "pull", { options: values });
  }

  // Everything a revision field can offer, the current branch first.
  function revisionChoices() {
    const o = overview.value;
    const head = current();
    return {
      branches: [head, ...o.branches.map((b) => b.name).filter((n) => n !== head)].filter(Boolean),
      remoteBranches: o.remotes.flatMap((r) => r.branches.map((b) => `${r.name}/${b}`)),
      tags: o.tags,
    };
  }

  async function createTag(revision = null) {
    const o = overview.value;
    const values = await openTagDialog({
      path: o.path,
      revision: revision ?? current() ?? "HEAD",
      ...revisionChoices(),
      hasRemote: o.remotes.length > 0,
    });
    if (!values) return;
    const error = await run(["Creating tag…", "Created tag", "Couldn't create the tag"], "create_tag", {
      name: values.name,
      target: values.revision,
      message: values.message || null,
    });
    if (!error && values.push) await pushTag(values.name);
  }

  // Moves HEAD, and the branch it's on, to another commit.
  async function resetTo(revision) {
    const values = await openResetDialog({
      path: overview.value.path,
      revision,
      branch: current(),
      upstream: headBranchInfo()?.upstream ?? null,
      ...revisionChoices(),
    });
    if (!values) return;
    return run(["Resetting…", "Reset", "Couldn't reset"], "reset", {
      revision: values.revision,
      keepChanges: values.keepChanges,
    });
  }

  // --- Rewriting the current branch ---------------------------------------------------
  // Squashing and moving commits rebase the branch from the oldest commit involved.
  // `entries` are { commit, index } from the history list, where a larger index is older.

  async function rewritePlan(entries, title) {
    const oldest = entries.reduce((a, b) => (b.index > a.index ? b : a));
    try {
      return await invoke("rebase_plan", { path: overview.value.path, from: oldest.commit.id });
    } catch (e) {
      await tell(title, String(e));
      return null;
    }
  }

  const pushedNote = (plan) =>
    plan.pushed ? `\n\nSome of these commits are already on ${plan.upstream}, so you'll need to force push afterwards.` : "";

  // Combines several commits into one, with a message made from theirs.
  async function squashCommits(entries) {
    const title = `Squash ${entries.length} Commits`;
    const plan = await rewritePlan(entries, "Can't Squash These Commits");
    if (!plan) return;
    const ids = new Set(entries.map((e) => e.commit.id));
    const squashed = plan.commits.filter((c) => ids.has(c.id));
    if (squashed.length !== ids.size) {
      await tell("Can't Squash These Commits", `Only commits on ${plan.branch} can be squashed here.`);
      return;
    }

    const values = await openForm({
      title,
      message: `They become one commit, where the oldest of them is now.${pushedNote(plan)}`,
      fields: [{ key: "message", label: "Message", type: "textarea", value: squashed.map((c) => c.message).join("\n\n") }],
      confirmLabel: "Squash",
    });
    if (!values) return;

    // The oldest keeps its place with the new message; the others fold into it, and
    // every other commit keeps its order.
    const [first, ...rest] = squashed;
    const steps = [
      ...plan.commits
        .filter((c) => c.id === first.id)
        .map((c) => ({ id: c.id, action: "pick", message: values.message })),
      ...rest.map((c) => ({ id: c.id, action: "fixup", message: null })),
      ...plan.commits.filter((c) => !ids.has(c.id)).map((c) => ({ id: c.id, action: "pick", message: null })),
    ];
    await run(["Squashing…", "Squashed", "Couldn't squash"], "rebase_interactive", { base: plan.base, steps }, { undo: "Squash" });
  }

  // Gives a commit on the current branch a new message. The commits after it are
  // replayed unchanged.
  async function editMessage(commit) {
    const title = "Can't Edit This Message";
    const plan = await rewritePlan([{ commit, index: 0 }], title);
    if (!plan) return;
    const [edited, ...later] = plan.commits;
    if (edited?.id !== commit.id) {
      await tell(title, `Only commits on ${plan.branch} can be edited here.`);
      return;
    }

    const notes = [
      later.length === 1 && "The commit after it gets a new hash too, but its changes stay the same.",
      later.length > 1 && `The ${later.length} commits after it get new hashes too, but their changes stay the same.`,
      // The edited commit is the oldest, so if any are pushed, it is.
      plan.pushed && `It's already on ${plan.upstream}, so you'll need to force push afterwards.`,
    ];
    const values = await openForm({
      title: "Edit Commit Message",
      message: notes.filter(Boolean).join("\n\n") || null,
      fields: [{ key: "message", label: "Message", type: "textarea", value: edited.message }],
      confirmLabel: "Save",
    });
    if (!values || values.message.trim() === edited.message.trim()) return;

    const steps = plan.commits.map((c) => ({ id: c.id, action: "pick", message: c === edited ? values.message : null }));
    await run(["Editing message…", "Edited message", "Couldn't edit the message"], "rebase_interactive", { base: plan.base, steps }, {
      undo: "Edit Message",
    });
  }

  // Moves a commit to just above (newer than) or below (older than) another.
  async function moveCommit(moving, target, position) {
    const plan = await rewritePlan([moving, target], "Can't Move This Commit");
    if (!plan) return;
    const order = plan.commits.map((c) => c.id).filter((id) => id !== moving.commit.id);
    const at = order.indexOf(target.commit.id);
    if (at < 0 || !plan.commits.some((c) => c.id === moving.commit.id)) {
      await tell("Can't Move This Commit", `Only commits on ${plan.branch} can be moved here.`);
      return;
    }
    // The list is oldest first: above in the history means after.
    order.splice(position === "above" ? at + 1 : at, 0, moving.commit.id);

    const subject = (commit) => `“${commit.summary}”`;
    const ok = await askConfirm({
      title: "Move Commit",
      message: `Move ${subject(moving.commit)} ${position} ${subject(target.commit)}?\n\nThis rewrites ${plan.commits.length} commits on ${plan.branch}, giving them new hashes. If the changes depend on each other, git may stop for you to resolve conflicts.${pushedNote(plan)}`,
      confirmLabel: "Move",
    });
    if (!ok) return;
    const steps = order.map((id) => ({ id, action: "pick", message: null }));
    await run(["Moving commit…", "Moved commit", "Couldn't move the commit"], "rebase_interactive", { base: plan.base, steps }, {
      undo: "Move Commit",
    });
  }

  // The menu for several selected commits.
  function commitsMenu(entries, rewritable) {
    return [
      {
        label: `Squash ${entries.length} Commits…`,
        action: () => squashCommits(entries),
        disabled: !rewritable || midOperation(),
      },
      { separator: true },
      { label: "Copy Commit Hashes", action: () => navigator.clipboard.writeText(entries.map((e) => e.commit.id).join("\n")) },
    ];
  }

  // Copies a commit's changes onto the current branch as a new commit.
  function cherryPick(commit) {
    return run(["Cherry-picking…", "Cherry-picked", "Couldn't cherry-pick"], "cherry_pick", { id: commit.id });
  }

  // Adds a commit that undoes another's changes.
  function revert(commit) {
    return run(["Reverting…", "Reverted", "Couldn't revert"], "revert", { id: commit.id });
  }

  function pushTag(name) {
    return run(["Pushing tag…", "Pushed tag", "Couldn't push the tag"], "push_tag", { name });
  }

  // The remote tags are pushed to and deleted from: origin, or the only remote.
  function tagRemote() {
    const names = overview.value.remotes.map((r) => r.name);
    return names.includes("origin") ? "origin" : names.length === 1 ? names[0] : null;
  }

  async function deleteTag(name) {
    const remote = tagRemote();
    const values = await openForm({
      title: "Delete Tag",
      message: `Delete the tag “${name}”?`,
      fields: remote ? [{ key: "remote", label: `Also delete it from ${remote}`, type: "checkbox", value: false }] : [],
      confirmLabel: "Delete",
      danger: true,
    });
    if (!values) return;
    const error = await run(["Deleting tag…", "Deleted tag", "Couldn't delete the tag"], "delete_tag", { name });
    if (!error && values.remote) await deleteRemoteTag(name);
  }

  function deleteRemoteTag(name) {
    return run(
      ["Deleting tag from remote…", "Deleted tag from remote", "Couldn't delete the tag from the remote"],
      "delete_remote_tag",
      { name },
    );
  }

  async function confirmDeleteRemoteTag(name) {
    const remote = tagRemote();
    const ok = await confirm(
      `Delete the tag “${name}” from ${remote}?\n\nIt's removed for everyone who uses ${remote}; your own copy stays. On GitHub, a release made from this tag becomes a draft.`,
      "Delete Tag from Remote",
      "Delete",
    );
    if (ok) await deleteRemoteTag(name);
  }

  async function controlOperation(action) {
    const operation = overview.value?.operation;
    if (action === "abort") {
      const ok = await confirm(
        `Abort the ${operation}? The branch goes back to how it was before, and any conflicts you've resolved are thrown away.`,
        `Abort ${operation}`,
        "Abort",
      );
      if (!ok) return;
    }
    const verb = { continue: "Continuing", abort: "Aborting", skip: "Skipping" }[action];
    await run([`${verb}…`, "Done", `Couldn't ${action} the ${operation}`], "control_operation", { action });
  }

  // --- Context menus ---------------------------------------------------------------

  function branchMenu(name) {
    const head = current();
    const isCurrent = name === head;
    const upstream = overview.value.branches.find((b) => b.name === name)?.upstream;
    return [
      { label: "Check Out", action: () => checkout("branch", name), disabled: isCurrent },
      !upstream && { label: `Publish “${name}”…`, action: () => publishBranch(name), disabled: !overview.value.remotes.length },
      pullRequest?.available() && { label: "Create Pull Request…", action: () => pullRequest.create(name) },
      { separator: true },
      // Merging or rebasing a branch onto itself means nothing, so the current branch
      // doesn't offer it.
      !isCurrent && { label: `Merge “${name}” into “${head}”…`, action: () => merge(name), disabled: !head || midOperation() },
      !isCurrent && { label: `Rebase “${head}” onto “${name}”`, action: () => rebase(name), disabled: !head || midOperation() },
      !isCurrent && { separator: true },
      !isCurrent && head && { label: `Compare “${name}” with “${head}”`, action: () => compare({ head: name, base: head }) },
      isCurrent && upstream && { label: `Compare “${name}” with “${upstream}”`, action: () => compare({ head: name, base: upstream }) },
      (!isCurrent && head) || (isCurrent && upstream) ? { separator: true } : null,
      { label: `New Branch from “${name}”…`, action: () => newBranch(name, name) },
      { label: `New Tag at “${name}”…`, action: () => createTag(name) },
      { label: "Rename…", action: () => renameBranch(name) },
      upstream && { label: `Rename “${upstream}”…`, action: () => renameRemoteBranch(upstream) },
      // Dividers only go between top-level rows.
      !name.includes("/") && { separator: true },
      !name.includes("/") && { label: "Add Divider Below…", action: () => newDivider(`branch:${name}`) },
      isCurrent && headBranchInfo()?.upstream && { separator: true },
      isCurrent && headBranchInfo()?.upstream && { label: "Force Push…", action: forcePush, danger: true },
      { separator: true },
      { label: "Delete…", action: () => deleteBranch(name), disabled: isCurrent, danger: true },
    ];
  }

  function remoteBranchMenu(name) {
    const head = current();
    return [
      { label: "Check Out as Local Branch", action: () => checkout("remote-branch", name) },
      { separator: true },
      { label: `Merge “${name}” into “${head}”…`, action: () => merge(name), disabled: !head || midOperation() },
      { label: `Rebase “${head}” onto “${name}”`, action: () => rebase(name), disabled: !head || midOperation() },
      { separator: true },
      { label: `Pull into “${head}”…`, action: () => pull(name), disabled: !head || midOperation() },
      { separator: true },
      { label: `Compare “${name}” with “${head ?? "HEAD"}”`, action: () => compare({ head: name, base: head ?? "HEAD" }) },
      { separator: true },
      { label: `New Branch from “${name}”…`, action: () => newBranch(name, name) },
      { separator: true },
      { label: "Rename…", action: () => renameRemoteBranch(name) },
      { label: "Delete from Remote…", action: () => deleteRemoteBranch(name), danger: true },
    ];
  }

  function tagMenu(name) {
    const head = current();
    return [
      { label: "Check Out", action: () => checkout("tag", name) },
      { label: `New Branch from “${name}”…`, action: () => newBranch(name, name) },
      { separator: true },
      { label: `Merge “${name}” into “${head}”…`, action: () => merge(name), disabled: !head || midOperation() },
      { separator: true },
      { label: `Compare “${head ?? "HEAD"}” with “${name}”`, action: () => compare({ head: head ?? "HEAD", base: name }) },
      { separator: true },
      { label: "Push to Remote", action: () => pushTag(name), disabled: !tagRemote() },
      { separator: true },
      { label: "Delete…", action: () => deleteTag(name), danger: true },
      { label: "Delete from Remote…", action: () => confirmDeleteRemoteTag(name), disabled: !tagRemote(), danger: true },
    ];
  }

  function stashMenu(index) {
    return [
      { label: "Apply", action: () => stashApply(index, false) },
      { label: "Pop (Apply and Drop)", action: () => stashApply(index, true) },
      { separator: true },
      { label: "Drop…", action: () => stashDrop(index), danger: true },
    ];
  }

  function commitMenu(commit, rewritable) {
    return [
      { label: "Check Out This Commit", action: () => checkout("commit", commit.id) },
      { label: "New Branch from Here…", action: () => newBranch(commit.id, commit.short_id) },
      { label: "New Tag Here…", action: () => createTag(commit.short_id) },
      { separator: true },
      {
        label: `Cherry-Pick “${commit.short_id}” into “${current() ?? "HEAD"}”`,
        action: () => cherryPick(commit),
        disabled: midOperation(),
      },
      { label: `Revert “${commit.short_id}”`, action: () => revert(commit), disabled: midOperation() },
      { label: "Edit Message…", action: () => editMessage(commit), disabled: !rewritable || midOperation() },
      { label: `Reset HEAD to “${commit.short_id}”…`, action: () => resetTo(commit.id), disabled: midOperation() },
      { separator: true },
      { label: "Copy Commit Hash", action: () => navigator.clipboard.writeText(commit.id) },
    ];
  }

  // --- Remotes ---------------------------------------------------------------------

  async function addRemote() {
    const values = await openForm({
      title: "Add Remote Repository",
      message:
        "Adds another repository to fetch from and push to, such as a teammate's fork or the original project you forked (often called upstream).",
      fields: [
        {
          key: "name",
          label: "Name",
          type: "text",
          value: overview.value.remotes.length ? "" : "origin",
          placeholder: "upstream",
        },
        { key: "url", label: "URL", type: "text", placeholder: "https://github.com/owner/repository.git" },
      ],
      confirmLabel: "Add Remote",
    });
    if (!values) return;
    await run(["Adding remote…", "Added remote", "Couldn't add the remote"], "add_remote", {
      name: values.name,
      url: values.url,
    });
  }

  function fetchRemote(name) {
    return run(["Fetching…", "Fetched", "Fetch failed"], "fetch", { remote: name });
  }

  async function renameRemote(name) {
    const values = await openForm({
      title: "Rename Remote",
      message: `Its remote branches are renamed to match, and branches that track them keep tracking them.`,
      fields: [{ key: "name", label: "New name", type: "text", value: name }],
      confirmLabel: "Rename",
    });
    if (!values || values.name.trim() === name) return;
    await run(["Renaming remote…", "Renamed remote", "Couldn't rename the remote"], "rename_remote", {
      name,
      newName: values.name,
    });
  }

  async function removeRemote(name) {
    const ok = await confirm(
      `Remove the remote “${name}”?\n\nIts branches disappear from Palace. Nothing changes on the server, and your local branches stay, though any that track one of its branches lose their upstream.`,
      "Remove Remote",
      "Remove",
    );
    if (ok) await run(["Removing remote…", "Removed remote", "Couldn't remove the remote"], "remove_remote", { name });
  }

  function remoteMenu(name) {
    const url = overview.value.remotes.find((r) => r.name === name)?.url;
    return [
      { label: `Fetch from “${name}”`, action: () => fetchRemote(name) },
      url && { label: "Copy URL", action: () => navigator.clipboard.writeText(url) },
      { separator: true },
      { label: "Rename…", action: () => renameRemote(name) },
      { label: "Remove…", action: () => removeRemote(name), danger: true },
    ];
  }

  // --- Arranging branches ------------------------------------------------------------

  // A divider in the sidebar's Branches, after `afterKey` or at the end.
  async function newDivider(afterKey = null) {
    const values = await openForm({
      title: "Add Divider",
      message: "A line between groups of branches. Drag it, or the branches, to arrange them.",
      fields: [{ key: "label", label: "Label", type: "text", value: "", placeholder: "None", optional: true }],
      confirmLabel: "Add Divider",
    });
    if (!values) return;
    const path = overview.value.path;
    addDivider(path, values.label.trim(), afterKey, topLevelKeys(path, overview.value.branches));
  }

  async function editDividerLabel(key, label) {
    const values = await openForm({
      title: "Edit Divider Label",
      message: "Leave it empty for just a line.",
      fields: [{ key: "label", label: "Label", type: "text", value: label, placeholder: "None", optional: true }],
      confirmLabel: "Save",
    });
    if (values) labelDivider(overview.value.path, key, values.label.trim());
  }

  function dividerMenu(key, label) {
    return [
      { label: label ? "Edit Label…" : "Add Label…", action: () => editDividerLabel(key, label) },
      { separator: true },
      { label: "Remove Divider", action: () => removeKey(overview.value.path, key) },
    ];
  }

  async function resetBranchOrder() {
    const ok = await confirm(
      "List the branches in alphabetical order again? Their dividers are removed.",
      "Reset Order",
      "Reset",
      false,
    );
    if (ok) resetOrder(overview.value.path);
  }

  // Menus for the sidebar's section headings, and its + button.
  function sectionMenu(section) {
    if (section === "tags") return [{ label: "Create New Tag…", action: () => createTag() }];
    if (section === "branches") {
      return [
        { label: "New Branch…", action: () => newBranch() },
        { separator: true },
        { label: "Add Divider…", action: () => newDivider() },
        { label: "Reset Order…", action: resetBranchOrder, disabled: !isArranged(overview.value.path) },
      ];
    }
    if (section === "remotes") return [{ label: "Add Remote Repository…", action: addRemote }];
    return null;
  }

  function addMenu() {
    return [
      { label: "Create New Branch…", action: () => newBranch() },
      { label: "Create New Tag…", action: () => createTag() },
      { separator: true },
      { label: "Add Remote Repository…", action: addRemote },
    ];
  }

  return {
    checkout,
    deleteMergedBranch,
    merge,
    commitsMenu,
    moveCommit,
    addMenu,
    remoteMenu,
    pull,
    forcePush,
    publishBranch,
    push,
    sectionMenu,
    dividerMenu,
    newBranch,
    mergeInto,
    stashSave,
    stashApply,
    controlOperation,
    branchMenu,
    remoteBranchMenu,
    tagMenu,
    stashMenu,
    commitMenu,
    revisionChoices,
  };
}
