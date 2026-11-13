import { afterEach, expect, test, vi } from "vitest";
import { slideClosed, slideFrom, slideOpen } from "./slide.js";

afterEach(() => vi.unstubAllGlobals());

// An element `height` tall with what's in it, which records how it's animated.
function element(height) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: height });
  Object.defineProperty(el, "offsetHeight", { value: height });
  el.animate = vi.fn((frames) => {
    // Hidden while it slides.
    expect(el.style.overflow).toBe("hidden");
    return { finished: Promise.resolve(), frames };
  });
  return el;
}

test("slides open from nothing to the height of what's in it, and closed again", async () => {
  const el = element(240);
  await slideOpen(el);
  expect(el.animate.mock.calls[0][0]).toEqual([{ height: "0px" }, { height: "240px" }]);
  await slideClosed(el);
  expect(el.animate.mock.calls[1][0]).toEqual([{ height: "240px" }, { height: "0px" }]);
  expect(el.style.overflow).toBe("");
});

test("doesn't slide where motion is turned down, or with nothing to slide", async () => {
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("reduce") }));
  const el = element(240);
  await slideOpen(el);
  expect(el.animate).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  const empty = element(0);
  await slideOpen(empty);
  expect(empty.animate).not.toHaveBeenCalled();
});

test("closing one still opening takes over, still hidden until it's closed", async () => {
  const el = element(240);
  const ends = [];
  el.animate = vi.fn(() => {
    let end;
    const finished = new Promise((resolve, reject) => (end = { resolve, reject }));
    ends.push(end);
    return { finished, cancel: () => end.reject(new DOMException("canceled", "AbortError")) };
  });
  const opened = slideOpen(el);
  const closed = slideClosed(el);
  await opened;
  expect(el.style.overflow).toBe("hidden");
  ends[1].resolve();
  await closed;
  expect(el.style.overflow).toBe("");
});

test("a slide canceled, as by its element going, ends quietly", async () => {
  const el = element(240);
  el.animate = () => ({ finished: Promise.reject(new DOMException("canceled", "AbortError")) });
  await expect(slideOpen(el)).resolves.toBeUndefined();
  expect(el.style.overflow).toBe("");
});

// An element on the page at `left`, `top`, which records how it's animated.
function placed(left, top) {
  const el = document.createElement("div");
  document.body.append(el);
  el.getBoundingClientRect = () => ({ left, top });
  el.animate = vi.fn();
  return el;
}

test("elements moved slide from where they were to where they are, and those that didn't, or went, don't", () => {
  const moved = placed(200, 10);
  const still = placed(0, 10);
  const gone = placed(0, 10);
  gone.remove();
  slideFrom(new Map([[moved, { left: 0, top: 30 }], [still, { left: 0, top: 10 }], [gone, { left: 400, top: 10 }]]));
  expect(moved.animate.mock.calls[0][0]).toEqual([{ transform: "translate(-200px, 20px)" }, { transform: "none" }]);
  expect(still.animate).not.toHaveBeenCalled();
  expect(gone.animate).not.toHaveBeenCalled();
  moved.remove();
  still.remove();
});

test("nor where motion is turned down", () => {
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("reduce") }));
  const moved = placed(200, 10);
  slideFrom(new Map([[moved, { left: 0, top: 10 }]]));
  expect(moved.animate).not.toHaveBeenCalled();
  moved.remove();
});
