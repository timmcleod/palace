import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp, h, nextTick, reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { writeJson } from "../lib/storage.js";
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
let selected = [];
function show() {
  selected = [];
  const selectedPath = ref(null);
  const statusFiles = ref(null);
  const refreshKey = ref(0);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    render: () =>
      h(WorkingCopy, {
        path: "/repo",
        // As the window does, the file selected comes back as the one shown.
        selectedPath: selectedPath.value,
        onSelect: (file) => {
          selected.push(file?.path ?? null);
          selectedPath.value = file?.path ?? null;
        },
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
  test("stay checked when a refresh read before staging comes back while git stages", async () => {
    let staged;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "stage_files" ? new Promise((resolve) => (staged = resolve)) : Promise.resolve([]),
    );
    const { statusFiles } = show();
    statusFiles.value = [file("a.txt"), file("b.txt", "untracked")];
    await settle();
    const boxes = () => [...document.querySelectorAll(".file input[type=checkbox]")].map((box) => box.checked);
    const button = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);

    button("Stage All").click();
    await settle();
    expect(boxes()).toEqual([true, true]);
    // A refresh that read the status before staging began.
    statusFiles.value = [file("a.txt"), file("b.txt", "untracked")];
    await settle();
    expect(boxes()).toEqual([true, true]);

    // Once git's done, the refresh after it shows what it read.
    staged();
    await settle();
    statusFiles.value = [{ ...file("a.txt"), staged: "modified", unstaged: null }, file("b.txt", "untracked")];
    await settle();
    expect(boxes()).toEqual([true, false]);
  });

  test("unstaged show as git will report them, before it's done", async () => {
    vi.mocked(invoke).mockImplementation((command) => (command === "working_status" ? Promise.resolve([]) : new Promise(() => {})));
    const { statusFiles } = show();
    statusFiles.value = [
      { ...file("new-name.txt"), old_path: "old-name.txt", staged: "renamed", unstaged: null },
      { ...file("added-then-deleted.txt"), staged: "added", unstaged: "deleted" },
      { ...file("changed-then-deleted.txt"), staged: "modified", unstaged: "deleted" },
      { ...file("added.txt"), staged: "added", unstaged: null },
    ];
    await settle();
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Unstage All").click();
    await settle();
    const rows = [...document.querySelectorAll(".file .file-path")].map((row) => row.textContent.trim());
    expect(rows.sort()).toEqual(["added.txt", "changed-then-deleted.txt", "new-name.txt", "old-name.txt"]);
    expect(document.body.textContent).not.toContain("→");
  });
});

describe("in the tree, the arrow keys", () => {
  afterEach(() => writeJson("palace.workingCopyTree", false));

  test("go through folders and files, open and close folders, and go up to the one a file's in", async () => {
    writeJson("palace.workingCopyTree", true);
    const { statusFiles } = show();
    statusFiles.value = [file("src/a.js"), file("src/b.js"), file("z.txt")];
    await settle();
    const list = document.querySelector(".files");
    const press = async (key) => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      await settle();
    };
    const shown = () =>
      [...document.querySelectorAll(".file")].map((row) => (row.classList.contains("selected") ? "*" : "") + row.querySelector(".file-path").textContent.trim());
    expect(shown()).toEqual(["src", "a.js", "b.js", "z.txt"]);

    await press("ArrowDown");
    expect(shown()).toEqual(["*src", "a.js", "b.js", "z.txt"]);
    await press("ArrowLeft");
    expect(shown()).toEqual(["*src", "z.txt"]);
    await press("ArrowRight");
    expect(shown()).toEqual(["*src", "a.js", "b.js", "z.txt"]);
    await press("ArrowRight");
    expect(shown()).toEqual(["src", "*a.js", "b.js", "z.txt"]);
    expect(selected.at(-1)).toBe("src/a.js");
    await press("ArrowDown");
    expect(selected.at(-1)).toBe("src/b.js");

    // Up to the folder, which shows no file's changes, and Space stages all in it.
    await press("ArrowLeft");
    expect(shown()).toEqual(["*src", "a.js", "b.js", "z.txt"]);
    expect(selected.at(-1)).toBe(null);
    await press(" ");
    expect(vi.mocked(invoke).mock.calls.at(-1)).toEqual(["stage_files", { path: "/repo", files: ["src/a.js", "src/b.js"] }]);
  });
});

