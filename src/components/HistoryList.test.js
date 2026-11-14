import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import HistoryList from "./HistoryList.vue";
import { draggedCommits, takeDroppedCommits } from "../lib/commitDrag.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// Avatars listen for pictures fetched in the background.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
// settings.js sets the window's theme as it loads.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));

// Four commits, newest first, in one month, on one line: its heading 0–34 down the list,
// then each commit's row 52 high, commit 0 at 34–86, 1 at 86–138, 2 at 138–190, 3 at
// 190–242.
const TIME = 1_793_314_199;
const commits = [0, 1, 2, 3].map((i) => ({
  id: `c${i}`.padEnd(40, "0"),
  short_id: `c${i}`,
  summary: `Commit ${i}`,
  author_name: "Ada",
  author_email: "ada@example.com",
  time: TIME - i * 60,
  // The oldest tagged, to point at its badges.
  refs: i === 3 ? [{ kind: "tag", name: "v1.0" }] : [],
  graph: { lane: 0, pass: [], merge_in: i ? [0] : [], out: i < 3 ? [0] : [] },
  incoming: false,
}));
const topOf = (index) => 34 + index * 52;

// The history as the backend has it, newest first: the commits above, unless a test
// adds one.
let history;
beforeEach(() => {
  history = commits;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "load_history") return { generation, total: history.length, times: history.map((c) => c.time) };
    if (command === "history_page") return history;
    if (command === "history_position") return history.findIndex((c) => c.id === args.id);
    return null;
  });
});

let app;
afterEach(() => {
  app?.unmount();
  draggedCommits.value = null;
  document.body.innerHTML = "";
});

// Its history read again as the refresh key goes up (see load_history above).
const refreshKey = ref(0);
let generation;
beforeEach(() => {
  refreshKey.value = 0;
  generation = 1;
});

async function mount(props) {
  const root = document.createElement("div");
  document.body.append(root);
  const onMove = vi.fn();
  app = createApp({ render: () => h(HistoryList, { path: "/repo", onMove, refreshKey: refreshKey.value, ...props }) });
  app.mount(root);
  await vi.waitFor(() => expect(document.querySelectorAll(".commit .summary")).toHaveLength(4));
  // Laid out as on the page: the list from the window's top, 400 wide.
  document.querySelector(".viewport").getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 400, width: 400, height: 600 });
  for (const [i, row] of rowsByCommit().entries()) row.getBoundingClientRect = () => ({ top: topOf(i), bottom: topOf(i) + 52, left: 8, right: 392, width: 384, height: 52 });
  return { onMove };
}
const rowsByCommit = () => [...document.querySelectorAll(".spacer > .commit")].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
const rowOf = (index) => [...document.querySelectorAll(".spacer > .commit")].find((row) => row.querySelector(".summary")?.textContent === `Commit ${index}`);
const pointer = (type, y) => new PointerEvent(type, { button: 0, clientX: 100, clientY: y, bubbles: true, cancelable: true });

// Presses commit `index`'s row, and drags it to `y` down the page.
async function drag(index, y) {
  rowOf(index).dispatchEvent(pointer("pointerdown", topOf(index) + 20));
  window.dispatchEvent(pointer("pointermove", topOf(index) + 40));
  window.dispatchEvent(pointer("pointermove", y));
  await nextTick();
}

test("a commit dragged to move it is shown as its row, and a gap opens where it would go", async () => {
  const { onMove } = await mount({ editable: true });
  // Over the top half of commit 3's row: above it.
  await drag(0, topOf(3) + 10);
  const copy = document.querySelector(".following");
  expect(copy.classList.contains("commit")).toBe(true);
  expect(copy.querySelector(".summary").textContent).toBe("Commit 0");
  expect(rowOf(0).classList.contains("dragging")).toBe(true);
  // The gap, before commit 3, which moves down to make room; those above it don't.
  expect(document.querySelector(".drop-gap").style.top).toBe(`${topOf(3)}px`);
  expect(rowOf(3).style.top).toBe(`${topOf(3) + 20}px`);
  expect(rowOf(2).style.top).toBe(`${topOf(2)}px`);

  window.dispatchEvent(pointer("pointerup", topOf(3) + 10));
  await nextTick();
  expect(onMove).toHaveBeenCalledWith([{ commit: expect.objectContaining({ id: commits[0].id }), index: 0 }], { commit: expect.objectContaining({ id: commits[3].id }), index: 3 }, "above");
  expect(document.querySelector(".drop-gap")).toBeNull();
  expect(document.querySelector(".following")).toBeNull();
});

test("several chosen move together, pressed on one of them, all faded where they were", async () => {
  const { onMove } = await mount({ editable: true });
  rowOf(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  rowOf(2).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true }));
  await nextTick();
  // Pressed on the older, dropped below commit 3.
  await drag(2, topOf(3) + 40);
  expect(document.querySelector(".following .drag-count")?.textContent).toBe("2");
  // A stack of them: one behind it.
  expect(document.querySelector(".following").classList.contains("stack-2")).toBe(true);
  expect([0, 1, 2].map((i) => rowOf(i).classList.contains("dragging"))).toEqual([true, false, true]);
  window.dispatchEvent(pointer("pointerup", topOf(3) + 40));
  expect(onMove).toHaveBeenCalledWith(
    [expect.objectContaining({ index: 0 }), expect.objectContaining({ index: 2 })],
    expect.objectContaining({ index: 3 }),
    "below",
  );
});

test("a Cmd- or Shift-click that wobbles chooses, rather than drags", async () => {
  await mount({ editable: true });
  for (const keys of [{ metaKey: true, ctrlKey: true }, { shiftKey: true }]) {
    rowOf(1).dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: topOf(1) + 20, bubbles: true, ...keys }));
    window.dispatchEvent(pointer("pointermove", topOf(1) + 40));
    expect(document.querySelector(".following")).toBeNull();
    window.dispatchEvent(pointer("pointerup", topOf(1) + 40));
  }
});

test("a commit's branches and tags aren't shown as a drag goes over them", async () => {
  await mount({ editable: true });
  await drag(0, topOf(3) + 10);
  document.querySelector(".ref-marks .names, .ref-marks .badges").dispatchEvent(new MouseEvent("mouseenter"));
  await nextTick();
  expect(document.querySelector(".refs-card")).toBeNull();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
});

test("commits chosen stay chosen where they are now, once the history's changed above them", async () => {
  const { onMove } = await mount({ editable: true });
  rowOf(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  rowOf(2).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true }));
  // A commit made in a terminal: each of them is one further down.
  const made = { ...commits[0], id: "new".padEnd(40, "0"), summary: "Commit new", time: TIME + 60, refs: [] };
  history = [made, ...commits];
  generation = 2;
  refreshKey.value++;
  await vi.waitFor(() => expect(document.querySelectorAll(".commit .summary")).toHaveLength(5));
  // Each looked for where it is now.
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("history_position", expect.objectContaining({ generation: 2, id: commits[2].id })));
  await new Promise((resolve) => setTimeout(resolve));
  // Commit 2, now fourth, dragged below commit 3, now last.
  rowOf(2).dispatchEvent(pointer("pointerdown", topOf(3) + 20));
  window.dispatchEvent(pointer("pointermove", topOf(3) + 40));
  window.dispatchEvent(pointer("pointermove", topOf(4) + 40));
  await nextTick();
  window.dispatchEvent(pointer("pointerup", topOf(4) + 40));
  expect(onMove).toHaveBeenCalledWith([expect.objectContaining({ index: 1 }), expect.objectContaining({ index: 3 })], expect.objectContaining({ index: 4 }), "below");
});

test("no gap opens where it would stay where it is, and let go there, nothing moves", async () => {
  const { onMove } = await mount({ editable: true });
  await drag(1, topOf(2) + 10);
  expect(document.querySelector(".drop-gap")).toBeNull();
  window.dispatchEvent(pointer("pointerup", topOf(2) + 10));
  expect(onMove).not.toHaveBeenCalled();
});

test("several chosen to cherry-pick, the copy says how many", async () => {
  await mount({ pickable: true });
  rowOf(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  rowOf(2).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true }));
  await nextTick();
  await drag(1, 300);
  expect(document.querySelector(".following .drag-count")?.textContent).toBe("2");
  expect(document.querySelector(".following").classList.contains("stack-3")).toBe(false);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
});

test("a commit being moved is let go of if the history changes under it", async () => {
  const { onMove } = await mount({ editable: true });
  await drag(0, topOf(3) + 10);
  expect(document.querySelector(".drop-gap")).not.toBeNull();
  generation = 2;
  refreshKey.value++;
  await vi.waitFor(() => expect(document.querySelector(".following")).toBeNull());
  expect(document.querySelector(".drop-gap")).toBeNull();
  window.dispatchEvent(pointer("pointerup", topOf(3) + 10));
  expect(onMove).not.toHaveBeenCalled();
});

test("away from the list, the copy's a compact card held by its middle, and back over it, the row again", async () => {
  await mount({ pickable: true });
  await drag(1, 300);
  const copy = document.querySelector(".following");
  const width = copy.style.width;
  // Out over the sidebar, beside the list.
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: -100, clientY: 300, bubbles: true }));
  expect(copy.classList.contains("compact")).toBe(true);
  expect([copy.style.width, copy.style.height]).toEqual(["240px", "34px"]);
  // Centered on the pointer, but for the window's left edge, which it stays inside.
  expect(copy.style.getPropertyValue("translate")).toBe("0px 283px");
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 500, clientY: 300, bubbles: true }));
  expect(copy.style.getPropertyValue("translate")).toBe("380px 283px");
  window.dispatchEvent(pointer("pointermove", 300));
  expect(copy.classList.contains("compact")).toBe(false);
  expect([copy.style.width, copy.style.height]).toEqual([width, "52px"]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
});

test("a commit dragged to cherry-pick is let go of to whatever takes it there", async () => {
  await mount({ pickable: true });
  const take = vi.fn(() => true);
  const stop = takeDroppedCommits(take);
  await drag(1, 300);
  expect(draggedCommits.value.map((c) => c.id)).toEqual([commits[1].id]);
  expect(document.querySelector(".drop-gap")).toBeNull();
  window.dispatchEvent(pointer("pointerup", 300));
  stop();
  expect(take).toHaveBeenCalledWith([expect.objectContaining({ id: commits[1].id })]);
  expect(draggedCommits.value).toBeNull();
});
