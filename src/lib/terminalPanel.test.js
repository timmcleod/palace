import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { mountComposable } from "../test/mount.js";
import { tell } from "./overlays.js";
import { settings } from "./settings.js";
import * as terminals from "./terminals.js";
import { useTerminalPanel } from "./terminalPanel.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
// settings.js sets the window's theme as it loads.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));
vi.mock("./overlays.js", () => ({ tell: vi.fn() }));
// Each repository's tabs, as terminals.js keeps them; opening one adds a tab.
// (Made with the mocks, which run first.)
const { groups, tabsFor } = vi.hoisted(() => {
  const groups = {};
  return { groups, tabsFor: (path) => (groups[path] ??= { tabs: [], active: null }) };
});
vi.mock("./terminals.js", () => ({
  tabsFor,
  agentCommand: () => "claude",
  missingAgent: vi.fn(async () => null),
  openTerminal: vi.fn((path, options) => tabsFor(path).tabs.push({ key: tabsFor(path).tabs.length + 1, ...options })),
  sendToAgent: vi.fn(async () => ({ key: 1 })),
  startAgentOn: vi.fn(async () => "started"),
  offerInstall: vi.fn(async () => false),
}));

// A window that events can be sent to, as from another window or the backend.
function fakeWindow(label = "main") {
  const listeners = {};
  return {
    label,
    listen: vi.fn(async (event, handler) => {
      listeners[event] = handler;
      return () => delete listeners[event];
    }),
    send: (event, payload) => listeners[event]?.({ payload }),
    listening: (event) => !!listeners[event],
  };
}

let mounted;
// The panel, with the repository at `path` open, and a component standing in for it.
function panelFor(path = "/repo", { active } = {}) {
  const overview = ref(path ? { path } : null);
  const window = fakeWindow();
  const loadRepository = vi.fn(async (to) => (overview.value = { path: to }));
  mounted = mountComposable(() => useTerminalPanel({ overview, loadRepository, window, active }));
  const panel = mounted.result;
  panel.panel.value = { focus: vi.fn() };
  return { ...panel, overview, window, loadRepository };
}
const opened = () => vi.mocked(terminals.openTerminal).mock.calls.map(([path, options]) => [path, options]);
const settle = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  vi.mocked(tell).mockClear();
  vi.mocked(terminals.offerInstall).mockClear();
  for (const path of Object.keys(groups)) delete groups[path];
  vi.mocked(terminals.openTerminal).mockClear();
  vi.mocked(terminals.missingAgent).mockReset().mockResolvedValue(null);
  vi.mocked(invoke).mockClear();
  settings.terminalStartsAgent = true;
});
afterEach(() => mounted?.unmount());

describe("showing the panel", () => {
  test("starts the agent in a repository with no terminals", async () => {
    const { show, open, loaded } = panelFor();
    await show();
    expect(open.value && loaded.value).toBe(true);
    expect(opened()).toEqual([["/repo", { command: "claude", kind: "agent" }]]);
  });

  test("starts a shell instead where the agent isn't installed, or Settings says to", async () => {
    vi.mocked(terminals.missingAgent).mockResolvedValue({ program: "claude" });
    await panelFor().show();
    expect(opened()).toEqual([["/repo", { folder: "" }]]);

    settings.terminalStartsAgent = false;
    await panelFor("/other").show();
    expect(opened().at(-1)).toEqual(["/other", { folder: "" }]);
  });

  test("shows the tabs a repository has, starting nothing", async () => {
    const { show, panel } = panelFor();
    await show();
    await show();
    expect(opened()).toHaveLength(1);
    expect(panel.value.focus).toHaveBeenCalled();
  });

  test("starts only one agent when asked twice while checking it's installed", async () => {
    const { show } = panelFor();
    await Promise.all([show(), show()]);
    expect(opened()).toHaveLength(1);
  });

  test("opens a shell for a new tab, or in a folder, whatever's there", async () => {
    const { show } = panelFor();
    await show({ newTab: true });
    await show({ newTab: true, folder: "src" });
    expect(opened()).toEqual([
      ["/repo", { folder: "" }],
      ["/repo", { folder: "src" }],
    ]);
  });

  test("does nothing without a repository", async () => {
    const { show, toggle, open } = panelFor(null);
    await show();
    toggle();
    expect(open.value).toBe(false);
    expect(opened()).toEqual([]);
  });

  test("toggles", async () => {
    const { toggle, open } = panelFor();
    toggle();
    expect(open.value).toBe(true);
    toggle();
    expect(open.value).toBe(false);
  });
});

describe("notices", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const notice = (key, more = {}) => ({ window: "main", path: "/repo", key, state: "done", title: "Agent finished", ...more });

  test("show the newest three, one a tab", () => {
    const { window, notices } = panelFor();
    for (const key of [1, 2, 3, 4]) window.send("notice", notice(key));
    window.send("notice", notice(3, { state: "blocked" }));
    expect(notices.value.map((n) => [n.key, n.state])).toEqual([
      [2, "done"],
      [4, "done"],
      [3, "blocked"],
    ]);
  });

  test("go after a few seconds, or a minute for one waiting on you", () => {
    const { window, notices } = panelFor();
    window.send("notice", notice(1));
    window.send("notice", notice(2, { state: "blocked" }));
    vi.advanceTimersByTime(12000);
    expect(notices.value.map((n) => n.key)).toEqual([2]);
    vi.advanceTimersByTime(48000);
    expect(notices.value).toEqual([]);
  });

  test("bring their tab forward through the window it's in, this one too, which shows the tab its repository's in", async () => {
    vi.useRealTimers();
    const { window, notices, openNotice } = panelFor();
    window.send("notice", notice(2));
    openNotice(notices.value[0]);
    expect(notices.value).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("show_terminal_tab", { label: "main", path: "/repo", key: 2 });
    openNotice(notice(5, { window: "window-2", path: "/elsewhere" }));
    expect(invoke).toHaveBeenCalledWith("show_terminal_tab", { label: "window-2", path: "/elsewhere", key: 5 });
  });
});

test("showing a tab of a repository that isn't open opens it first", async () => {
  const { showTab, loadRepository, overview } = panelFor();
  groups["/other"] = reactive({ tabs: [{ key: 7 }], active: null });
  await showTab({ path: "/other", key: 7 });
  expect(loadRepository).toHaveBeenCalledWith("/other");
  expect(overview.value.path).toBe("/other");
  expect(groups["/other"].active).toBe(7);
});

test("notices are for the workspace showing only", async () => {
  let showing = false;
  const notice = { window: "main", path: "/repo", key: 3, state: "done", title: "Agent finished" };
  const { window, notices } = panelFor("/repo", { active: () => showing });
  window.send("notice", notice);
  expect(notices.value).toEqual([]);
  showing = true;
  window.send("notice", notice);
  expect(notices.value).toHaveLength(1);
});

test("says when the agent can't take what's pasted", async () => {
  const { pasteToAgent } = panelFor();
  expect(await pasteToAgent("Review this")).toBe(true);
  vi.mocked(terminals.sendToAgent).mockResolvedValueOnce(null);
  expect(await pasteToAgent("Review this")).toBe(false);
  expect(tell).toHaveBeenCalledWith("Couldn't Reach the Agent", expect.any(String));
});

test("stops listening once the window's page goes", async () => {
  const { window } = panelFor();
  await settle();
  mounted.unmount();
  mounted = null;
  await settle();
  expect(window.listening("notice")).toBe(false);
});

describe("a task", () => {
  test("starts the agent on it, showing the panel", async () => {
    const { startTask, open } = panelFor();
    await startTask("Fix the login bug");
    expect(terminals.startAgentOn).toHaveBeenLastCalledWith("/repo", "Fix the login bug");
    expect(open.value).toBe(true);
    expect(tell).not.toHaveBeenCalled();
  });

  test("put in the agent's prompt instead, for an agent Palace can't give one to, says to send it", async () => {
    vi.mocked(terminals.startAgentOn).mockResolvedValueOnce("pasted");
    await panelFor().startTask("Fix the login bug");
    expect(tell).toHaveBeenCalledWith("Send the Task", expect.stringContaining("press Enter"));
  });

  test("with the agent not installed in its window, offers to install it, saying the task", async () => {
    const claude = { name: "Claude", title: "Claude Code", program: "claude" };
    vi.mocked(terminals.startAgentOn).mockResolvedValueOnce({ missing: claude });
    await panelFor().startTask("Fix the login bug");
    expect(terminals.offerInstall).toHaveBeenCalledWith("/repo", claude, { then: expect.stringContaining("Fix the login bug") });
  });

  test("gives the task back when the agent didn't start, so it isn't lost", async () => {
    vi.mocked(terminals.startAgentOn).mockResolvedValueOnce(null);
    await panelFor().startTask("Fix the login bug");
    expect(tell).toHaveBeenCalledWith("Couldn't Reach the Agent", expect.stringContaining("Fix the login bug"));
  });
});

describe("whether the agent can start", () => {
  test("it can, where it's installed", async () => {
    expect(await panelFor().agentReady()).toBe(true);
    expect(terminals.offerInstall).not.toHaveBeenCalled();
  });

  test("not, where it isn't: installing it's offered, and the panel shows the installer typed", async () => {
    const claude = { name: "Claude", title: "Claude Code", program: "claude" };
    vi.mocked(terminals.missingAgent).mockResolvedValue(claude);
    const { agentReady, open } = panelFor();
    expect(await agentReady()).toBe(false);
    expect(terminals.offerInstall).toHaveBeenCalledWith("/repo", claude, { then: "start the task again" });
    expect(open.value).toBe(false);

    vi.mocked(terminals.offerInstall).mockResolvedValueOnce(true);
    expect(await agentReady()).toBe(false);
    expect(open.value).toBe(true);
  });
});
