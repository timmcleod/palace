import { beforeEach, describe, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// terminals.js reaches for the window, the clipboard and notifications as it loads, so
// they're all stood in for, though only invoke is used here.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  onAction: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

const { busyIn, closeTerminalsOf, missingAgent, repositoryStates, sendToAgent, startAgentOn, tabsFor, terminals, typePaths } = await import("./terminals.js");
const { nextTick } = await import("vue");

beforeEach(() => vi.mocked(invoke).mockReset());

describe("missingAgent", () => {
  test("names a known agent that isn't installed", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    expect((await missingAgent("claude --resume"))?.program).toBe("claude");
    expect(invoke).toHaveBeenCalledWith("program_available", { program: "claude" });
  });

  test("says nothing of one that's installed", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    expect(await missingAgent("claude")).toBeNull();
  });

  test("leaves a command that's the shell's to run unchecked", async () => {
    expect(await missingAgent("cd api && claude")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("sendToAgent", () => {
  beforeEach(() => vi.mocked(invoke).mockResolvedValue(null));

  // An agent tab already running in the repository, its terminal stood in for.
  function agentTab(path) {
    const tab = { key: 1, id: 7, kind: "agent", session: { term: { paste: vi.fn(), modes: { bracketedPasteMode: true } }, typed: [], reply: null } };
    tabsFor(path).tabs.push(tab);
    return tab;
  }
  const typed = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "terminal_write").map(([, args]) => args);

  test("puts the text in the agent's prompt, leaving it to be sent", async () => {
    const tab = agentTab("/one");
    // The tab, as the reactive list of them has it.
    expect((await sendToAgent("/one", "Review these")).key).toBe(tab.key);
    expect(tab.session.term.paste).toHaveBeenCalledWith("Review these");
    expect(typed()).toEqual([]);
  });
});

describe("each repository's agents", () => {
  beforeEach(() => vi.mocked(invoke).mockResolvedValue(null));

  // A tab whose program last said `state`, and has or hasn't been looked at since.
  const tab = (state, unseen = false) => ({ key: Math.random(), kind: "agent", status: state && { state }, unseen, session: {} });

  test("say the most pressing of their tabs' states", () => {
    tabsFor("/busy").tabs.push(tab("working"), tab(null));
    tabsFor("/asking").tabs.push(tab("working"), tab("blocked"));
    tabsFor("/finished").tabs.push(tab("done", true), tab("working"));
    tabsFor("/failed").tabs.push(tab("done", true), tab("error", true));
    expect(repositoryStates()).toMatchObject({ "/busy": "working", "/asking": "blocked", "/finished": "done", "/failed": "error" });
  });

  test("leave out what's finished and been looked at, or idle", () => {
    tabsFor("/seen").tabs.push(tab("done", false), tab("idle"));
    expect(repositoryStates()).not.toHaveProperty("/seen");
  });

  test("are said to the backend as they change, and only then", async () => {
    const reports = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "set_agent_states");
    const watched = tab("working");
    tabsFor("/watched").tabs.push(watched);
    await nextTick();
    const before = reports().length;
    expect(reports().at(-1)[1].states["/watched"]).toBe("working");

    // Another tab working too: the summary's read again, but it's the same.
    tabsFor("/watched").tabs.push(tab("working"));
    await nextTick();
    expect(reports()).toHaveLength(before);

    tabsFor("/watched").tabs[0].status = { state: "blocked" };
    await nextTick();
    expect(reports()).toHaveLength(before + 1);
    expect(reports().at(-1)[1].states["/watched"]).toBe("blocked");
  });
});

test("an agent that isn't installed isn't started on a task, to say only \"command not found\"", async () => {
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => (command === "program_available" ? false : null));
  expect((await startAgentOn("/repo", "Fix it"))?.missing?.program).toBe("claude");
  expect(invoke).not.toHaveBeenCalledWith("terminal_open", expect.anything());
});

test("types dropped files' paths in the tab, quoted for its shell, then a space", () => {
  const term = { paste: vi.fn(), focus: vi.fn() };
  typePaths({ session: { term } }, ["/home/ada/Desktop/shot.png", "/home/ada/My Notes/to do.md"]);
  expect(term.paste).toHaveBeenCalledWith("/home/ada/Desktop/shot.png /home/ada/My\\ Notes/to\\ do.md ");
  expect(term.focus).toHaveBeenCalled();
  term.paste.mockClear();
  typePaths({ session: { term } }, []);
  expect(term.paste).not.toHaveBeenCalled();
});

test("closing a repository's tab in the window says which of its terminals are busy, then closes them all", async () => {
  // A terminal tab as one stands, with what closing it reaches for.
  const terminal = (id, title) => ({ id, key: id, title, kind: "shell", session: { term: { dispose: vi.fn() }, el: { remove: vi.fn() } } });
  tabsFor("/closing").tabs.push(terminal(41, "npm run dev"), terminal(42, "zsh"));
  vi.mocked(invoke).mockImplementation(async (command, args) => (command === "terminal_busy" ? args.id === 41 : null));
  expect(await busyIn("/closing")).toEqual(["npm run dev"]);
  expect(await busyIn("/none")).toEqual([]);

  closeTerminalsOf("/closing");
  expect(terminals["/closing"]).toBeUndefined();
  const hungUp = vi.mocked(invoke).mock.calls.filter(([command]) => command === "terminal_close").map(([, args]) => args.id);
  expect(hungUp).toEqual([41, 42]);
});
