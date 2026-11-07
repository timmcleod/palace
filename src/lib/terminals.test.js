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

const { missingAgent, sendToAgent, tabsFor } = await import("./terminals.js");

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

  test("sends it as well, for a task, with Enter after the paste rather than in it", async () => {
    const tab = agentTab("/two");
    await sendToAgent("/two", "Fix the login bug\nand add a test", { submit: true });
    expect(tab.session.term.paste).toHaveBeenCalledWith("Fix the login bug\nand add a test");
    expect(typed()).toEqual([{ id: 7, data: "\r" }]);
  });
});
