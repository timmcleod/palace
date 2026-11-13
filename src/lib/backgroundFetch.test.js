import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { loadAvatars } from "./avatars.js";
import { settings } from "./settings.js";
import { mountComposable } from "../test/mount.js";
import { useBackgroundFetch } from "./backgroundFetch.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./avatars.js", () => ({ loadAvatars: vi.fn() }));
vi.mock("./settings.js", () => ({ settings: { fetchInBackground: true, fetchMinutes: 5 } }));
vi.mock("./platform.js", () => ({ shortcut: (keys) => keys }));

// The fetch under way, which the test finishes; canceling finishes it too.
let finishFetch;
const fetches = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "fetch_in_background").length;

let state;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(settings, { fetchInBackground: true, fetchMinutes: 5 });
  vi.mocked(loadAvatars).mockReset();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "fetch_in_background") return new Promise((resolve) => (finishFetch = resolve));
    if (command === "cancel_remote") finishFetch?.();
  });
  state = { overview: ref(null), busy: false, loading: false, refresh: vi.fn() };
});
afterEach(() => vi.useRealTimers());

function setUp() {
  return mountComposable(() =>
    useBackgroundFetch({
      overview: state.overview,
      busy: () => state.busy,
      loading: () => state.loading,
      refresh: state.refresh,
    }),
  );
}

// Opens a repository and waits out the first fetch.
async function open() {
  state.overview.value = { path: "/repo", remotes: [{}] };
  await nextTick();
  await vi.advanceTimersByTimeAsync(3000);
  finishFetch();
  await vi.advanceTimersByTimeAsync(0);
}

describe("useBackgroundFetch", () => {
  test("fetches a repository 3 seconds after it opens, then reloads it", async () => {
    const { result } = setUp();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches()).toBe(0);
    expect(result.fetchTitle.value).toBe("Fetch from all remotes (Ctrl+R)");

    state.overview.value = { path: "/repo", remotes: [{}] };
    await nextTick();
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetches()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetches()).toBe(1);
    finishFetch();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(loadAvatars).toHaveBeenCalledWith("/repo");
    expect(result.fetchTitle.value).toBe("Fetch from all remotes (Ctrl+R), last fetched just now");
  });

  test("fetches again once it's due, and says how long ago the last was", async () => {
    const { result } = setUp();
    await open();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fetches()).toBe(1);
    expect(result.fetchTitle.value).toBe("Fetch from all remotes (Ctrl+R), last fetched 3 minutes ago");
    // Due 5 minutes after the last ended, at 5:03, and checked every 30 seconds: at 5:30.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches()).toBe(2);
  });

  test("waits while the user's operation runs or a repository loads", async () => {
    setUp();
    await open();
    state.busy = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    state.busy = false;
    state.loading = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches()).toBe(1);
    state.loading = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches()).toBe(2);
  });

  test("stop cancels a fetch under way, in the repository it's fetching, and waits for it", async () => {
    const { result } = setUp();
    state.overview.value = { path: "/repo", remotes: [{}] };
    await nextTick();
    await vi.advanceTimersByTimeAsync(3000);
    await result.stop();
    expect(invoke).toHaveBeenCalledWith("cancel_remote", { path: "/repo" });
    // With nothing under way, it returns at once.
    vi.mocked(invoke).mockClear();
    await result.stop();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("the user's own fetch puts off the next", async () => {
    const { result } = setUp();
    await open();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    result.markFetched("/repo");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fetches()).toBe(1);
  });

  test("turned off in Settings, it doesn't fetch", async () => {
    settings.fetchInBackground = false;
    setUp();
    state.overview.value = { path: "/repo", remotes: [{}] };
    await nextTick();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetches()).toBe(0);
  });

  test("stops checking once unmounted", async () => {
    const { unmount } = setUp();
    await open();
    unmount();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetches()).toBe(1);
  });
});
