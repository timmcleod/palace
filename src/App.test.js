import { afterEach, expect, test, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";

// The whole window, started as main.js starts it, on a stand-in backend: a check that
// App.vue sets itself up without an error, such as a name used before it's defined or
// never imported, which nothing else here would catch, since the other tests each take
// a piece of it on its own.

// A window that takes whatever's asked of it.
const window = vi.hoisted(() => ({
  label: "main",
  listen: async () => () => {},
  onFocusChanged: async () => () => {},
  setTitle: async () => {},
  setTheme: async () => {},
  close: async () => {},
  startDragging: async () => {},
  toggleMaximize: async () => {},
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => window }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => window }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0" }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: async () => "", writeText: async () => {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => false,
  onAction: async () => () => {},
  requestPermission: async () => "denied",
  sendNotification: () => {},
}));

// The backend: git is there, and the window reopens a small repository.
const repository = {
  path: "/code/palace",
  name: "palace",
  head: { branch: "main", short_id: "abc1234" },
  branches: [{ name: "main", is_head: true, upstream: "origin/main", ahead: 0, behind: 0, worktree: null }],
  remotes: [{ name: "origin", url: "https://github.com/o/palace.git", branches: ["main"] }],
  tags: ["v1.0.0"],
  stashes: [],
  submodules: [],
  worktrees: [],
  changes: 0,
  operation: null,
  conflicts: 0,
  files: [],
};
const answers = {
  git_check: { supported: true, version: "2.50.0" },
  window_start: { repo: repository.path, first: true },
  repo_overview: repository,
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command) => answers[command] ?? null),
  Channel: class {
    onmessage = null;
  },
}));

let app;
afterEach(() => app?.unmount());

test("the window starts, opening the repository it had, without an error", async () => {
  const errors = [];
  const { loadStore } = await import("./lib/storage.js");
  await loadStore();
  const { default: App } = await import("./App.vue");
  app = createApp(App);
  app.config.errorHandler = (error) => errors.push(error);
  app.config.warnHandler = (message) => /undefined|not defined|failed to resolve/i.test(message) && errors.push(new Error(message));
  const root = document.createElement("div");
  document.body.append(root);
  app.mount(root);

  // Opening the repository takes a few turns.
  for (let i = 0; i < 20 && !document.body.textContent.includes("palace"); i++) {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
  }
  expect(errors).toEqual([]);
  expect(invoke).toHaveBeenCalledWith("repo_overview", expect.objectContaining({ path: repository.path }));
  // The sidebar shows it: its name, its branch and its tag.
  expect(root.querySelector(".repo-name")?.textContent).toContain("palace");
  expect(root.textContent).toContain("main");
  expect(root.textContent).toContain("v1.0.0");
});
