import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import TabStrip from "./TabStrip.vue";

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

const tab = (id, name, more = {}) => ({ id, path: name && `/code/${name}`, name, branch: "main", task: null, ...more });

function render(props) {
  const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn(), onMove: vi.fn() };
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(TabStrip, { ...props, ...handlers }) });
  app.mount(root);
  // Each tab 40 pixels tall, one under another, as laid out; the page under test has
  // no layout of its own.
  root.querySelectorAll(".tab").forEach((el, i) => {
    el.getBoundingClientRect = () => ({ top: i * 40, height: 40, bottom: i * 40 + 40, left: 0, right: 180, width: 180 });
  });
  return { root, ...handlers };
}

const pointer = (type, y) => new PointerEvent(type, { button: 0, clientY: y, bubbles: true });

test("names each tab for its repository and branch, with its agent's mark, and one with none New Tab", () => {
  const { root } = render({ tabs: [tab(1, "palace"), tab(2, null, { branch: null })], active: 1, agents: { "/code/palace": "blocked" } });
  const tabs = root.querySelectorAll(".tab");
  expect(tabs[0].textContent).toContain("palace");
  expect(tabs[0].textContent).toContain("main");
  expect(tabs[0].querySelector(".dot.blocked")).not.toBeNull();
  expect(tabs[0].title).toBe("/code/palace\nIts agent needs you");
  expect(tabs[0].classList.contains("active")).toBe(true);
  expect(tabs[1].textContent).toContain("New Tab");
});

test("clicking a tab shows it, its × closes it, and + Open opens one", () => {
  const { root, onSelect, onClose, onNew } = render({ tabs: [tab(1, "a"), tab(2, "b")], active: 1 });
  root.querySelectorAll(".tab")[1].click();
  expect(onSelect).toHaveBeenCalledWith(2);
  root.querySelectorAll(".tab .close")[0].click();
  expect(onClose).toHaveBeenCalledWith(1);
  expect(onSelect).toHaveBeenCalledTimes(1);
  root.querySelector(".open").click();
  expect(onNew).toHaveBeenCalled();
});

// The tab at `y`, as the page would find it under the pointer.
const tabAt = (root, y) => root.querySelectorAll(".tab")[Math.floor(y / 40)] ?? null;

test("a tab dragged shows where it would land, as a branch does, and moves there as it's dropped", async () => {
  const { root, onMove, onSelect } = render({ tabs: [tab(1, "a"), tab(2, "b"), tab(3, "c")], active: 1 });
  document.elementFromPoint = (_, y) => tabAt(root, y);
  const [first, , last] = root.querySelectorAll(".tab");
  first.dispatchEvent(pointer("pointerdown", 20));
  // Not yet a drag: a click's wobble.
  window.dispatchEvent(pointer("pointermove", 22));
  await nextTick();
  expect(document.querySelector(".drag-image")).toBeNull();

  // Over the lower half of c: it'd land after it, and doesn't move until it's dropped.
  window.dispatchEvent(pointer("pointermove", 110));
  await nextTick();
  expect(document.querySelector(".drag-image.following").textContent).toBe("a");
  expect(first.classList.contains("dragging")).toBe(true);
  expect(last.classList.contains("drop-after")).toBe(true);
  expect(onMove).not.toHaveBeenCalled();

  // Over itself, it'd stay: no line.
  window.dispatchEvent(pointer("pointermove", 10));
  await nextTick();
  expect(root.querySelector(".drop-before, .drop-after")).toBeNull();

  window.dispatchEvent(pointer("pointermove", 110));
  window.dispatchEvent(pointer("pointerup", 110));
  first.click();
  expect(onMove).toHaveBeenCalledWith(1, 2);
  expect(onSelect).not.toHaveBeenCalled();
  expect(document.querySelector(".drag-image")).toBeNull();
});

test("Escape, or dropping it off the tabs, leaves a dragged tab where it was", async () => {
  const { root, onMove } = render({ tabs: [tab(1, "a"), tab(2, "b")], active: 1 });
  document.elementFromPoint = (_, y) => tabAt(root, y);
  const first = root.querySelector(".tab");
  first.dispatchEvent(pointer("pointerdown", 20));
  window.dispatchEvent(pointer("pointermove", 70));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  window.dispatchEvent(pointer("pointerup", 70));
  first.dispatchEvent(pointer("pointerdown", 20));
  window.dispatchEvent(pointer("pointermove", 70));
  window.dispatchEvent(pointer("pointermove", 500));
  window.dispatchEvent(pointer("pointerup", 500));
  expect(onMove).not.toHaveBeenCalled();
});
