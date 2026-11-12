import { afterEach, expect, test, vi } from "vitest";
import { followWindowFocus } from "./windowFocus.js";

const root = document.documentElement;
let stop;
afterEach(() => {
  stop?.();
  vi.restoreAllMocks();
});

test("marks the page while its window is in the background, and unmarks it in front", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stop = followWindowFocus();
  expect(root.dataset.inactive).toBeUndefined();

  window.dispatchEvent(new FocusEvent("blur"));
  expect(root.dataset.inactive).toBe("");
  window.dispatchEvent(new FocusEvent("focus"));
  expect(root.dataset.inactive).toBeUndefined();
});

test("starts marked in a window opened behind another", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  stop = followWindowFocus();
  expect(root.dataset.inactive).toBe("");
});

test("a focus moving between parts of the page doesn't mark it", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stop = followWindowFocus();
  const input = document.body.appendChild(document.createElement("input"));
  input.focus();
  input.blur();
  expect(root.dataset.inactive).toBeUndefined();
  input.remove();
});

test("once stopped, leaves the page unmarked and stops following", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  stop = followWindowFocus();
  stop();
  expect(root.dataset.inactive).toBeUndefined();
  window.dispatchEvent(new FocusEvent("blur"));
  expect(root.dataset.inactive).toBeUndefined();
});
