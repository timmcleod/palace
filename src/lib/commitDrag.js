import { shallowRef } from "vue";
import { itemAt } from "./listOffsets.js";

// Commits dragged out of the history (see HistoryList.vue), by the pointer, as branches
// are in the sidebar (see rowDrag.js), one or several chosen together: in the current
// branch's own history, to move them to another place in it, where the rows open a gap;
// from any other, to the sidebar's current branch, which cherry-picks them there.

// --- Cherry-picking -------------------------------------------------------------------
// The history says what it's dragging, and where the pointer is, and on its release
// asks whatever takes commits whether it takes them there. The sidebar does, on the
// current branch's row (see Sidebar.vue). Every tab's sidebar hears, but only the one
// showing is under the pointer.

/** The commits being dragged to cherry-pick: the one dragged, or those chosen with it, oldest first. */
export const draggedCommits = shallowRef(null);

/** Where the pointer is, dragging them: { x, y } on the page, or null. */
export const commitPointer = shallowRef(null);

const takers = new Set();

/**
 * `take(commits)` is asked, as commits are let go of, whether it takes them where the
 * pointer is, and does if it does. Returns what stops it being asked.
 */
export function takeDroppedCommits(take) {
  takers.add(take);
  return () => takers.delete(take);
}

/** Lets go of the commits dragged: whatever takes them where they are does. Says whether one did. */
export function dropCommits() {
  const commits = draggedCommits.value;
  if (!commits?.length) return false;
  for (const take of takers) if (take(commits)) return true;
  return false;
}

// --- Moving them -----------------------------------------------------------------------

/**
 * Where commits dragged in the history would be moved, with the pointer `y` down the
 * list: { index, above }, above or below the commit at `index`, by which half of its row
 * the pointer's over, or above it over the month's heading before it. Null over one of
 * them, where they can't go, `canMoveTo(index)` saying they can't, or where they'd stay
 * where they are: `moving` is where they are in the list, newest first, and next to
 * each other, they'd stay just above or below themselves. `layout` is the list's (see
 * HistoryList.vue): { items, offsets, height }, each item a heading { header, next } or a
 * commit { index }, each `rowHeight` high. Its offsets leave out the gap that opens where
 * they would go, which moves only how the rows are drawn, so that doesn't move where
 * that is.
 */
export function commitLanding(layout, rowHeight, y, moving, canMoveTo) {
  const { items, offsets, height } = layout;
  if (!items.length || y < 0 || y >= height) return null;
  const at = itemAt(offsets, y);
  const item = items[at];
  const index = item.header ? item.next : item.index;
  const above = item.header || y < offsets[at] + rowHeight / 2;
  if (moving.includes(index) || !canMoveTo(index)) return null;
  const [first, last] = [moving[0], moving.at(-1)];
  const together = last - first === moving.length - 1;
  const gap = gapBefore({ index, above });
  if (together && (gap === first || gap === last + 1)) return null;
  return { index, above };
}

/** Where the gap opens for a commit landing `at` ({ index, above }): before the commit at the index this gives, or at the end with none past it. */
export const gapBefore = (at) => (at.above ? at.index : at.index + 1);
