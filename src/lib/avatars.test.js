import { beforeEach, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";

// The backend's reports of the pictures it's found, sent to the page as `send` does.
const heard = vi.hoisted(() => ({ handler: null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_, handler) => ((heard.handler = handler), () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("./settings.js", async () => ({ settings: (await import("vue")).reactive({ githubAvatars: true }) }));

const { avatars, forgetAvatars, loadAvatars } = await import("./avatars.js");
const { settings } = await import("./settings.js");

const send = (path, found) => heard.handler({ payload: { path, avatars: found } });
const asked = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "github_avatars").map(([, args]) => args.path);

beforeEach(() => vi.mocked(invoke).mockClear());

test("keeps the pictures of every repository open, together, and none of one never opened", () => {
  loadAvatars("/a");
  loadAvatars("/b");
  expect(asked()).toEqual(["/a", "/b"]);
  send("/a", { "ada@example.com": "https://avatars/ada" });
  send("/b", { "grace@example.com": "https://avatars/grace" });
  send("/c", { "linus@example.com": "https://avatars/linus" });
  expect(avatars).toEqual({ "ada@example.com": "https://avatars/ada", "grace@example.com": "https://avatars/grace" });
  forgetAvatars("/a");
  forgetAvatars("/b");
});

test("a repository closed takes the pictures only it had with it", () => {
  loadAvatars("/a");
  loadAvatars("/b");
  send("/a", { "ada@example.com": "https://avatars/ada", "both@example.com": "https://avatars/both" });
  send("/b", { "both@example.com": "https://avatars/both" });
  forgetAvatars("/a");
  expect(avatars).toEqual({ "both@example.com": "https://avatars/both" });
  forgetAvatars("/b");
  expect(avatars).toEqual({});
});

test("turned off, everyone shows initials; turned on again, the repositories still open are asked", async () => {
  loadAvatars("/a");
  loadAvatars("/b");
  forgetAvatars("/b");
  send("/a", { "ada@example.com": "https://avatars/ada" });
  settings.githubAvatars = false;
  await nextTick();
  expect(avatars).toEqual({});
  // Off, nothing's asked for or kept.
  vi.mocked(invoke).mockClear();
  loadAvatars("/a");
  send("/a", { "ada@example.com": "https://avatars/ada" });
  expect(asked()).toEqual([]);
  expect(avatars).toEqual({});

  settings.githubAvatars = true;
  await nextTick();
  expect(asked()).toEqual(["/a"]);
});
