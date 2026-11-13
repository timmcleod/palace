import { afterEach, expect, test, vi } from "vitest";
import { pointerDrag } from "./rowDrag.js";

afterEach(() => (document.body.innerHTML = ""));

const pointer = (type, x, y = 10) => new PointerEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true });

// A row, and a drag of it, recording what's called.
function setUp() {
  const row = document.createElement("div");
  document.body.append(row);
  const calls = { start: vi.fn(), move: vi.fn(), drop: vi.fn(), key: vi.fn(), end: vi.fn() };
  const drag = pointerDrag({
    image: ({ data }) => Object.assign(document.createElement("div"), { textContent: data }),
    ...calls,
  });
  row.addEventListener("pointerdown", (event) => drag.press(event, "feature"));
  return { row, drag, ...calls };
}

test("a press is a click until the pointer's moved a few pixels, then a drag with an image following it", () => {
  const { row, start, move } = setUp();
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointermove", 12));
  expect(start).not.toHaveBeenCalled();
  expect(document.querySelector(".drag-image")).toBeNull();
  window.dispatchEvent(pointer("pointermove", 40));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ data: "feature", element: row }));
  expect(move).toHaveBeenCalled();
  expect(document.querySelector(".drag-image.following").textContent).toBe("feature");
  expect(document.body.classList.contains("dragging-row")).toBe(true);
});

test("released, it drops, then ends, and the click that follows isn't one", () => {
  const { row, drop, end } = setUp();
  const clicked = vi.fn();
  row.addEventListener("click", clicked);
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointermove", 40));
  window.dispatchEvent(pointer("pointerup", 40));
  expect(drop).toHaveBeenCalled();
  expect(end).toHaveBeenCalled();
  expect(drop.mock.invocationCallOrder[0]).toBeLessThan(end.mock.invocationCallOrder[0]);
  row.click();
  expect(clicked).not.toHaveBeenCalled();
  expect(document.querySelector(".drag-image")).toBeNull();
  expect(document.body.classList.contains("dragging-row")).toBe(false);
});

test("a press released where it was is a click, and nothing's dropped", () => {
  const { row, drop, end } = setUp();
  const clicked = vi.fn();
  row.addEventListener("click", clicked);
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointerup", 10));
  row.click();
  expect(drop).not.toHaveBeenCalled();
  expect(end).toHaveBeenCalled();
  expect(clicked).toHaveBeenCalled();
});

test("Escape ends it without a drop; other keys are the caller's", () => {
  const { row, drop, key, end } = setUp();
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointermove", 40));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
  expect(key).toHaveBeenCalledWith(expect.objectContaining({ key: "Alt" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(end).toHaveBeenCalled();
  window.dispatchEvent(pointer("pointerup", 40));
  expect(drop).not.toHaveBeenCalled();
});

test("a drop that fails still ends the drag", () => {
  const row = document.createElement("div");
  document.body.append(row);
  const end = vi.fn();
  const drag = pointerDrag({
    image: () => document.createElement("div"),
    drop: () => {
      throw new Error("failed");
    },
    end,
  });
  row.addEventListener("pointerdown", (event) => drag.press(event, "x"));
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointermove", 40));
  // The drop's error comes out as it was; the drag ends regardless.
  expect(() => window.dispatchEvent(pointer("pointerup", 40))).toThrow("failed");
  expect(end).toHaveBeenCalled();
  expect(document.querySelector(".drag-image")).toBeNull();
  expect(document.body.classList.contains("dragging-row")).toBe(false);
});
