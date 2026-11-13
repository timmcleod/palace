import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { dropPlace, landingAt, useTabRowDrag } from "./tabRowDrag.js";

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

test("a dragged tab lands at the place between tabs nearest the pointer, or at an end", () => {
  // Three tabs 200 wide, 6 apart: the places are at 0, 203, 409 and 612.
  const spans = [
    { key: "a", left: 0, right: 200 },
    { key: "b", left: 206, right: 406 },
    { key: "c", left: 412, right: 612 },
  ];
  expect(landingAt(spans, -40)).toEqual({ key: "a", after: false });
  expect(landingAt(spans, 90)).toEqual({ key: "a", after: false });
  expect(landingAt(spans, 110)).toEqual({ key: "b", after: false });
  // Between two tabs, as in the gap that opens there.
  expect(landingAt(spans, 230)).toEqual({ key: "b", after: false });
  expect(landingAt(spans, 520)).toEqual({ key: "c", after: true });
  expect(landingAt(spans, 900)).toEqual({ key: "c", after: true });
  expect(landingAt([], 10)).toBeNull();
});

test("a tab dropped before or after another goes there, or stays where it is", () => {
  const keys = ["a", "b", "c"];
  expect(dropPlace(keys, "a", { key: "c", after: true })).toBe(2);
  expect(dropPlace(keys, "a", { key: "c", after: false })).toBe(1);
  expect(dropPlace(keys, "c", { key: "a", after: false })).toBe(0);
  // Just before or after itself, it stays: no line's drawn there.
  expect(dropPlace(keys, "a", { key: "b", after: false })).toBeNull();
  expect(dropPlace(keys, "b", { key: "a", after: true })).toBeNull();
  expect(dropPlace(keys, "a", { key: "a", after: true })).toBeNull();
  expect(dropPlace(keys, "a", { key: "z", after: true })).toBeNull();
});

const pointer = (type, x, y = 20) => new PointerEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });

// A row of tabs 100 wide, keyed as a terminal panel's are, which records where a tab's
// put and puts it there, and the drag along it.
function render(keys) {
  const tabs = ref(keys);
  const move = vi.fn((key, to) => {
    const list = tabs.value.filter((other) => other !== key);
    list.splice(to, 0, key);
    tabs.value = list;
  });
  let drag;
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    setup() {
      const row = ref(null);
      const list = ref(null);
      drag = useTabRowDrag({ row, list, keys: () => tabs.value, move });
      return () =>
        h("div", { ref: row, class: "row" }, [
          h(
            "div",
            { ref: list, class: "list" },
            tabs.value.map((key) => h("div", { key, class: ["tab", drag.classOf(key)], "data-key": key, onPointerdown: (event) => drag.press(event, key) }, key)),
          ),
        ]);
    },
  });
  app.mount(root);
  root.querySelectorAll(".tab").forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: i * 100, right: i * 100 + 100, top: 0, bottom: 30 });
  });
  root.querySelector(".row").getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 30 });
  root.querySelector(".list").getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 30 });
  return { root, tabs, move, drag };
}

test("dragged along the row, the tab's faded, the gap's where it'd land, and dropped, it's put there", async () => {
  const { root, tabs, move, drag } = render(["k1", "k2", "k3"]);
  const tab = (key) => root.querySelector(`[data-key="${key}"]`);
  tab("k1").dispatchEvent(pointer("pointerdown", 50));
  window.dispatchEvent(pointer("pointermove", 210));
  await nextTick();
  expect(drag.dragging.value).toBe("k1");
  expect(tab("k1").classList.contains("dragging")).toBe(true);
  expect(tab("k3").classList.contains("drop-before")).toBe(true);
  window.dispatchEvent(pointer("pointerup", 210));
  await nextTick();
  expect(move).toHaveBeenCalledWith("k1", 1);
  expect(tabs.value).toEqual(["k2", "k1", "k3"]);
  expect(root.querySelector(".dragging, .drop-before, .drop-after")).toBeNull();
});

test("let go well away from the row, or over where it was, it isn't moved", async () => {
  const { root, move } = render(["k1", "k2"]);
  root.querySelector('[data-key="k1"]').dispatchEvent(pointer("pointerdown", 50));
  window.dispatchEvent(pointer("pointermove", 150, 200));
  window.dispatchEvent(pointer("pointerup", 150, 200));
  root.querySelector('[data-key="k1"]').dispatchEvent(pointer("pointerdown", 50));
  window.dispatchEvent(pointer("pointermove", 60));
  window.dispatchEvent(pointer("pointermove", 20));
  window.dispatchEvent(pointer("pointerup", 20));
  expect(move).not.toHaveBeenCalled();
});
