import { ask } from "@tauri-apps/plugin-dialog";
import { openForm } from "./overlays.js";

// Branch, merge, rebase and stash actions, and the context menus that offer them.
// `run(titles, command, args, options)` performs a backend command with progress and
// error reporting, resolving to the error message or null; `overview` is the
// repository overview ref.
export function useGitActions({ overview, run }) {
  const current = () => overview.value?.head.branch ?? null;
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
      { label: `Merge “${name}” into “${head}”`, action: () => merge(name), disabled: isCurrent || !head || midOperation() },
      { label: `Rebase “${head}” onto “${name}”`, action: () => rebase(name), disabled: isCurrent || !head || midOperation() },
      { separator: true },
      { label: `New Branch from “${name}”…`, action: () => newBranch(name, name) },
      { label: "Rename…", action: () => renameBranch(name) },
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
    ];
  }

  function tagMenu(name) {
    const head = current();
    return [
      { label: "Check Out", action: () => checkout("tag", name) },
      { label: `New Branch from “${name}”…`, action: () => newBranch(name, name) },
      { separator: true },
      { label: `Merge “${name}” into “${head}”`, action: () => merge(name), disabled: !head || midOperation() },
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
      { separator: true },
      { label: "Copy Commit Hash", action: () => navigator.clipboard.writeText(commit.id) },
    ];
  }

  return {
    checkout,
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
