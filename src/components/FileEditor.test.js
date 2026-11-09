import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import FileEditor from "./FileEditor.vue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// settings.js sets the window's theme as it loads.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

async function mount(file) {
  // A file that isn't text, which opens without the editor.
  vi.mocked(invoke).mockResolvedValue({ kind: "binary", size: 2048 });
  const root = document.createElement("div");
  document.body.append(root);
  const closed = [];
  app = createApp({ render: () => h(FileEditor, { path: "/repo", file, onClose: () => closed.push(file) }) });
  app.mount(root);
  for (let i = 0; i < 4; i++) await nextTick();
  return closed;
}

const closeButton = () => document.querySelector('.editor-header button[title="Close"]');

test("closes the open file from its header", async () => {
  const closed = await mount("assets/logo.bin");
  closeButton().click();
  expect(closed).toEqual(["assets/logo.bin"]);
});

test("has nothing to close with no file open", async () => {
  await mount(null);
  expect(closeButton()).toBeNull();
});
