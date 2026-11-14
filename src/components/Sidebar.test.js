import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { commitPointer, draggedCommits, dropCommits } from "../lib/commitDrag.js";
import Sidebar from "./Sidebar.vue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));

// A repository with main checked out, and a feature branch.
const overview = (more = {}) => ({
  path: "/repo",
  name: "repo",
  head: { branch: "main" },
  changes: 0,
  branches: [
    { name: "feature", is_head: false, ahead: 0, behind: 0, upstream: null, worktree: null, tip: "f1" },
    { name: "main", is_head: true, ahead: 0, behind: 0, upstream: null, worktree: null, tip: "m1" },
  ],
  tags: [],
  remotes: [],
  stashes: [],
  submodules: [],
  worktrees: [],
  operation: null,
  ...more,
});

let app;
afterEach(() => {
  app?.unmount();
  draggedCommits.value = null;
  commitPointer.value = null;
  document.body.innerHTML = "";
});

function sidebar(more) {
  const onCherryPick = vi.fn();
  const onMergeIntoHead = vi.fn();
  const shown = ref(overview(more));
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(Sidebar, { overview: shown.value, onCherryPick, onMergeIntoHead }) });
  app.mount(root);
  return { onCherryPick, onMergeIntoHead };
}

const row = (key) => document.querySelector(`[data-row="${key}"]`);
const commit = { id: "abc1234def", short_id: "abc1234", summary: "Fix the login redirect" };

// Commits dragged from the history, the pointer over the row `key`, or over nothing.
async function dragCommitsOver(commits, key) {
  draggedCommits.value = commits;
  document.elementFromPoint = () => (key ? row(key) : null);
  commitPointer.value = { x: 40, y: 14 };
  await nextTick();
}

describe("a commit dragged from another branch's history", () => {
  test("drops on the current branch, said and shown, and is cherry-picked there", async () => {
    const { onCherryPick } = sidebar();
    await dragCommitsOver([commit], "branch:main");
    expect(row("branch:main").classList.contains("drop-target")).toBe(true);
    expect(row("branch:main").textContent).toContain("Cherry-pick Fix the login redirect into main");
    expect(dropCommits()).toBe(true);
    await nextTick();
    expect(onCherryPick).toHaveBeenCalledWith([commit]);
    expect(row("branch:main").classList.contains("drop-target")).toBe(false);
  });

  test("says so above the branch's row, clear of the commit's copy below the pointer, unless there's no room there", async () => {
    sidebar();
    const list = document.querySelector(".sidebar-scroll");
    list.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 240 });
    const at = (top) => (row("branch:main").getBoundingClientRect = () => ({ top, bottom: top + 28, left: 0, right: 240 }));
    at(200);
    await dragCommitsOver([commit], "branch:main");
    await nextTick();
    const sentence = () => row("branch:main").querySelector(".drop-sentence");
    expect(sentence().classList.contains("above")).toBe(true);
    // Scrolled to the very top of the sidebar, below it after all.
    at(0);
    list.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(sentence().classList.contains("above")).toBe(false);
  });

  test("several, oldest first, drop together, said as how many", async () => {
    const { onCherryPick } = sidebar();
    const older = { id: "0000001aaa", short_id: "0000001", summary: "Add the login form" };
    await dragCommitsOver([older, commit], "branch:main");
    expect(row("branch:main").textContent).toContain("Cherry-pick 2 commits into main");
    dropCommits();
    expect(onCherryPick).toHaveBeenCalledWith([older, commit]);
  });

  test("doesn't drop on another branch, or nowhere", async () => {
    const { onCherryPick } = sidebar();
    await dragCommitsOver([commit], "branch:feature");
    expect(row("branch:feature").classList.contains("drop-target")).toBe(false);
    expect(dropCommits()).toBe(false);
    await dragCommitsOver([commit], null);
    expect(dropCommits()).toBe(false);
    expect(onCherryPick).not.toHaveBeenCalled();
  });

  test("doesn't drop while a merge or rebase waits on the user", async () => {
    const { onCherryPick } = sidebar({ operation: "rebase" });
    await dragCommitsOver([commit], "branch:main");
    expect(row("branch:main").classList.contains("drop-target")).toBe(false);
    dropCommits();
    expect(onCherryPick).not.toHaveBeenCalled();
  });

  test("lets go of the row once the drag ends elsewhere", async () => {
    sidebar();
    await dragCommitsOver([commit], "branch:main");
    draggedCommits.value = null;
    commitPointer.value = null;
    await nextTick();
    expect(row("branch:main").classList.contains("drop-target")).toBe(false);
  });

  test("near the sidebar's bottom, scrolls it, to reach the current branch out of sight", async () => {
    sidebar();
    const frames = [];
    vi.stubGlobal("requestAnimationFrame", (run) => frames.push(run));
    const list = document.querySelector(".sidebar-scroll");
    list.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 240, height: 600, width: 240 });
    let top = 0;
    Object.defineProperty(list, "scrollTop", {
      get: () => top,
      set: (value) => {
        top = value;
      },
      configurable: true,
    });
    draggedCommits.value = [commit];
    document.elementFromPoint = () => null;
    commitPointer.value = { x: 40, y: 595 };
    await nextTick();
    frames.shift()();
    expect(top).toBeGreaterThan(0);
    // Beside it, over the history, it doesn't.
    const was = top;
    commitPointer.value = { x: 400, y: 595 };
    await nextTick();
    frames.shift()?.();
    expect(top).toBe(was);
    vi.unstubAllGlobals();
  });

  test("isn't taken by a sidebar the pointer isn't over, as a hidden tab's", async () => {
    const { onCherryPick } = sidebar();
    // Over a row of the same branch, elsewhere on the page.
    const elsewhere = document.createElement("div");
    elsewhere.dataset.row = "branch:main";
    document.body.append(elsewhere);
    draggedCommits.value = [commit];
    document.elementFromPoint = () => elsewhere;
    commitPointer.value = { x: 900, y: 14 };
    await nextTick();
    expect(dropCommits()).toBe(false);
    expect(onCherryPick).not.toHaveBeenCalled();
  });
});

describe("a branch dragged by the pointer", () => {
  // Each row 28 pixels tall, one under another, as laid out: the page under test has no
  // layout of its own.
  const ROW = 28;
  const rows = () => [...document.querySelectorAll("[data-row]")];
  function layOut() {
    rows().forEach((el, i) => {
      el.getBoundingClientRect = () => ({ top: i * ROW, height: ROW, bottom: (i + 1) * ROW, left: 0, right: 240, width: 240 });
    });
    document.querySelector(".sidebar-scroll").getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 240, height: 600, width: 240 });
    document.elementFromPoint = (_, y) => rows()[Math.floor(y / ROW)] ?? null;
  }
  const at = (key) => rows().indexOf(row(key)) * ROW;
  const pointer = (type, y) => new PointerEvent(type, { button: 0, clientX: 40, clientY: y, bubbles: true, cancelable: true });
  const branchOrder = () => rows().map((el) => el.dataset.row).filter((key) => key.startsWith("branch:"));

  async function drag(key, toY, { release = true } = {}) {
    layOut();
    row(key).dispatchEvent(pointer("pointerdown", at(key) + 14));
    window.dispatchEvent(pointer("pointermove", at(key) + 30));
    window.dispatchEvent(pointer("pointermove", toY));
    await nextTick();
    if (release) window.dispatchEvent(pointer("pointerup", toY));
    await nextTick();
  }

  test("shows a copy of its row following the pointer, and onto the middle of HEAD's row, merges it there", async () => {
    const { onMergeIntoHead } = sidebar();
    layOut();
    await drag("branch:feature", at("branch:main") + 14, { release: false });
    // A copy of its row, as it looks in the list.
    const image = document.querySelector(".following");
    expect(image.classList.contains("row")).toBe(true);
    expect(image.querySelector(".row-label").textContent).toBe("feature");
    expect(image.hasAttribute("inert")).toBe(true);
    // Faded where it was; its copy isn't.
    expect(row("branch:feature").classList.contains("dragging")).toBe(true);
    expect(image.classList.contains("dragging")).toBe(false);
    window.dispatchEvent(pointer("pointerup", at("branch:main") + 14));
    expect(onMergeIntoHead).toHaveBeenCalledWith("feature");
    expect(document.querySelector(".following")).toBeNull();
  });

  test("onto the edge of another branch's row, moves it there", async () => {
    const { onMergeIntoHead } = sidebar();
    layOut();
    const before = branchOrder();
    const [first, second] = before;
    // Below the second's middle, past where it would merge.
    await drag(first, at(second) + 26);
    expect(onMergeIntoHead).not.toHaveBeenCalled();
    expect(branchOrder()).toEqual([second, first]);
  });

  test("where it would be moved, a gap opens, by the row it'd go before or after", async () => {
    sidebar();
    // At the top edge of HEAD's row, where it doesn't merge: before it.
    await drag("branch:feature", at("branch:main") + 3, { release: false });
    expect(row("branch:main").classList.contains("drop-before")).toBe(true);
    expect(row("branch:main").classList.contains("drop-target")).toBe(false);
    // Just below its own row, where it is: no gap.
    window.dispatchEvent(pointer("pointermove", at("branch:feature") + 20));
    await nextTick();
    expect(document.querySelector(".row.drop-before, .row.drop-after")).toBeNull();
    // Well below the branches, nowhere.
    window.dispatchEvent(pointer("pointermove", at("branch:main") + 200));
    await nextTick();
    expect(document.querySelector(".row.drop-before, .row.drop-after")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  });

  test("let go, the row moved slides into its place from where it was let go", async () => {
    sidebar();
    layOut();
    for (const el of rows()) el.animate = vi.fn();
    const moved = row("branch:main");
    const was = at("branch:main");
    await drag("branch:main", at("branch:feature") + 24, { release: false });
    document.querySelector(".following").getBoundingClientRect = () => ({ top: 300, left: 40 });
    window.dispatchEvent(pointer("pointerup", at("branch:feature") + 24));
    await nextTick();
    await nextTick();
    // Laid out here as it was, it's put nowhere else: only that it slides from there.
    expect(moved.animate.mock.calls[0][0]).toEqual([{ transform: `translate(0px, ${300 - was}px)` }, { transform: "none" }]);
  });

  test("a click on a row isn't measured as a drag would be", async () => {
    sidebar();
    layOut();
    const measured = vi.spyOn(row("branch:main"), "getBoundingClientRect");
    row("branch:main").dispatchEvent(pointer("pointerdown", at("branch:main") + 14));
    window.dispatchEvent(pointer("pointerup", at("branch:main") + 14));
    await nextTick();
    expect(measured).not.toHaveBeenCalled();
  });

  test("Escape leaves it where it was, and its release isn't a drop", async () => {
    const { onMergeIntoHead } = sidebar();
    layOut();
    const before = branchOrder();
    await drag("branch:feature", at("branch:main") + 14, { release: false });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    window.dispatchEvent(pointer("pointerup", at("branch:main") + 14));
    await nextTick();
    expect(onMergeIntoHead).not.toHaveBeenCalled();
    expect(branchOrder()).toEqual(before);
    expect(document.querySelector(".following")).toBeNull();
  });
});
