import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { mountComposable } from "../test/mount.js";
import { askConfirm } from "./overlays.js";
import { showIn } from "./tabs.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./overlays.js", () => ({ askConfirm: vi.fn() }));
vi.mock("./panes.js", () => ({ fitTerminal: vi.fn() }));
vi.mock("./recents.js", () => ({ lastRepository: vi.fn(async () => "/code/last") }));
vi.mock("./settings.js", () => ({ settings: { autoSave: false } }));
vi.mock("./editing.js", () => ({ finishSaving: vi.fn(), forgetEditsIn: vi.fn(), unsavedFiles: vi.fn(() => []) }));
const terminals = vi.hoisted(() => ({ busyIn: vi.fn(async () => []), closeTerminalsOf: vi.fn() }));
vi.mock("./terminals.js", () => terminals);

const { useTabs } = await import("./windowTabs.js");
const { unsavedFiles } = await import("./editing.js");

// What the backend answers, by command.
let answers;
beforeEach(() => {
  answers = { window_start: { tabs: { repos: [], active: null }, first: false }, show_window_with: false };
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => answers[command] ?? null);
  vi.mocked(askConfirm).mockReset();
  terminals.busyIn.mockReset().mockResolvedValue([]);
  terminals.closeTerminalsOf.mockReset();
});

// A window that events can be sent to, and closed.
function fakeWindow() {
  const listeners = {};
  return {
    close: vi.fn(),
    listen: vi.fn(async (event, handler) => {
      listeners[event] = handler;
      return () => delete listeners[event];
    }),
    send: (event, payload) => listeners[event]?.({ payload }),
  };
}

let mounted;
afterEach(() => mounted?.unmount());

async function windowWith(start) {
  answers.window_start = start;
  const window = fakeWindow();
  mounted = mountComposable(() => useTabs({ window }));
  await mounted.result.start();
  return { ...mounted.result, window };
}
const paths = ({ tabs }) => tabs.list.map((tab) => tab.path);
const showingPath = ({ tabs }) => tabs.list.find((tab) => tab.id === tabs.active)?.path;
// The tab has shown its repository, as its workspace says once it's opened it.
const opened = (tab) => showIn(tab, { path: tab.path, name: "x", branch: "main" });

test("starts with the tabs the window had, the one that was showing showing; or the first window, with the last repository", async () => {
  const had = await windowWith({ tabs: { repos: ["/a", "/b"], active: 1 }, first: false });
  expect([paths(had), showingPath(had), had.first.value]).toEqual([["/a", "/b"], "/b", null]);
  mounted.unmount();
  const first = await windowWith({ tabs: { repos: [], active: null }, first: true });
  expect([paths(first), first.first.value]).toEqual([["/code/last"], first.tabs.active]);
  expect(invoke).toHaveBeenCalledWith("set_window_tabs", { tabs: { repos: ["/code/last"], active: 0 } });
});

test("a repository open in another tab shows that tab, and the empty tab it was chosen in goes", async () => {
  const w = await windowWith({ tabs: { repos: ["/a"], active: 0 }, first: false });
  const empty = w.newTab();
  expect(await w.showElsewhere("/a", empty)).toBe(true);
  expect([paths(w), showingPath(w)]).toEqual([["/a"], "/a"]);
  // One opening it already isn't elsewhere: other windows are asked.
  expect(await w.showElsewhere("/a", w.tabs.list[0])).toBe(false);
  expect(invoke).toHaveBeenCalledWith("show_window_with", { path: "/a" });
});

test("only a tab that's shown a repository has it, not one still opening it", async () => {
  const w = await windowWith({ tabs: { repos: ["/a", "/a2"], active: 0 }, first: false });
  const [a, other] = w.tabs.list;
  expect(w.shownElsewhere("/a", other)).toBe(false);
  opened(a);
  expect(w.shownElsewhere("/a", other)).toBe(true);
  expect(w.shownElsewhere("/a", a)).toBe(false);
});

test("a tab that couldn't open its repository lets go of what's left of it, where no other tab has it", async () => {
  const w = await windowWith({ tabs: { repos: ["/a", "/b"], active: 0 }, first: false });
  const [a] = w.tabs.list;
  w.shows(a, null);
  await vi.waitFor(() => expect(terminals.closeTerminalsOf).toHaveBeenCalledWith("/a"));
  expect(invoke).toHaveBeenCalledWith("release_repo", { path: "/a" });
});

test("closing a tab asks what it would lose, then stops its terminals, once it's gone", async () => {
  const w = await windowWith({ tabs: { repos: ["/a", "/b"], active: 0 }, first: false });
  const [a] = w.tabs.list;
  opened(a);
  terminals.busyIn.mockImplementation(async (path) => (path === "/a" ? ["npm run dev"] : []));
  vi.mocked(unsavedFiles).mockReturnValue([{ path: "/a", file: "src/notes.txt" }]);
  vi.mocked(askConfirm).mockResolvedValueOnce(false);
  await w.askToClose(a.id);
  expect(vi.mocked(askConfirm).mock.calls[0][0].message).toBe(
    "Edits to “notes.txt” aren't saved. Closing the tab loses them.\n\n“npm run dev” is still running. Closing the tab stops it.",
  );
  expect(paths(w)).toEqual(["/a", "/b"]);

  vi.mocked(askConfirm).mockResolvedValueOnce(true);
  await w.askToClose(a.id);
  await vi.waitFor(() => expect(terminals.closeTerminalsOf).toHaveBeenCalledWith("/a"));
  expect(paths(w)).toEqual(["/b"]);
  vi.mocked(unsavedFiles).mockReturnValue([]);

  // The last closes the window, which asks as its close button does.
  await w.askToClose(w.tabs.list[0].id);
  expect(w.window.close).toHaveBeenCalled();
});

test("the backend's told a repository's tab shows, or closes, as another window asks", async () => {
  const w = await windowWith({ tabs: { repos: ["/a", "/b"], active: 0 }, first: false });
  w.window.send("show-repo", { path: "/b" });
  expect(showingPath(w)).toBe("/b");
  w.window.send("close-repo", { path: "/b" });
  await nextTick();
  expect(paths(w)).toEqual(["/a"]);
  expect(askConfirm).not.toHaveBeenCalled();
  // Its last tab, the window goes too.
  w.window.send("close-repo", { path: "/a" });
  expect(invoke).toHaveBeenCalledWith("quit_confirmed", { quitting: false });
});
