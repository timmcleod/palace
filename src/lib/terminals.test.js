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

const { missingAgent } = await import("./terminals.js");

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
