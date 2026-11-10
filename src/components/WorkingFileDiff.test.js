import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import WorkingFileDiff from "./WorkingFileDiff.vue";
import { settings } from "../lib/settings.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// storage.js listens for Palace's other windows as it loads.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));
// settings.js sets the window's theme as it loads.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));

// Highlighting runs in a Web Worker, which the tests don't have; the diff shows plain.
settings.syntaxHighlighting = false;

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  vi.mocked(invoke).mockReset();
});

const line = (kind, old, next, text) => ({ kind, old, new: next, text });
// A diff as working_diff gives one, made afresh each time, as the backend's are.
const diff = () => ({
  binary: false,
  total_lines: 2,
  truncated: false,
  hunks: [{ header: "@@ -1 +1 @@", lines: [line("-", 1, null, "old"), line("+", null, 1, "new")] }],
  images: null,
});
const changed = (file) => ({ path: file, old_path: null, staged: null, unstaged: "modified", conflicted: false });

async function mount(diffFor) {
  vi.mocked(invoke).mockImplementation(async (command, args) => (command === "working_diff" ? diffFor(args) : null));
  const file = shallowRef(changed("src/notes.js"));
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(WorkingFileDiff, { path: "/repo", file: file.value }) });
  app.mount(root);
  await settle();
  return file;
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await nextTick();
};

// The status list hands over a new file object on each refresh, as when the window
// comes forward, which reads the diff again.
test("keeps the diff on screen, and the lines picked in it, when a refresh reads it unchanged", async () => {
  const file = await mount(() => diff());
  const added = [...document.querySelectorAll("td.sign")].find((td) => td.textContent.trim() === "+");
  added.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  window.dispatchEvent(new MouseEvent("mouseup"));
  await nextTick();
  expect(document.querySelectorAll(".picked").length).toBeGreaterThan(0);
  const table = document.querySelector("table");

  file.value = changed("src/notes.js");
  await settle();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "working_diff")).toHaveLength(2);
  expect(document.querySelector("table")).toBe(table);
  expect(document.querySelectorAll(".picked").length).toBeGreaterThan(0);
});

test("a diff shown in full stays in full when a refresh reads it again", async () => {
  // Cut short when a most is asked for, as a large one is.
  const file = await mount(({ maxLines }) => (maxLines == null ? diff() : { ...diff(), truncated: true, hunks: [] }));
  document.querySelector(".notice .link-button").click();
  await settle();
  expect(document.querySelector(".notice")).toBeNull();

  file.value = changed("src/notes.js");
  await settle();
  expect(vi.mocked(invoke).mock.calls.at(-1)[1].maxLines).toBeNull();
  expect(document.querySelector(".notice")).toBeNull();
});
