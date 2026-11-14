import { expect, test } from "vitest";
import { itemAt } from "./listOffsets.js";

test("finds the item a point down the list is in, the first above it, the last past it", () => {
  const offsets = [0, 34, 86, 138];
  expect([0, 33, 34, 85, 86, 200].map((y) => itemAt(offsets, y))).toEqual([0, 0, 1, 1, 2, 3]);
  expect(itemAt(offsets, -10)).toBe(0);
  expect(itemAt([], 10)).toBe(0);
});
