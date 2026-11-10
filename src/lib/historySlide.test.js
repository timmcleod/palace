import { expect, test } from "vitest";
import { newestInView, slideDistance } from "./historySlide.js";

// The newest commit below its month's 34px header; each row 52px.
const shown = { before: 34, viewportHeight: 600 };

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

test("doesn't slide when more came in than fits in view", () => {
  expect(slideDistance({ ...shown, after: 34 + 600 })).toBe(600);
  expect(slideDistance({ ...shown, after: 34 + 601 })).toBe(0);
});

test("the newest commit is in view until it's scrolled wholly past", () => {
  const newest = { top: 34, rowHeight: 52 };
  expect(newestInView({ ...newest, scrollTop: 0 })).toBe(true);
  expect(newestInView({ ...newest, scrollTop: 85 })).toBe(true);
  expect(newestInView({ ...newest, scrollTop: 86 })).toBe(false);
});
