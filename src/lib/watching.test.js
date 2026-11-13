import { beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useWatching } from "./watching.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The backend's answers to watch_repo, given as each test says.
let watched;
beforeEach(() => {
  watched = [];
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation((command) => (command === "watch_repo" ? new Promise((resolve) => watched.push(resolve)) : Promise.resolve()));
});
const released = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "release_repo").map(([, args]) => args.path);
const settle = () => new Promise((resolve) => setTimeout(resolve));

test("lets go of a repository once it's been watched", async () => {
  const w = useWatching({ shownElsewhere: () => false });
  w.watch("/a");
  w.letGo("/a");
  await settle();
  expect(released()).toEqual([]);
  watched[0]();
  await settle();
  expect(released()).toEqual(["/a"]);
});

test("doesn't let go of one that's come to show again meanwhile, here or in another tab", async () => {
  const back = useWatching({ shownElsewhere: () => false });
  back.watch("/a");
  back.letGo("/a");
  back.watch("/a");
  watched[0]();
  await settle();
  expect(released()).toEqual([]);

  let elsewhere = false;
  const other = useWatching({ shownElsewhere: () => elsewhere });
  other.watch("/b");
  other.letGo("/b");
  elsewhere = true;
  watched[2]();
  await settle();
  expect(released()).toEqual([]);
});
