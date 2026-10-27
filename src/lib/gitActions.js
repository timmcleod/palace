import { ask } from "@tauri-apps/plugin-dialog";
import { openForm } from "./overlays.js";

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

  async function merge(name, { confirmFirst = true } = {}) {
    if (confirmFirst && !(await confirm(`Merge “${name}” into “${current()}”?`, "Merge", "Merge"))) return;
    await run(["Merging…", "Merged", "Merge failed"], "merge", { branch: name });
  }

  async function rebase(onto) {
    const ok = await confirm(
      `Rebase “${current()}” onto “${onto}”?\n\nThis replays ${current()}'s own commits on top of ${onto}, giving them new hashes. If they've already been pushed, you'll need to force push afterwards.`,
      "Rebase",
      "Rebase",
    );
    if (ok) await run(["Rebasing…", "Rebased", "Rebase failed"], "rebase", { onto });
  }

  // The toolbar's Merge button: pick a branch to merge into the current one.
  async function mergeInto() {
    const o = overview.value;
    const options = [
      ...o.branches.filter((b) => !b.is_head).map((b) => b.name),
      ...o.remotes.flatMap((r) => r.branches.map((b) => `${r.name}/${b}`)),
    ];
    const values = await openForm({
      title: `Merge into ${current()}`,
      fields: [{ key: "branch", label: "Branch to merge", type: "select", options, value: options[0] }],
      confirmLabel: "Merge",
    });
    if (values) await merge(values.branch, { confirmFirst: false });
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

  async function createTag(target = null, targetLabel = null) {
    const hasRemote = overview.value.remotes.length > 0;
    const values = await openForm({
      title: "New Tag",
      message: `The tag will point at ${targetLabel ?? current() ?? "HEAD"}.`,
      fields: [
        { key: "name", label: "Name", type: "text", placeholder: "v1.2.0" },
        { key: "message", label: "Message (optional; makes an annotated tag)", type: "text", optional: true },
        hasRemote && { key: "push", label: "Push the tag to the remote", type: "checkbox", value: false },
      ].filter(Boolean),
      confirmLabel: "Create Tag",
    });
    if (!values) return;
    const name = values.name.trim();
    const error = await run(["Creating tag…", "Created tag", "Couldn't create the tag"], "create_tag", {
      name,
      target,
      message: values.message.trim() || null,
    });
    if (!error && values.push) await pushTag(name);
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
      !isCurrent && { label: `Merge “${name}” into “${head}”`, action: () => merge(name), disabled: !head || midOperation() },
      !isCurrent && { label: `Rebase “${head}” onto “${name}”`, action: () => rebase(name), disabled: !head || midOperation() },
      !isCurrent && { separator: true },
      { label: `New Branch from “${name}”…`, action: () => newBranch(name, name) },
      { label: `New Tag at “${name}”…`, action: () => createTag(name, name) },
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
      { label: `Merge “${name}” into “${head}”`, action: () => merge(name), disabled: !head || midOperation() },
      { label: `Rebase “${head}” onto “${name}”`, action: () => rebase(name), disabled: !head || midOperation() },
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
      { label: `Merge “${name}” into “${head}”`, action: () => merge(name), disabled: !head || midOperation() },
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
      { label: "New Tag Here…", action: () => createTag(commit.id, commit.short_id) },
      { separator: true },
      { label: "Copy Commit Hash", action: () => navigator.clipboard.writeText(commit.id) },
    ];
  }

  return {
    checkout,
    forcePush,
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
