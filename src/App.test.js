import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { isMac } from "./lib/platform.js";

// The whole window, started as main.js starts it, on a stand-in backend. First, a check
// that App.vue sets itself up without an error, such as a name used before it's defined
// or never imported, which nothing else here would catch, since the other tests each
// take a piece of it on its own. Then how its pieces are wired together: what opening
// and switching repositories does, and what the backend's events and the keyboard reach.
// These say what the window does, not where in it that's done, so they hold as its code
// moves about.

// Who's listening for each event, from the backend to this window or to every window.
const heard = vi.hoisted(() => ({}));
const listening = vi.hoisted(() => async (name, handler) => {
  (heard[name] ??= new Set()).add(handler);
  return () => heard[name].delete(handler);
});

// A window that takes whatever's asked of it, and notes its title and closing.
const window = vi.hoisted(() => ({
  label: "main",
  listen: listening,
  onFocusChanged: async () => () => {},
  setTitle: vi.fn(async () => {}),
  setTheme: async () => {},
  close: vi.fn(async () => {}),
  startDragging: async () => {},
  toggleMaximize: async () => {},
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => window }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => window }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listening }));
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

// The backend: git is there, and the window reopens a small repository. Another is
// among the recent ones, to switch to.
const repository = (path, name, extra = {}) => ({
  path,
  name,
  head: { branch: "main", short_id: "abc1234" },
  branches: [{ name: "main", is_head: true, upstream: "origin/main", ahead: 0, behind: 0, worktree: null }],
  remotes: [{ name: "origin", url: `https://github.com/o/${name}.git`, branches: ["main"] }],
  tags: ["v1.0.0"],
  stashes: [],
  submodules: [],
  worktrees: [],
  changes: 0,
  operation: null,
  conflicts: 0,
  files: [],
  ...extra,
});
const PALACE = "/code/palace";
const OTHER = "/code/other";
const changed = (path, more = {}) => ({ path, old_path: null, staged: null, unstaged: "modified", conflicted: false, ...more });

// What each command answers, by name: a value, or a function of its arguments.
let answers;
let repositories;
beforeEach(() => {
  repositories = {
    [PALACE]: repository(PALACE, "palace", { changes: 1, files: [changed("README.md")] }),
    [OTHER]: repository(OTHER, "other", { changes: 1, files: [changed("notes.txt")] }),
  };
  answers = {
    git_check: { supported: true, version: "2.50.0" },
    window_start: { repo: PALACE, first: true },
    folders_gone: [],
    folder_exists: true,
    load_store: { "palace.recentRepositories": [{ name: "palace", path: PALACE }, { name: "other", path: OTHER }] },
    repo_overview: ({ path }) => structuredClone(repositories[path]),
    working_status: ({ path }) => structuredClone(repositories[path].files),
  };
  vi.mocked(invoke).mockClear();
  window.setTitle.mockClear();
  window.close.mockClear();
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command, args) => {
    const answer = answers[command];
    return typeof answer === "function" ? answer(args) : (answer ?? null);
  }),
  Channel: class {
    onmessage = null;
  },
}));

// Sends `name` from the backend, as to this window.
function send(name, payload = null) {
  for (const handler of heard[name] ?? []) handler({ payload });
}

const calls = (command) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command).map(([, args]) => args);

// Lets what's under way finish: a few turns of the event loop.
async function settle(turns = 10) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
  }
}

// Waits for `seen()` to be true, a turn at a time, for a while.
async function until(seen) {
  for (let i = 0; i < 50 && !seen(); i++) await settle(1);
  expect(seen()).toBe(true);
}

const button = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const shown = (text) => document.body.textContent.includes(text);
const subject = () => document.querySelector("input.subject");

function choose(label) {
  const item = [...document.querySelectorAll(".menu [role=menuitem]")].find((i) => i.textContent.includes(label));
  item.click();
}

async function showWorkingCopy() {
  [...document.querySelectorAll(".sidebar *")].find((el) => el.textContent.trim() === "Working Copy" && el.closest("[role], button, li, .row")).click();
  await until(() => !!subject());
}

async function switchTo(name) {
  document.querySelector("button.repo-name").click();
  await until(() => !!document.querySelector(".menu"));
  choose(name);
  await until(() => document.querySelector(".repo-name")?.textContent.includes(name));
}

let app;
let errors;
afterEach(() => {
  app?.unmount();
  document.body.replaceChildren();
});

// Starts the window as main.js does, and waits for it to show the repository it opens.
async function start() {
  errors = [];
  const { loadStore } = await import("./lib/storage.js");
  await loadStore();
  const { default: App } = await import("./App.vue");
  app = createApp(App);
  app.config.errorHandler = (error) => errors.push(error);
  app.config.warnHandler = (message) => /undefined|not defined|failed to resolve/i.test(message) && errors.push(new Error(message));
  const root = document.createElement("div");
  document.body.append(root);
  app.mount(root);
  await until(() => !!root.querySelector(".repo-name")?.textContent.includes("palace"));
  return root;
}

test("the window starts, opening the repository it had, without an error", async () => {
  const root = await start();
  expect(errors).toEqual([]);
  expect(invoke).toHaveBeenCalledWith("repo_overview", expect.objectContaining({ path: PALACE }));
  // The sidebar shows it: its name, its branch and its tag.
  expect(root.querySelector(".repo-name")?.textContent).toContain("palace");
  expect(root.textContent).toContain("main");
  expect(root.textContent).toContain("v1.0.0");
});

test("a repository opened is the window's: the backend's told, the window's titled, and its folder watched", async () => {
  await start();
  await until(() => calls("watch_repo").length > 0);
  expect(calls("set_window_repo").at(-1)).toEqual({ path: PALACE });
  expect(window.setTitle).toHaveBeenLastCalledWith("palace — Palace");
  expect(calls("watch_repo")).toEqual([{ path: PALACE }]);
});

test("switching repositories starts its views afresh, and keeps each one's commit message for when it's back", async () => {
  await start();
  await showWorkingCopy();
  subject().value = "Fix the README";
  subject().dispatchEvent(new Event("input"));

  await switchTo("other");
  expect(calls("watch_repo").at(-1)).toEqual({ path: OTHER });
  expect(window.setTitle).toHaveBeenLastCalledWith("other — Palace");
  // Its history shows, not the Working Copy the other was on.
  expect(subject()).toBeNull();
  await showWorkingCopy();
  expect(subject().value).toBe("");

  await switchTo("palace");
  await showWorkingCopy();
  expect(subject().value).toBe("Fix the README");
  expect(errors).toEqual([]);
});

test("a change the backend sees in the folder refreshes the repository", async () => {
  await start();
  const before = calls("repo_overview").length;
  repositories[PALACE].tags = ["v1.0.0", "v2.0.0"];
  send("repo-changed");
  await until(() => shown("v2.0.0"));
  expect(calls("repo_overview").length).toBeGreaterThan(before);
});

test("a folder that's gone says so, and its Close Window closes the window", async () => {
  await start();
  answers.folder_exists = false;
  send("repo-changed");
  await until(() => shown("“palace” was moved or deleted"));
  button("Close Window").click();
  expect(window.close).toHaveBeenCalled();
});

test("a network operation's progress shows on the status card while it runs", async () => {
  await start();
  let finish;
  answers.fetch = () => new Promise((resolve) => (finish = resolve));
  document.querySelector(".toolbar.actions .icon-button").click();
  await until(() => !!finish);
  send("remote-progress", { line: "Receiving objects: 42%" });
  await until(() => shown("Receiving objects: 42%"));
  finish(null);
  await settle();
});

test("a keyboard shortcut reaches the open repository", async () => {
  await start();
  const before = calls("repo_overview").length;
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "r", metaKey: isMac, ctrlKey: !isMac, bubbles: true }));
  // Refreshed, and fetched.
  await until(() => calls("fetch").length > 0);
  expect(calls("fetch")[0]).toMatchObject({ path: PALACE });
  await until(() => calls("repo_overview").length > before);
});

test("closing the window goes ahead with nothing to lose, and otherwise asks first", async () => {
  await start();
  const nothing = { terminals: [], edits: false, other_terminals: [], other_edits: [] };
  send("quit-requested", { quitting: true, ...nothing });
  await until(() => calls("quit_confirmed").length > 0);
  expect(calls("quit_confirmed")).toEqual([{ quitting: true }]);

  send("quit-requested", { quitting: false, ...nothing, other_terminals: ["shop"] });
  await until(() => shown("a terminal in shop is still running"));
  expect(calls("quit_confirmed")).toHaveLength(1);
  button("Close").click();
  await until(() => calls("quit_confirmed").length > 1);
  expect(calls("quit_confirmed").at(-1)).toEqual({ quitting: false });
});

// A repository stopped with two files in conflict, a.txt and b.txt, open on a.txt in the
// Working Copy, marked as resolved.
async function resolveFirstConflict() {
  const conflicted = (path) => changed(path, { unstaged: null, conflicted: true });
  repositories[PALACE] = repository(PALACE, "palace", { changes: 2, conflicts: 2, files: [conflicted("a.txt"), conflicted("b.txt")] });
  answers.conflict_file = "resolved\n";
  // Resolving is undoable: undo keeps a copy of how things were before and after.
  let taken = 0;
  answers.take_snapshot = () => ({ head_branch: "main", head_id: `snapshot ${++taken}`, refs: {}, upstreams: {}, stashes: [], files: [] });
  answers.resolve_conflict = () => {
    repositories[PALACE].files[0] = changed("a.txt", { staged: "modified", unstaged: null });
    return null;
  };
  await start();
  await showWorkingCopy();
  [...document.querySelectorAll(".files *")].find((el) => el.textContent.trim() === "a.txt").click();
  await until(() => document.querySelector(".file-title")?.textContent === "a.txt" && !!button("Mark as Resolved"));
  button("Mark as Resolved").click();
  await until(() => calls("resolve_conflict").length > 0);
}

test("once a conflicted file is resolved, the next one shows", async () => {
  await resolveFirstConflict();
  await until(() => document.querySelector(".file-title")?.textContent === "b.txt");
  expect(calls("resolve_conflict")[0]).toMatchObject({ path: PALACE, file: "a.txt", side: "resolved" });
});

test("undo steps stay with their repository, while another's open", async () => {
  await resolveFirstConflict();
  await until(() => document.querySelector(".file-title")?.textContent === "b.txt");
  const undoKey = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: isMac, ctrlKey: !isMac, bubbles: true }));

  await switchTo("other");
  undoKey();
  await settle();
  expect(calls("restore_snapshot")).toEqual([]);

  await switchTo("palace");
  undoKey();
  await until(() => calls("restore_snapshot").length > 0);
  expect(calls("restore_snapshot")[0]).toMatchObject({ path: PALACE });
});
