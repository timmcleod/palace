import { expect, test } from "vitest";
import { inMiddle, nearestPlace, placesAmong } from "./branchDrag.js";

// Rows 28 pixels tall, one under another: main, a folder open with two branches in it,
// and fix, then a remote branch in another section.
const spans = [
  ["branch:main", 0],
  ["branch-folder:feature", 0],
  ["branch:feature/a", 1],
  ["branch:feature/b", 1],
  ["branch:fix", 0],
  ["remote-branch:origin/main", 0],
].map(([key, depth], i) => ({ key, depth, top: i * 28, bottom: (i + 1) * 28 }));
const topLevel = new Set(["branch:main", "branch-folder:feature", "branch:fix"]);

test("a row can land before each of its siblings, or after the last", () => {
  const places = placesAmong(spans, (key) => topLevel.has(key));
  expect(places.map((place) => [place.y, place.at])).toEqual([
    [0, { key: "branch:main", after: false }],
    [28, { key: "branch-folder:feature", after: false }],
    [112, { key: "branch:fix", after: false }],
    [140, { key: "branch:fix", after: true }],
  ]);
});

test("after a folder open last, it lands past the folder's own rows, where the gap opens", () => {
  const inFolder = new Set(["branch-folder:feature"]);
  const last = placesAmong(spans, (key) => inFolder.has(key) || key === "branch:main").at(-1);
  expect(last).toEqual({ y: 112, at: { key: "branch-folder:feature", after: true }, gap: { key: "branch:feature/b", after: true } });
});

test("it lands at the nearest place, but not dragged well away from its siblings", () => {
  const places = placesAmong(spans, (key) => key.startsWith("branch:feature/"));
  // Before a, before b, after b.
  expect(nearestPlace(places, 60, 14).at).toEqual({ key: "branch:feature/a", after: false });
  expect(nearestPlace(places, 80, 14).at).toEqual({ key: "branch:feature/b", after: false });
  expect(nearestPlace(places, 120, 14).at).toEqual({ key: "branch:feature/b", after: true });
  expect(nearestPlace(places, 10, 14)).toBeNull();
  expect(nearestPlace(places, 140, 14)).toBeNull();
  expect(nearestPlace([], 10, 14)).toBeNull();
});

test("the middle half of HEAD's row merges, its edges move", () => {
  const head = { top: 100, bottom: 140 };
  expect(inMiddle(head, 120)).toBe(true);
  expect(inMiddle(head, 105)).toBe(false);
  expect(inMiddle(head, 135)).toBe(false);
});
