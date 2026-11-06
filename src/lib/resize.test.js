import { describe, expect, test, vi } from "vitest";
import { dragEdge } from "./resize.js";

// A pointerdown on an edge, as the page gets it.
function pressOn(edge, { clientX = 100, clientY = 400 } = {}) {
  edge.setPointerCapture = vi.fn();
  const event = new MouseEvent("pointerdown", { clientX, clientY, cancelable: true });
  Object.defineProperty(event, "currentTarget", { value: edge });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe("dragging a pane's edge", () => {
  test("says how far it's gone along its axis, selecting nothing meanwhile", () => {
    const edge = document.createElement("div");
    const move = vi.fn();
    const done = vi.fn();
    const press = pressOn(edge);
    dragEdge(press, { axis: "x", move, done });
    expect(press.defaultPrevented).toBe(true);
    expect(edge.setPointerCapture).toHaveBeenCalledWith(1);
    expect([...document.body.classList]).toEqual(["resizing", "resizing-columns"]);

    edge.dispatchEvent(new MouseEvent("pointermove", { clientX: 130, clientY: 0 }));
    expect(move).toHaveBeenLastCalledWith(30);

    // Let go: done, and it no longer follows the pointer.
    edge.dispatchEvent(new Event("lostpointercapture"));
    expect(done).toHaveBeenCalledOnce();
    expect(document.body.classList.length).toBe(0);
    edge.dispatchEvent(new MouseEvent("pointermove", { clientX: 200 }));
    expect(move).toHaveBeenCalledOnce();
  });

  test("goes down for a row's edge", () => {
    const edge = document.createElement("div");
    const move = vi.fn();
    dragEdge(pressOn(edge), { axis: "y", move });
    expect(document.body.classList.contains("resizing-rows")).toBe(true);
    edge.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: 350 }));
    expect(move).toHaveBeenLastCalledWith(-50);
    edge.dispatchEvent(new Event("lostpointercapture"));
  });
});
