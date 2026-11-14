import { afterEach, expect, test, vi } from "vitest";
import { commitLanding, draggedCommits, dropCommits, gapBefore, takeDroppedCommits } from "./commitDrag.js";

afterEach(() => (draggedCommits.value = null));

// A month's heading, then commits 0 to 3, each row 50 high: the heading 0–30, commit 0 at
// 30–80, 1 at 80–130, 2 at 130–180, 3 at 180–230.
const ROW = 50;
const layout = {
  items: [{ header: true, next: 0 }, { index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
  offsets: [0, 30, 80, 130, 180],
  height: 230,
};
const anywhere = () => true;

test("a commit dragged lands above or below the one under the pointer, by which half it's over", () => {
  expect(commitLanding(layout, ROW, 140, [0], anywhere)).toEqual({ index: 2, above: true });
  expect(commitLanding(layout, ROW, 170, [0], anywhere)).toEqual({ index: 2, above: false });
  // Over a month's heading, above the commit after it.
  expect(commitLanding(layout, ROW, 10, [3], anywhere)).toEqual({ index: 0, above: true });
});

test("nowhere it would stay where it is, nor where it can't go, nor off the list", () => {
  // Commit 1 dragged: over itself, or the halves beside it.
  expect(commitLanding(layout, ROW, 100, [1], anywhere)).toBeNull();
  expect(commitLanding(layout, ROW, 60, [1], anywhere)).toBeNull();
  expect(commitLanding(layout, ROW, 140, [1], anywhere)).toBeNull();
  expect(commitLanding(layout, ROW, 170, [1], (index) => index !== 2)).toBeNull();
  expect(commitLanding(layout, ROW, -5, [1], anywhere)).toBeNull();
  expect(commitLanding(layout, ROW, 230, [1], anywhere)).toBeNull();
});

test("several dragged, nowhere among them, nor just beside them where they're together", () => {
  // 1 and 2, together: over either, just above 1 or below 2, they'd stay.
  expect(commitLanding(layout, ROW, 140, [1, 2], anywhere)).toBeNull();
  expect(commitLanding(layout, ROW, 60, [1, 2], anywhere)).toBeNull();
  expect(commitLanding(layout, ROW, 190, [1, 2], anywhere)).toBeNull();
  expect(commitLanding(layout, ROW, 40, [1, 2], anywhere)).toEqual({ index: 0, above: true });
  // 0 and 2, apart: anywhere but over them gathers them, just below 2 too.
  expect(commitLanding(layout, ROW, 170, [0, 2], anywhere)).toBeNull();
  expect(commitLanding(layout, ROW, 190, [0, 2], anywhere)).toEqual({ index: 3, above: true });
  expect(commitLanding(layout, ROW, 100, [0, 2], anywhere)).toEqual({ index: 1, above: true });
});

test("the gap opens before the commit it'd go above, or after the one it'd go below", () => {
  expect(gapBefore({ index: 2, above: true })).toBe(2);
  expect(gapBefore({ index: 2, above: false })).toBe(3);
});

test("commits let go of are taken by whatever takes them where they are", () => {
  const commit = { id: "abc", summary: "Fix it" };
  const elsewhere = vi.fn(() => false);
  const here = vi.fn(() => true);
  const stops = [takeDroppedCommits(elsewhere), takeDroppedCommits(here)];
  // With none dragged, nothing's asked.
  expect(dropCommits()).toBe(false);
  expect(here).not.toHaveBeenCalled();
  draggedCommits.value = [commit];
  expect(dropCommits()).toBe(true);
  expect(here).toHaveBeenCalledWith([commit]);
  for (const stop of stops) stop();
  expect(dropCommits()).toBe(false);
});
