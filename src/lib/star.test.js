import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// storage.js listens for Palace's other windows as it loads.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const account = ref(null);
vi.mock("./github.js", () => ({ githubAccount: account }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-12T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.resetModules();
  account.value = null;
  // Not starred yet; nothing else is asked of the backend.
  vi.mocked(invoke).mockImplementation(async (command) => (command === "github_starred_palace" ? false : null));
});
afterEach(() => vi.useRealTimers());

// Starts Palace with `saved` already saved, signed in to GitHub, and waits as long as
// it takes to ask.
async function start(saved = {}) {
  const { writeJson, readJson } = await import("./storage.js");
  for (const [key, value] of Object.entries(saved)) writeJson(key, value);
  const { starRequest } = await import("./star.js");
  account.value = { login: "someone" };
  await vi.advanceTimersByTimeAsync(60 * 1000);
  return { starRequest, readJson };
}

test("doesn't ask the first day Palace is used, and remembers when that was", async () => {
  const { starRequest, readJson } = await start();
  expect(starRequest.value).toBeNull();
  expect(readJson("palace.firstStarted")).toBe(NOW);
});

test("asks once Palace has been in use for a day", async () => {
  const { starRequest } = await start({ "palace.firstStarted": NOW - DAY });
  expect(starRequest.value).toBe("ask");
});

test("doesn't ask again once asked", async () => {
  const { starRequest } = await start({ "palace.firstStarted": NOW - 30 * DAY, "palace.starAsked": true });
  expect(starRequest.value).toBeNull();
});

test("doesn't ask an account that has starred Palace already", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => command === "github_starred_palace");
  const { starRequest, readJson } = await start({ "palace.firstStarted": NOW - DAY });
  expect(starRequest.value).toBeNull();
  expect(readJson("palace.starAsked")).toBe(true);
});
