import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp, h, nextTick, reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import WorkingCopy from "./WorkingCopy.vue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));
// settings.js sets the window's theme as it loads.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));

const file = (path, unstaged = "modified") => ({ path, staged: null, unstaged, conflicted: false });

let app;
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => (command === "working_status" ? [file("read-here.txt")] : null));
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

// Mounts the list with the changed files the window's refresh brought (`statusFiles`),
// both reactive, so a test can change them as a refresh would.
function show() {
  const statusFiles = ref(null);
  const refreshKey = ref(0);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    render: () =>
      h(WorkingCopy, {
        path: "/repo",
        draft: reactive({ subject: "", body: "", amend: false }),
        refreshKey: refreshKey.value,
        statusFiles: statusFiles.value,
      }),
  });
  app.mount(root);
  return { statusFiles, refreshKey };
}

const statusReads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "working_status").length;
const settle = async () => {
  await Promise.resolve();
  await nextTick();
};

describe("the changed files", () => {
  test("are read here only when the window's refresh didn't bring them", async () => {
    const { statusFiles, refreshKey } = show();
    await settle();
    expect(statusReads()).toBe(1);
    expect(document.body.textContent).toContain("1 changed file");

    // A refresh that brings them: nothing more's read here, and they show.
    refreshKey.value++;
    statusFiles.value = [file("a.txt"), file("b.txt", "untracked")];
    await settle();
    expect(statusReads()).toBe(1);
    expect(document.body.textContent).toContain("2 changed files");

    // One that doesn't, as when the overview was read for another view: read here again.
    statusFiles.value = null;
    refreshKey.value++;
    await settle();
    expect(statusReads()).toBe(2);
  });

  test("brought by a refresh win over a read here still under way", async () => {
    let finish;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "working_status" ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(null),
    );
    const { statusFiles } = show();
    statusFiles.value = [file("new.txt"), file("newer.txt"), file("newest.txt")];
    await settle();
    finish([file("old.txt")]);
    await settle();
    expect(document.body.textContent).toContain("3 changed files");
  });

  test("are checked at once by Stage All, and unchecked by Unstage All, before git is done", async () => {
    // Git takes its time: what it does doesn't come back during the test.
    vi.mocked(invoke).mockImplementation((command) => (command === "working_status" ? Promise.resolve([]) : new Promise(() => {})));
    const { statusFiles } = show();
    statusFiles.value = [file("a.txt"), file("b.txt", "untracked")];
    await settle();
    const boxes = () => [...document.querySelectorAll(".file input[type=checkbox]")].map((box) => box.checked);
    const button = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
    expect(boxes()).toEqual([false, false]);

    button("Stage All").click();
    await settle();
    expect(boxes()).toEqual([true, true]);
    expect(vi.mocked(invoke).mock.calls.at(-1)).toEqual(["stage_files", { path: "/repo", files: ["a.txt", "b.txt"] }]);

    // As the refresh after it would bring them, staged.
    statusFiles.value = [
      { ...file("a.txt"), staged: "modified", unstaged: null },
      { ...file("b.txt"), staged: "added", unstaged: null },
    ];
    await settle();
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    // The first operation never finished here, so the list is still busy; a new mount
    // stands in for the next time.
    app.unmount();
    const next = show();
    next.statusFiles.value = [
      { ...file("a.txt"), staged: "modified", unstaged: null },
      { ...file("b.txt"), staged: "added", unstaged: null },
    ];
    await settle();
    expect(boxes()).toEqual([true, true]);
    button("Unstage All").click();
    await settle();
    expect(boxes()).toEqual([false, false]);
  });
});
