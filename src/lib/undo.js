import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { CANCELED } from "./confirm.js";
import { CONFLICT, isError } from "./errors.js";
import { askConfirm } from "./overlays.js";

// Operations that can be undone, and what Undo calls them, from their arguments.
// Committing and discarding are undoable too, from the working copy. Network
// operations other than pull can't be: what they changed is on the remote.
const named = (label) => () => label;
const UNDOABLE = {
  checkout: named("Checkout"),
  checkout_pull: named("Checkout"),
  create_branch: named("New Branch"),
  delete_branch: named("Delete Branch"),
  delete_merged_branch: named("Delete Branch"),
  rename_branch: named("Rename Branch"),
  merge: named("Merge"),
  rebase: named("Rebase"),
  rebase_interactive: named("Rebase"),
  cherry_pick: named("Cherry-pick"),
  revert: named("Revert"),
  reset: named("Reset"),
  reset_branch: named("Reset"),
  pull: named("Pull"),
  create_tag: named("New Tag"),
  delete_tag: named("Delete Tag"),
  stash_save: named("Stash"),
  stash_apply: ({ pop }) => (pop ? "Pop Stash" : "Apply Stash"),
  stash_drop: named("Drop Stash"),
};
// The files an operation can change in the working copy, which undo keeps copies of
// (see take_snapshot).
const COVER = {
  stash_save: ({ files }) => (files ? { files } : { changed: true }),
  stash_apply: ({ index }) => ({ stash: index }),
  // Keeping changes unstages them, and what was staged of a file edited since is lost.
  reset: ({ keepChanges }) => (keepChanges ? { changed: true } : undefined),
};
const MAX_UNDO = 50;

/**
 * Undo and redo for the open repository: each step keeps take_snapshot's snapshots
 * from before and after, and undoing restores the one from before.
 *
 * overview: the repository overview ref. run: App's runGit, which undo and redo run
 * restore_snapshot through. busy(): whether an operation is under way, which they
 * wait for. draft: the commit message being written, which an undone commit's
 * message comes back to. settle(): finishes whatever runs unasked (a background
 * fetch) before a step's snapshot, so it isn't counted as part of the step.
 * offer(label, run): puts Undo or Redo on the notice for what just finished.
 */
export function useUndo({ overview, run, busy, draft, settle, offer }) {
  // The open repository's steps, oldest first: { label, mode, before, after, message },
  // where before and after are take_snapshot's snapshots and mode is restore_snapshot's.
  const undoStack = ref([]);
  const redoStack = ref([]);
  // Other repositories' steps, kept for when they're open again: path → [undo, redo].
  const otherStacks = new Map();

  // A step that stopped for conflicts, to undo as a whole once it's continued to the
  // end: { path, step, before }.
  let stopped = null;

  // The newest step, to tell whether something just added one.
  const newest = () => undoStack.value.at(-1);

  /**
   * The step running backend `command` with `args` in the open repository makes, for
   * undoable(), or null when it can't be undone. `label` names it instead of UNDOABLE.
   * Continuing or skipping to the end of what stopped makes the whole of it one step.
   */
  function stepFor(command, args, label) {
    const resumed =
      command === "control_operation" && args.action !== "abort" && stopped?.path === overview.value.path ? stopped : null;
    if (command === "control_operation" && !resumed) stopped = null;
    label = resumed?.step.label ?? label ?? UNDOABLE[command]?.(args);
    if (!label) return null;
    const mode = resumed?.step.mode ?? (command === "reset" && args.keepChanges ? "mixed" : "keep");
    return { label, mode, cover: COVER[command]?.(args), resumed };
  }

  /**
   * Runs `work`, and if it changed any branch, tag or stash, or the files `step.cover`
   * names, remembers how to undo it. `step` is { label, mode, cover } and, for a
   * commit, its message. cover is take_snapshot's: { files, changed, stash }.
   * step.resumed is a stopped step this finishes.
   */
  async function undoable({ cover, resumed, ...step }, work) {
    await settle();
    const path = overview.value.path;
    stopped = null;
    let reason = "";
    const snapshot = (cover) =>
      invoke("take_snapshot", { path, cover }).catch((e) => {
        reason = String(e);
        return null;
      });
    // Without a snapshot, it isn't undoable. Changes to files would then be lost for
    // good, though the confirmation said they could be undone, so it asks again.
    const before = resumed?.before ?? (await snapshot(cover ?? null));
    if (!before && cover) {
      const ok = await askConfirm({
        title: `${step.label} Without Undo?`,
        message: `Palace couldn't keep a copy of the changes to undo this with: ${reason}\n\nGo ahead anyway? It can't be undone.`,
        confirmLabel: step.label,
        danger: true,
      });
      if (!ok) throw CANCELED;
    }
    let result;
    try {
      result = await work();
    } catch (e) {
      if (before && isError(e, CONFLICT)) stopped = { path, step: resumed?.step ?? step, before };
      throw e;
    }
    const after = before && (await snapshot({ files: before.files.map((f) => f.path) }));
    // A rebase that stopped again leaves HEAD detached, and is still to be finished.
    if (resumed && before.head_branch && !after?.head_branch) {
      stopped = resumed;
      return result;
    }
    if (after && JSON.stringify(after) !== JSON.stringify(before) && path === overview.value?.path) {
      undoStack.value = [...undoStack.value.slice(1 - MAX_UNDO), { ...step, before, after }];
      redoStack.value = [];
    }
    return result;
  }

  const undo = () => replay(undoStack, redoStack, true);
  const redo = () => replay(redoStack, undoStack, false);

  // Undoes the newest step on `stack`, or redoes it, moving it to the other stack.
  async function replay(stack, other, undoing) {
    const step = stack.value.at(-1);
    if (!step || busy()) return;
    const [verb, did] = undoing ? ["undo", "Undid"] : ["redo", "Redid"];
    const error = await run(
      [undoing ? "Undoing…" : "Redoing…", `${did} “${step.label}”`, `Couldn't ${verb} “${step.label}”`],
      "restore_snapshot",
      undoing ? { from: step.after, to: step.before, mode: step.mode } : { from: step.before, to: step.after, mode: step.mode },
    );
    if (error) {
      // Something else has moved what it changed, so it can never be replayed.
      if (error.includes("changed since") || error.includes("moved since")) stack.value = stack.value.slice(0, -1);
      return;
    }
    stack.value = stack.value.slice(0, -1);
    other.value = [...other.value, step];
    // An undone commit's message comes back, ready to commit again, and goes away
    // when the commit is redone.
    if (step.message) {
      const [subject, ...rest] = step.message.split("\n");
      const body = rest.join("\n").trim();
      if (undoing && !draft.subject && !draft.body) Object.assign(draft, { subject, body });
      if (!undoing && draft.subject === subject && draft.body === body) Object.assign(draft, { subject: "", body: "" });
    }
    offer(undoing ? "Redo" : "Undo", undoing ? redo : undo);
  }

  // Keeps the steps of the repository at `from` (if one was open) for when it's open
  // again, and brings back those of the one at `to`.
  function switchRepository(from, to) {
    if (from) otherStacks.set(from, [undoStack.value, redoStack.value]);
    [undoStack.value, redoStack.value] = otherStacks.get(to) ?? [[], []];
    otherStacks.delete(to);
  }

  return { newest, stepFor, undoable, undo, redo, switchRepository };
}
