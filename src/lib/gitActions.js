import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { openForm, openMergeDialog, openPullDialog, openResetDialog, openTagDialog } from "./overlays.js";
import { readJson, writeJson } from "./storage.js";

// The Pull dialog's last choices, offered again next time.
const PULL_CHOICES_KEY = "palace.pullChoices";

// Branch, merge, rebase and stash actions, and the context menus that offer them.
// `run(titles, command, args, options)` performs a backend command with progress and
// error reporting, resolving to the error message or null; `overview` is the
// repository overview ref.
export function useGitActions({ overview, run }) {
  const current = () => overview.value?.head.branch ?? null;
  const headBranchInfo = () => overview.value?.branches.find((b) => b.is_head) ?? null;
  // Git won't start a merge or rebase while another operation is waiting on the user.
  const midOperation = () => !!overview.value?.operation;

  const confirm = (message, title, okLabel) =>
    ask(message, { title, kind: "warning", okLabel, cancelLabel: "Cancel" });

  function checkout(kind, name) {
    return run(["Checking out…", "Checked out", "Checkout failed"], "checkout", { kind, name });
  }

  async function newBranch(start = null, startLabel = null) {
    const values = await openForm({
      title: "New Branch",
      message: startLabel ? `The branch will start at ${startLabel}.` : `The branch will start at ${current() ?? "HEAD"}.`,
      fields: [
        { key: "name", label: "Name", type: "text", placeholder: "feature/my-change" },
        { key: "checkout", label: "Check out the new branch", type: "checkbox", value: true },
      ],
      confirmLabel: "Create Branch",
    });
    if (!values) return;
    await run(["Creating branch…", "Created branch", "Couldn't create the branch"], "create_branch", {
      name: values.name.trim(),
      start,
      checkout: values.checkout,
    });
  }

  async function renameBranch(name) {
    const values = await openForm({
      title: "Rename Branch",
      fields: [{ key: "name", label: "New name", type: "text", value: name }],
      confirmLabel: "Rename",
    });
    if (!values || values.name.trim() === name) return;
    await run(["Renaming…", "Renamed", "Couldn't rename the branch"], "rename_branch", {
      old: name,
      new: values.name.trim(),
    });
  }

  async function deleteBranch(name) {
    if (!(await confirm(`Delete the branch “${name}”?`, "Delete Branch", "Delete"))) return;
    const titles = ["Deleting branch…", "Deleted branch", "Couldn't delete the branch"];
    const notMerged = (e) => e.includes("not fully merged");
    const error = await run(titles, "delete_branch", { name, force: false }, { quietError: notMerged });
    if (error && notMerged(error)) {
      const force = await confirm(
        `“${name}” has commits that aren't merged into any other branch. If you delete it, those commits will be hard to get back.`,
        "Delete Unmerged Branch?",
        "Delete Anyway",
      );
      if (force) await run(titles, "delete_branch", { name, force: true });
    }
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
    const ok = await confirm(`Delete stash@{${index}}? Its changes will be lost.`, "Drop Stash", "Drop");
    if (ok) await run(["Dropping stash…", "Dropped stash", "Couldn't drop the stash"], "stash_drop", { index });
  }

  async function forcePush() {
    const branch = headBranchInfo();
    const target = branch?.upstream ?? "its remote";
    const ok = await confirm(
      `Force push “${current()}” to ${target}?\n\nThis replaces the remote branch with your version, discarding the commits there that you've rewritten. If someone else has pushed commits you haven't fetched, Palace stops instead of overwriting them.`,
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

  async function deleteTag(name) {
    const ok = await confirm(
      `Delete the tag “${name}”?\n\nIt's only deleted here. If you've pushed it, the copy on the remote stays.`,
      "Delete Tag",
      "Delete",
    );
    if (ok) await run(["Deleting tag…", "Deleted tag", "Couldn't delete the tag"], "delete_tag", { name });
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
    return [
      { label: "Check Out", action: () => checkout("branch", name), disabled: isCurrent },
      { separator: true },
      // Merging or rebasing a branch onto itself means nothing, so the current branch
      // doesn't offer it.
      !isCurrent && { label: `Merge “${name}” into “${head}”…`, action: () => merge(name), disabled: !head || midOperation() },
      !isCurrent && { label: `Rebase “${head}” onto “${name}”`, action: () => rebase(name), disabled: !head || midOperation() },
      !isCurrent && { separator: true },
      { label: `New Branch from “${name}”…`, action: () => newBranch(name, name) },
      { label: `New Tag at “${name}”…`, action: () => createTag(name) },
      { label: "Rename…", action: () => renameBranch(name) },
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
      { label: `New Branch from “${name}”…`, action: () => newBranch(name, name) },
      { separator: true },
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
      { label: "Push to Remote", action: () => pushTag(name), disabled: !overview.value.remotes.length },
      { label: "Delete…", action: () => deleteTag(name), danger: true },
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

  function commitMenu(commit) {
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
      { label: `Reset HEAD to “${commit.short_id}”…`, action: () => resetTo(commit.id), disabled: midOperation() },
      { separator: true },
      { label: "Copy Commit Hash", action: () => navigator.clipboard.writeText(commit.id) },
    ];
  }

  // Menus for the sidebar's section headings.
  function sectionMenu(section) {
    if (section === "tags") return [{ label: "Create New Tag…", action: () => createTag() }];
    if (section === "branches") return [{ label: "New Branch…", action: () => newBranch() }];
    return null;
  }

  return {
    checkout,
    merge,
    pull,
    forcePush,
    sectionMenu,
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
  };
}
