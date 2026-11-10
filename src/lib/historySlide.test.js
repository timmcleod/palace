import { expect, test } from "vitest";
import { newestInView, slideDistance } from "./historySlide.js";

// The newest commit below its month's 34px header; each row 52px. The slide can be as
// long as 400px: the rows drawn beyond the view, in a taller one.
const shown = { before: 34, most: 400 };

test("slides down by the rows added above the newest commit", () => {
  expect(slideDistance({ ...shown, after: 86 })).toBe(52);
  // Two commits, one in a new month with its own header.
  expect(slideDistance({ ...shown, after: 34 + 34 + 52 + 52 })).toBe(138);
});

test("doesn't slide when nothing was added above it", () => {
  expect(slideDistance({ ...shown, after: 34 })).toBe(0);
  // Gone from the history, as when it was amended or undone.
  expect(slideDistance({ ...shown, after: null })).toBe(0);
});

test("doesn't slide when more came in than it can slide", () => {
  expect(slideDistance({ ...shown, after: 34 + 400 })).toBe(400);
  expect(slideDistance({ ...shown, after: 34 + 401 })).toBe(0);
  // Seven commits fit, with a new month's header among them; eight don't.
  expect(slideDistance({ ...shown, after: 34 + 34 + 7 * 52 })).toBe(398);
  expect(slideDistance({ ...shown, after: 34 + 34 + 8 * 52 })).toBe(0);
});

test("the newest commit is in view until it's scrolled wholly past", () => {
  const newest = { top: 34, rowHeight: 52 };
  expect(newestInView({ ...newest, scrollTop: 0 })).toBe(true);
  expect(newestInView({ ...newest, scrollTop: 85 })).toBe(true);
  expect(newestInView({ ...newest, scrollTop: 86 })).toBe(false);
});
