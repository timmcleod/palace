import { afterEach, expect, test, vi } from "vitest";
import { SCROLL_EDGE, edgeScroll, edgeScroller, pointerDrag } from "./rowDrag.js";

afterEach(() => (document.body.innerHTML = ""));

const pointer = (type, x, y = 10) => new PointerEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true });

// A row, and a drag of it, recording what's called.
function setUp(options = {}) {
  const row = document.createElement("div");
  document.body.append(row);
  const calls = { start: vi.fn(), move: vi.fn(), drop: vi.fn(), key: vi.fn(), end: vi.fn() };
  const drag = pointerDrag({
    image: ({ data }) => Object.assign(document.createElement("div"), { textContent: data }),
    ...calls,
    ...options,
  });
  row.addEventListener("pointerdown", (event) => drag.press(event, "feature"));
  return { row, drag, ...calls };
}

test("a press is a click until the pointer's moved a few pixels, then a drag with an image following it", () => {
  const { row, start, move } = setUp();
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointermove", 12));
  expect(start).not.toHaveBeenCalled();
  expect(document.querySelector(".following")).toBeNull();
  window.dispatchEvent(pointer("pointermove", 40));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ data: "feature", element: row }));
  expect(move).toHaveBeenCalled();
  expect(document.querySelector(".following").textContent).toBe("feature");
  expect(document.body.classList.contains("dragging-row")).toBe(true);
});

test("the image is placed on the window, whatever it's styled as, and held 14px into its left end", () => {
  const { row } = setUp();
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointermove", 40, 10));
  const image = document.querySelector(".following");
  expect(image.style.position).toBe("fixed");
  expect(image.style.pointerEvents).toBe("none");
  // The page under test has no layout: the image is 0 pixels high.
  expect(image.style.getPropertyValue("translate")).toBe("26px 10px");
});

test("or held at the point hold() gives", () => {
  const hold = vi.fn(() => ({ x: 30, y: 4 }));
  const { row } = setUp({ hold });
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointermove", 40, 10));
  expect(hold).toHaveBeenCalledWith(expect.objectContaining({ data: "feature", element: row, x: 10, y: 10 }));
  expect(document.querySelector(".following").style.getPropertyValue("translate")).toBe("10px 6px");
});

test("reshaped as it moves, it's held as it's then told, from that move on", () => {
  const reshape = vi.fn((event, image) => {
    if (event.clientX < 100) return null;
    image.classList.add("compact");
    return { x: -12, y: -14 };
  });
  const { row } = setUp({ reshape, hold: () => ({ x: 5, y: 5 }) });
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointermove", 40, 10));
  const image = document.querySelector(".following");
  expect(image.style.getPropertyValue("translate")).toBe("35px 5px");
  window.dispatchEvent(pointer("pointermove", 200, 10));
  expect(image.classList.contains("compact")).toBe(true);
  expect(image.style.getPropertyValue("translate")).toBe("212px 24px");
  expect(reshape).toHaveBeenLastCalledWith(expect.objectContaining({ clientX: 200 }), image);
});

test("turned or scaled, all of it as drawn stays in the window, its corners too", () => {
  // 200 by 40, drawn 8 wider and 10 higher, as turned a little: 4 and 5 past each side.
  const image = () => {
    const el = document.createElement("div");
    Object.defineProperties(el, { offsetWidth: { value: 200 }, offsetHeight: { value: 40 } });
    el.getBoundingClientRect = () => ({ left: -4, top: -5, right: 204, bottom: 45, width: 208, height: 50 });
    return el;
  };
  const { row } = setUp({ image, hold: () => ({ x: 0, y: 0 }) });
  row.dispatchEvent(pointer("pointerdown", 10));
  window.dispatchEvent(pointer("pointermove", -100, -100));
  const following = document.querySelector(".following");
  expect(following.style.getPropertyValue("translate")).toBe("4px 5px");
  window.dispatchEvent(pointer("pointermove", innerWidth + 100, innerHeight + 100));
  expect(following.style.getPropertyValue("translate")).toBe(`${innerWidth - 204}px ${innerHeight - 45}px`);
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
  expect(document.querySelector(".following")).toBeNull();
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
  expect(document.querySelector(".following")).toBeNull();
  expect(document.body.classList.contains("dragging-row")).toBe(false);
});

test("near a list's ends, dragging scrolls it, faster the nearer or further past the end", () => {
  expect(edgeScroll(150, 0, 300)).toBe(0);
  expect(edgeScroll(SCROLL_EDGE, 0, 300)).toBe(0);
  expect(edgeScroll(20, 0, 300)).toBe(-4);
  expect(edgeScroll(0, 0, 300)).toBe(-SCROLL_EDGE / 2);
  expect(edgeScroll(-100, 0, 300)).toBe(-SCROLL_EDGE / 2);
  expect(edgeScroll(290, 0, 300)).toBe(9);
  expect(edgeScroll(900, 0, 300)).toBe(SCROLL_EDGE / 2);
});

test("an edge scroller scrolls a frame at a time while the pointer's near an end, and stops once it can't go further", () => {
  const frames = [];
  vi.stubGlobal("requestAnimationFrame", (run) => frames.push(run));
  vi.stubGlobal("cancelAnimationFrame", () => frames.splice(0));
  // A list that scrolls no further up than its top, as one on the page doesn't.
  let top = 100;
  const list = {
    get scrollTop() {
      return top;
    },
    set scrollTop(value) {
      top = Math.max(0, value);
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 300, left: 0, right: 200 }),
  };
  const scrolled = vi.fn();
  let beside = false;
  const scroller = edgeScroller({ element: () => list, near: () => !beside, scrolled });
  const nextFrame = () => frames.shift()?.();

  scroller.follow({ x: 50, y: 0 });
  // Asked again as it moves, it's still one frame at a time.
  scroller.follow({ x: 50, y: 0 });
  expect(frames).toHaveLength(1);
  nextFrame();
  expect([list.scrollTop, scrolled.mock.calls.length]).toEqual([100 - SCROLL_EDGE / 2, 1]);
  // At the top already, it stops.
  list.scrollTop = 0;
  nextFrame();
  expect(frames).toHaveLength(0);

  // Not where it's said not to, as beside the list.
  beside = true;
  list.scrollTop = 100;
  scroller.follow({ x: 50, y: 0 });
  nextFrame();
  expect(list.scrollTop).toBe(100);

  // Stopped, nothing's left to run.
  beside = false;
  scroller.follow({ x: 50, y: 0 });
  scroller.stop();
  expect(frames).toHaveLength(0);
  vi.unstubAllGlobals();
});
