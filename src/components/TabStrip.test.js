import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
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
  // Each tab 200 pixels wide, side by side, in a row as wide as they are, as laid out;
  // the page under test has no layout of its own.
  const tabs = root.querySelectorAll(".tab");
  tabs.forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: i * 200, width: 200, right: i * 200 + 200, top: 0, bottom: 40, height: 40 });
  });
  const row = root.querySelector(".tabs");
  row.getBoundingClientRect = () => ({ left: 0, width: tabs.length * 200, right: tabs.length * 200, top: 0, bottom: 40, height: 40 });
  // Across a window 1000 wide, 48 high.
  root.querySelector(".tab-strip").getBoundingClientRect = () => ({ left: 0, width: 1000, right: 1000, top: 0, bottom: 48, height: 48 });
  return { root, ...handlers };
}

const pointer = (type, x, y = 20) => new PointerEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });

test("names each tab for its repository, its branch and what its agent's doing below, and one with none New Tab", () => {
  const palace = tab(1, "palace", { ahead: 2, behind: 1, changes: 3 });
  const { root } = render({ tabs: [palace, tab(2, null, { branch: null })], active: 1, agents: { "/code/palace": "blocked" } });
  const tabs = root.querySelectorAll(".tab");
  expect(tabs[0].querySelector(".name").textContent).toBe("palace");
  const parts = [...tabs[0].querySelectorAll(".detail > span")].map((part) => [part.className, part.textContent]);
  expect(parts).toEqual([
    ["branch", "main"],
    ["attention", "needs you"],
    ["sync", "↑2 ↓1"],
    ["changes", "3 changed"],
  ]);
  expect(tabs[0].querySelector(".tile.blocked .badge")).not.toBeNull();
  expect(tabs[0].title).toBe("/code/palace\nIts agent needs you");
  expect(tabs[0].classList.contains("active")).toBe(true);
  expect(tabs[1].textContent).toContain("New Tab");
  expect(tabs[1].querySelector(".detail, .tile")).toBeNull();
});

test("each tab is known by a tile in its repository's color, a worktree's the same as its repository's", () => {
  const worktree = tab(2, "palace-tabs", { home: "/code/palace", worktree: true });
  const { root } = render({ tabs: [tab(1, "palace", { home: "/code/palace" }), worktree, tab(3, "api", { home: "/code/api" })], active: 1, agents: { "/code/palace": "working" } });
  const [palace, tabs, api] = root.querySelectorAll(".tab");
  expect(palace.querySelector(".tile").textContent.trim()).toBe("P");
  expect(palace.querySelector(".tile.working > .spinning .spinner")).not.toBeNull();
  expect(palace.style.getPropertyValue("--tab-color")).toMatch(/^var\(--graph-[1-6]\)$/);
  // The worktree, with the branch mark rather than an initial, in its repository's color.
  expect(tabs.querySelector(".tile svg")).not.toBeNull();
  expect(tabs.querySelector(".tile").textContent.trim()).toBe("");
  expect(tabs.style.getPropertyValue("--tab-color")).toBe(palace.style.getPropertyValue("--tab-color"));
  expect(api.querySelector(".tile").textContent.trim()).toBe("A");
});

test("of two tabs named alike, the folder each is in is shown before its name, fainter", () => {
  const { root } = render({ tabs: [tab(1, "palace", { path: "/work/palace" }), tab(2, "palace", { path: "/oss/palace" })], active: 1 });
  const names = [...root.querySelectorAll(".name")];
  expect(names.map((name) => name.textContent)).toEqual(["work/palace", "oss/palace"]);
  expect(names[1].querySelector(".parent").textContent).toBe("oss/");
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

test("a tab dragged shows where it would land, in a gap there, and moves there as it's dropped", async () => {
  const { root, onMove, onSelect } = render({ tabs: [tab(1, "a"), tab(2, "b"), tab(3, "c")], active: 1 });
  const [first, middle, last] = root.querySelectorAll(".tab");
  // Grabbed 60 pixels into it.
  middle.dispatchEvent(pointer("pointerdown", 260));
  // Not yet a drag: a click's wobble.
  window.dispatchEvent(pointer("pointermove", 262));
  await nextTick();
  expect(document.querySelector(".following")).toBeNull();

  // Over the right half of c: it'd land after it, and doesn't move until it's dropped.
  window.dispatchEvent(pointer("pointermove", 550));
  await nextTick();
  // A copy of the tab, as it looks in the row, held where it was grabbed.
  const image = document.querySelector(".following");
  expect(image.classList.contains("tab")).toBe(true);
  expect(image.classList.contains("active")).toBe(false);
  expect(image.querySelector(".name").textContent).toBe("b");
  expect(image.querySelector(".detail").textContent).toBe("main");
  expect(image.style.width).toBe("200px");
  expect(image.style.getPropertyValue("translate")).toBe("490px 0px");
  expect(image.hasAttribute("inert")).toBe(true);
  expect(middle.classList.contains("dragging")).toBe(true);
  expect(last.classList.contains("drop-after")).toBe(true);
  expect(onMove).not.toHaveBeenCalled();

  // Over itself, it'd stay: no line.
  window.dispatchEvent(pointer("pointermove", 300));
  await nextTick();
  expect(root.querySelector(".drop-before, .drop-after")).toBeNull();

  // Over the left half of a: before it.
  window.dispatchEvent(pointer("pointermove", 50));
  await nextTick();
  expect(first.classList.contains("drop-before")).toBe(true);

  // Where the tabs were as it started, not where the gap's moved them: the row
  // scrolled, though, is taken into account.
  root.querySelector(".tabs").scrollLeft = 200;
  window.dispatchEvent(pointer("pointermove", 50));
  await nextTick();
  expect(root.querySelector(".drop-before, .drop-after")).toBeNull();
  root.querySelector(".tabs").scrollLeft = 0;

  window.dispatchEvent(pointer("pointermove", 550));
  window.dispatchEvent(pointer("pointerup", 550));
  middle.click();
  expect(onMove).toHaveBeenCalledWith(2, 2);
  expect(onSelect).not.toHaveBeenCalled();
  expect(document.querySelector(".following")).toBeNull();
});

test("let go near the row, below it or past its last tab, it lands there too", async () => {
  const { root, onMove } = render({ tabs: [tab(1, "a"), tab(2, "b"), tab(3, "c")], active: 1 });
  const [first, , last] = root.querySelectorAll(".tab");
  first.dispatchEvent(pointer("pointerdown", 100));
  // Below the row, by less than a tab's height, past the last tab.
  window.dispatchEvent(pointer("pointermove", 900, 80));
  await nextTick();
  expect(last.classList.contains("drop-after")).toBe(true);
  // Further below, nowhere.
  window.dispatchEvent(pointer("pointermove", 900, 100));
  await nextTick();
  expect(root.querySelector(".drop-before, .drop-after")).toBeNull();
  window.dispatchEvent(pointer("pointermove", 900, 80));
  window.dispatchEvent(pointer("pointerup", 900, 80));
  expect(onMove).toHaveBeenCalledWith(1, 2);
});

test("dropped, the tab slides into its place from where its copy was let go", async () => {
  const { root } = render({ tabs: [tab(1, "a"), tab(2, "b"), tab(3, "c")], active: 1 });
  const tabs = [...root.querySelectorAll(".tab")];
  for (const element of tabs) element.animate = vi.fn();
  tabs[0].dispatchEvent(pointer("pointerdown", 100));
  window.dispatchEvent(pointer("pointermove", 550));
  // Its copy, 200 by 40, turned a little: drawn 4 past its box at each side, and 5 above
  // and below. It slides from its box, where the copy was.
  const copy = document.querySelector(".following");
  Object.defineProperties(copy, { offsetWidth: { value: 200 }, offsetHeight: { value: 40 } });
  copy.getBoundingClientRect = () => ({ left: 446, top: 25, width: 208, height: 50 });
  window.dispatchEvent(pointer("pointerup", 550));
  await nextTick();
  // Not put in its new place here, as the window's tabs are App's: none moved but it.
  expect(tabs[0].animate.mock.calls[0][0]).toEqual([{ transform: "translate(450px, 30px)" }, { transform: "none" }]);
  expect(tabs[1].animate).not.toHaveBeenCalled();
  expect(tabs[2].animate).not.toHaveBeenCalled();
});

test("Escape, or dropping it well away from the row, leaves a dragged tab where it was", async () => {
  const { root, onMove } = render({ tabs: [tab(1, "a"), tab(2, "b")], active: 1 });
  const first = root.querySelector(".tab");
  first.dispatchEvent(pointer("pointerdown", 100));
  window.dispatchEvent(pointer("pointermove", 350));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  window.dispatchEvent(pointer("pointerup", 350));
  first.dispatchEvent(pointer("pointerdown", 100));
  window.dispatchEvent(pointer("pointermove", 350));
  window.dispatchEvent(pointer("pointermove", 350, 200));
  window.dispatchEvent(pointer("pointerup", 350, 200));
  expect(onMove).not.toHaveBeenCalled();
});

test("a mouse wheel scrolls the row, and the tab that comes to show is scrolled into it", async () => {
  const shown = vi.fn();
  Element.prototype.scrollIntoView = shown;
  const tabs = [tab(1, "a"), tab(2, "b"), tab(3, "c")];
  const active = ref(1);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(TabStrip, { tabs, active: active.value }) });
  app.mount(root);
  const row = root.querySelector(".tabs");
  row.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));
  expect(row.scrollLeft).toBe(120);
  active.value = 3;
  await nextTick();
  await nextTick();
  expect(shown).toHaveBeenCalled();
  expect(shown.mock.contexts.at(-1).dataset.key).toBe("3");
  delete Element.prototype.scrollIntoView;
});
