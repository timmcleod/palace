import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { isMac } from "./lib/platform.js";

// The whole window, started as main.js starts it, on a stand-in backend. First, a check
// that App.vue and Workspace.vue set themselves up without an error, such as a name
// used before it's defined or never imported, which nothing else here would catch, since
// the other tests each take a piece of it on its own. Then how its pieces are wired
// together: what opening and switching repositories does, and what the backend's events
// and the keyboard reach. These say what the window does, not where in it that's done,
// so they hold as its code moves about.

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
const THIRD = "/code/third";
const changed = (path, more = {}) => ({ path, old_path: null, staged: null, unstaged: "modified", conflicted: false, ...more });

// What each command answers, by name: a value, or a function of its arguments.
let answers;
let repositories;
beforeEach(() => {
  repositories = {
    [PALACE]: repository(PALACE, "palace", { changes: 1, files: [changed("README.md")] }),
    [OTHER]: repository(OTHER, "other", { changes: 1, files: [changed("notes.txt")] }),
    [THIRD]: repository(THIRD, "third"),
  };
  answers = {
    git_check: { supported: true, version: "2.50.0" },
    window_start: { tabs: { repos: [PALACE], active: 0 }, first: true },
    folders_gone: [],
    folder_exists: true,
    load_store: {
      "palace.recentRepositories": [
        { name: "palace", path: PALACE },
        { name: "other", path: OTHER },
        { name: "third", path: THIRD },
      ],
    },
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
// What's in the tab showing: the others, hidden, are still in the page.
const showing = () => [...document.querySelectorAll(".workspace")].find((el) => el.style.display !== "none") ?? document;
const subject = () => showing().querySelector("input.subject");

function choose(label) {
  const item = [...document.querySelectorAll(".menu [role=menuitem]")].find((i) => i.textContent.includes(label));
  item.click();
}

async function showWorkingCopy() {
  [...showing().querySelectorAll(".sidebar *")].find((el) => el.textContent.trim() === "Working Copy" && el.closest("[role], button, li, .row")).click();
  await until(() => !!subject());
}

async function switchTo(name) {
  showing().querySelector("button.repo-name").click();
  await until(() => !!document.querySelector(".menu"));
  choose(name);
  await until(() => showing().querySelector(".repo-name")?.textContent.includes(name));
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

test("the window hangs up the terminals its page had before a reload, once", async () => {
  await start();
  expect(calls("terminal_close_all")).toHaveLength(1);
});

test("a workspace that isn't the one showing leaves the window's title and keys alone, until it shows", async () => {
  const { loadStore } = await import("./lib/storage.js");
  await loadStore();
  const { default: Workspace } = await import("./components/Workspace.vue");
  const showing = ref(false);
  app = createApp({ render: () => h(Workspace, { opens: PALACE, active: showing.value }) });
  const root = document.createElement("div");
  document.body.append(root);
  app.mount(root);
  await until(() => !!root.querySelector(".repo-name")?.textContent.includes("palace"));

  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "r", metaKey: isMac, ctrlKey: !isMac, bubbles: true }));
  await settle();
  expect(calls("fetch")).toEqual([]);
  expect(window.setTitle).not.toHaveBeenCalled();

  showing.value = true;
  await until(() => window.setTitle.mock.calls.length > 0);
  expect(window.setTitle).toHaveBeenLastCalledWith("palace — Palace");
});

test("a repository opened is the window's: the backend's told, the window's titled, and its folder watched", async () => {
  await start();
  await until(() => calls("watch_repo").length > 0);
  expect(calls("set_window_tabs").at(-1)).toEqual({ tabs: { repos: [PALACE], active: 0 } });
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
  // The backend lets go of the one before: it isn't watched, and its history goes.
  expect(calls("release_repo")).toEqual([{ path: PALACE }]);
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

test("a change the backend sees in the folder refreshes the repository, and one in another doesn't", async () => {
  await start();
  const before = calls("repo_overview").length;
  send("repo-changed", { path: OTHER });
  await settle();
  expect(calls("repo_overview")).toHaveLength(before);

  repositories[PALACE].tags = ["v1.0.0", "v2.0.0"];
  send("repo-changed", { path: PALACE });
  await until(() => shown("v2.0.0"));
  expect(calls("repo_overview").length).toBeGreaterThan(before);
});

test("a folder that's gone says so, and its Close Tab closes its tab, the window with its last", async () => {
  await start();
  answers.folder_exists = false;
  send("repo-changed", { path: PALACE });
  await until(() => shown("“palace” was moved or deleted"));
  button("Close Tab").click();
  expect(window.close).toHaveBeenCalled();
});

test("a network operation's progress shows on the status card while it runs, and Cancel stops it", async () => {
  await start();
  let finish;
  answers.fetch = () => new Promise((resolve) => (finish = resolve));
  document.querySelector(".toolbar.actions .icon-button").click();
  await until(() => !!finish);
  send("remote-progress", { path: PALACE, line: "Receiving objects: 42%" });
  await until(() => shown("Receiving objects: 42%"));
  // Another repository's isn't this one's.
  send("remote-progress", { path: OTHER, line: "Counting objects: 7" });
  await settle();
  expect(shown("Receiving objects: 42%")).toBe(true);
  expect(shown("Counting objects: 7")).toBe(false);

  button("Cancel").click();
  expect(calls("cancel_remote")).toEqual([{ path: PALACE }]);
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

// --- Tabs --------------------------------------------------------------------------

const tabNames = () => [...document.querySelectorAll(".tab-strip .tab .name")].map((el) => el.textContent);
const showingTab = () => document.querySelector(".tab-strip .tab.active .name")?.textContent;
const tabNamed = (name) => [...document.querySelectorAll(".tab-strip .tab")].find((el) => el.querySelector(".name")?.textContent === name);
const press = (key, init = {}) =>
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code: init.code, metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true, ...init }));
const confirmShown = () => !!document.querySelector("[role=alertdialog]");

// Opens a new tab, with ⌘T, then the repository named `name` in it, from the welcome
// screen.
async function openInNewTab(name) {
  press("t", { code: "KeyT" });
  await until(() => !!showing()?.querySelector(".recent"));
  [...showing().querySelectorAll(".recent")].find((el) => el.textContent.includes(name)).click();
  await until(() => showingTab() === name);
}

test("one tab looks as a window without tabs; a second brings their row, and closing it takes it away", async () => {
  await start();
  expect(document.querySelector(".tab-strip")).toBeNull();
  expect(document.documentElement.dataset.tabs).toBeUndefined();
  await openInNewTab("other");
  expect(document.documentElement.dataset.tabs).toBe("many");
  tabNamed("other").querySelector(".close").click();
  await until(() => !document.querySelector(".tab-strip"));
  expect(document.documentElement.dataset.tabs).toBeUndefined();
});

test("a new tab opens to choose a repository in, which opens there, beside the other", async () => {
  await start();
  await openInNewTab("other");
  expect(tabNames()).toEqual(["palace", "other"]);
  await until(() => calls("set_window_tabs").at(-1)?.tabs.repos.length === 2);
  expect(calls("set_window_tabs").at(-1)).toEqual({ tabs: { repos: [PALACE, OTHER], active: 1 } });
  // Each keeps its own repository, watched, while the other shows.
  expect(calls("watch_repo")).toEqual([{ path: PALACE }, { path: OTHER }]);
  expect(calls("release_repo")).toEqual([]);
  expect(window.setTitle).toHaveBeenLastCalledWith("other — Palace");
});

test("clicking a tab, or the keys for one, shows it, and the window's title names it", async () => {
  await start();
  await openInNewTab("other");
  tabNamed("palace").click();
  await until(() => showingTab() === "palace");
  expect(window.setTitle).toHaveBeenLastCalledWith("palace — Palace");
  press("2", { code: "Digit2" });
  await until(() => showingTab() === "other");
  press("Tab", { metaKey: false, ctrlKey: true, code: "Tab" });
  await until(() => showingTab() === "palace");
  // Only the tab showing acts on keys meant for one: ⌘R refreshes and fetches it.
  press("r", { code: "KeyR" });
  await until(() => calls("fetch").length > 0);
  expect(calls("fetch").map((args) => args.path)).toEqual([PALACE]);
});

test("opening a repository open in another tab shows that tab rather than opening it twice", async () => {
  await start();
  await openInNewTab("other");
  await switchTo("palace");
  expect(tabNames()).toEqual(["palace", "other"]);
  expect(showingTab()).toBe("palace");
});

test("closing a tab asks first when it has edits not saved, and the last tab closes the window", async () => {
  await start();
  await openInNewTab("other");
  const { markUnsaved } = await import("./lib/editing.js");
  markUnsaved(OTHER, "notes.txt", true);
  tabNamed("other").querySelector(".close").click();
  await until(() => shown("Edits to “notes.txt” aren't saved. Closing the tab loses them."));
  button("Cancel").click();
  await settle();
  expect(tabNames()).toEqual(["palace", "other"]);

  tabNamed("other").querySelector(".close").click();
  await until(() => !!button("Close"));
  button("Close").click();
  // Back to one tab: no row of them.
  await until(() => !document.querySelector(".tab-strip"));
  // Gone with it: its edits, and its watcher.
  const { unsavedFiles } = await import("./lib/editing.js");
  expect(unsavedFiles()).toEqual([]);
  await until(() => calls("release_repo").length > 0);
  expect(calls("release_repo")).toEqual([{ path: OTHER }]);

  // The last, with ⌘W, as its row's gone with the others.
  press("w", { code: "KeyW" });
  await settle();
  expect(window.close).toHaveBeenCalled();
});

test("the window starts with the tabs it had, the one that was showing showing", async () => {
  answers.window_start = { tabs: { repos: [PALACE, OTHER], active: 1 }, first: false };
  errors = [];
  const { loadStore } = await import("./lib/storage.js");
  await loadStore();
  const { default: App } = await import("./App.vue");
  app = createApp(App);
  app.config.errorHandler = (error) => errors.push(error);
  const root = document.createElement("div");
  document.body.append(root);
  app.mount(root);
  await until(() => tabNames().join() === "palace,other" && showingTab() === "other");
  expect(errors).toEqual([]);
});

test("another window asking for a repository open here shows its tab; a worktree removed closes its", async () => {
  await start();
  await openInNewTab("other");
  send("show-repo", { path: PALACE });
  await until(() => showingTab() === "palace");
  send("close-repo", { path: OTHER });
  await until(() => !document.querySelector(".tab-strip"));
  expect(showing().querySelector(".repo-name").textContent).toContain("palace");
  // Asked already, as the worktree was removed: not again.
  expect(confirmShown()).toBe(false);
});

test("a notice clicked shows the tab its terminal's repository is in", async () => {
  await start();
  await openInNewTab("other");
  send("show-terminal-tab", { path: PALACE, key: 3 });
  await until(() => showingTab() === "palace");
});

// A terminal tab in the repository at `path`, with something running in it, or not.
async function terminalIn(path, id, title, busy) {
  const { tabsFor } = await import("./lib/terminals.js");
  tabsFor(path).tabs.push({ id, key: id, title, kind: "shell", session: { term: { dispose() {} }, el: { remove() {} } } });
  const before = answers.terminal_busy;
  answers.terminal_busy = (args) => (args.id === id ? busy : (typeof before === "function" ? before(args) : false));
}

test("closing a tab asks about what runs in its terminals, those of a repository it showed before too, then stops them", async () => {
  await start();
  await openInNewTab("other");
  await terminalIn(OTHER, 91, "npm run dev", true);
  // The tab goes on to another repository: what runs in the one before goes on running.
  await switchTo("third");
  tabNamed("third").querySelector(".close").click();
  await until(() => shown("“npm run dev” is still running. Closing the tab stops it."));
  button("Close").click();
  await until(() => calls("terminal_close").some((args) => args.id === 91));
  expect(document.querySelector(".tab-strip")).toBeNull();
});

test("a tab with no repository closes without asking", async () => {
  await start();
  press("t", { code: "KeyT" });
  await until(() => tabNames().length === 2);
  press("w", { code: "KeyW" });
  await until(() => !document.querySelector(".tab-strip"));
  expect(confirmShown()).toBe(false);
});

test("the File menu opens and closes tabs, and opens windows, but not under a dialog", async () => {
  await start();
  send("menu", "new-tab");
  await until(() => tabNames().length === 2);
  send("menu", "new-window");
  await until(() => calls("new_window").length > 0);
  // Under a dialog, nothing.
  const { tell } = await import("./lib/overlays.js");
  tell("Something", "To read first.");
  await until(confirmShown);
  send("menu", "close-tab");
  await settle();
  expect(tabNames().length).toBe(2);
  button("OK").click();
  await until(() => !confirmShown());
  send("menu", "close-tab");
  await until(() => !document.querySelector(".tab-strip"));
});

test("a repository open in another window brings that forward, rather than opening here", async () => {
  answers.show_window_with = ({ path }) => path === OTHER;
  await start();
  press("t", { code: "KeyT" });
  await until(() => !!showing().querySelector(".recent"));
  [...showing().querySelectorAll(".recent")].find((el) => el.textContent.includes("other")).click();
  await until(() => calls("show_window_with").some((args) => args.path === OTHER));
  await settle();
  expect(tabNames()).toEqual(["palace", "New Tab"]);
});

test("a worktree removed that's the window's last tab closes the window, asked already", async () => {
  await start();
  send("close-repo", { path: PALACE });
  await until(() => calls("quit_confirmed").length > 0);
  expect(calls("quit_confirmed")).toEqual([{ quitting: false }]);
});

test("a notice clicked for a tab closed since opens it once, not twice", async () => {
  await start();
  await openInNewTab("other");
  tabNamed("other").querySelector(".close").click();
  await until(() => !document.querySelector(".tab-strip"));
  const before = calls("repo_overview").filter((args) => args.path === OTHER).length;
  send("show-terminal-tab", { path: OTHER, key: 3 });
  await until(() => showingTab() === "other");
  await settle();
  expect(calls("repo_overview").filter((args) => args.path === OTHER).length - before).toBe(1);
  expect(calls("set_window_tabs").at(-1)).toEqual({ tabs: { repos: [PALACE, OTHER], active: 1 } });
});

test("with git missing, the tabs the window had are kept for when it's found", async () => {
  answers.git_check = { supported: false, version: "2.10.0" };
  const { loadStore } = await import("./lib/storage.js");
  await loadStore();
  const { default: App } = await import("./App.vue");
  app = createApp(App);
  const root = document.createElement("div");
  document.body.append(root);
  app.mount(root);
  await until(() => calls("git_check").length > 0);
  await settle();
  expect(calls("set_window_tabs")).toEqual([]);
});

test("a tab closed while it opens starts no agent on its task", async () => {
  // The agent's there to start, so only the tab's being closed stops it.
  answers.program_available = true;
  let opened;
  answers.repo_overview = ({ path }) => new Promise((resolve) => (opened = () => resolve(structuredClone(repositories[path]))));
  const { loadStore } = await import("./lib/storage.js");
  await loadStore();
  const { default: Workspace } = await import("./components/Workspace.vue");
  app = createApp({ render: () => h(Workspace, { opens: OTHER, task: "Fix the README" }) });
  const root = document.createElement("div");
  document.body.append(root);
  app.mount(root);
  await until(() => !!opened);
  app.unmount();
  app = null;
  opened();
  await settle();
  // No agent tab made, to run with nothing to show it.
  const { terminals } = await import("./lib/terminals.js");
  expect(terminals[OTHER]?.tabs ?? []).toEqual([]);
  expect(confirmShown()).toBe(false);
});

test("at startup, the last repository open in another window brings that forward, and this one starts with none", async () => {
  answers.window_start = { tabs: { repos: [], active: null }, first: true };
  answers.show_window_with = ({ path }) => path === PALACE;
  const { loadStore } = await import("./lib/storage.js");
  await loadStore();
  const { default: App } = await import("./App.vue");
  app = createApp(App);
  const root = document.createElement("div");
  document.body.append(root);
  app.mount(root);
  await until(() => calls("show_window_with").some((args) => args.path === PALACE));
  await until(() => !!document.querySelector(".welcome"));
  expect(calls("watch_repo")).toEqual([]);
});
