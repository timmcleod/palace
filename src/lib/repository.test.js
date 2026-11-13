import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { mountComposable } from "../test/mount.js";
import { NOT_A_REPOSITORY } from "./errors.js";
import { useRepository } from "./repository.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The backend, answering each command as a test says: `overviews` by path, each an
// overview or a function of the call, and which paths another window has open.
let overviews;
let openElsewhere;
let foldersGone;
beforeEach(() => {
  overviews = {};
  openElsewhere = new Set();
  foldersGone = new Set();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "repo_overview") {
      const answer = overviews[args.path];
      if (answer === undefined) throw `Couldn't open ${args.path}`;
      return typeof answer === "function" ? answer(args) : answer;
    }
    if (command === "show_window_with") return openElsewhere.has(args.path);
    if (command === "folder_exists") return !foldersGone.has(args.path);
    return null;
  });
});

// A repository's overview, as the backend gives it.
const overviewOf = (path, more = {}) => ({ path, files: [], ...more });

// An answer that waits until it's let go: `answer` is what the backend's call for it
// returns, and `release(value)` or `fail(error)` ends it.
function waiting() {
  let release, fail;
  const answer = () =>
    new Promise((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
  return { answer, release: (v) => release(v), fail: (e) => fail(e) };
}

// Every repository mounted, each unmounted after its test, so none goes on listening.
let mounted;
const allMounted = [];
// The window's repository state, Workspace.vue's, with useRepository looking after it.
function repository({ open = null, listsFiles = false } = {}) {
  const state = {
    overview: ref(open),
    loading: ref(false),
    error: ref(""),
    refreshKey: ref(0),
    listsFiles: ref(listsFiles),
    onSwitch: vi.fn(),
    onLoaded: vi.fn(),
    onNotRepository: vi.fn(),
    onOpenFailed: vi.fn(),
  };
  mounted = mountComposable(() => useRepository(state));
  allMounted.push(mounted);
  return { ...state, ...mounted.result };
}
afterEach(() => {
  for (const m of allMounted.splice(0)) m.unmount();
});

const loads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "repo_overview").length;
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("loading a repository", () => {
  test("shows its overview, loading meanwhile, and remembers it", async () => {
    overviews["/a"] = overviewOf("/a");
    const repo = repository({ listsFiles: true });
    const loading = repo.loadRepository("/a");
    expect(repo.loading.value).toBe(true);
    await loading;
    expect(repo.loading.value).toBe(false);
    expect(repo.overview.value.path).toBe("/a");
    expect(repo.error.value).toBe("");
    expect(repo.onLoaded).toHaveBeenCalledWith(overviews["/a"]);
    // The changed files too, for the view that lists them.
    expect(invoke).toHaveBeenCalledWith("repo_overview", { path: "/a", files: true });
  });

  test("says when it switches to another repository, before showing it, but not for the same one again", async () => {
    overviews["/a"] = overviewOf("/a");
    overviews["/b"] = overviewOf("/b");
    const repo = repository();
    // What was showing when it was said, checked after: an expect failing in there would
    // only fail the load.
    const showing = [];
    repo.onSwitch.mockImplementation(() => showing.push(repo.overview.value?.path ?? null));
    await repo.loadRepository("/a");
    expect(repo.onSwitch).toHaveBeenCalledOnce();
    expect(repo.onSwitch).toHaveBeenCalledWith(overviews["/a"]);

    await repo.loadRepository("/a", { quiet: true });
    expect(repo.onSwitch).toHaveBeenCalledOnce();

    await repo.loadRepository("/b");
    expect(showing).toEqual([null, "/a"]);
    expect(repo.overview.value.path).toBe("/b");
  });

  test("a newer load wins over an older one that finishes after it", async () => {
    const slow = waiting();
    overviews["/a"] = slow.answer;
    overviews["/b"] = overviewOf("/b");
    const repo = repository();
    const first = repo.loadRepository("/a");
    await repo.loadRepository("/b");
    slow.release(overviewOf("/a"));
    await first;
    expect(repo.overview.value.path).toBe("/b");
    expect(repo.onSwitch).toHaveBeenCalledOnce();
    expect(repo.loading.value).toBe(false);
  });

  test("open in another window, brings that forward instead of opening it here", async () => {
    overviews["/b"] = overviewOf("/b");
    openElsewhere.add("/b");
    const repo = repository({ open: overviewOf("/a") });
    await repo.loadRepository("/b");
    expect(repo.overview.value.path).toBe("/a");
    expect(repo.onSwitch).not.toHaveBeenCalled();
    expect(repo.loading.value).toBe(false);
  });

  test("a folder that isn't a repository is offered to be made one", async () => {
    overviews["/notes"] = () => {
      throw `${NOT_A_REPOSITORY}/notes`;
    };
    const repo = repository();
    await repo.loadRepository("/notes", { keepOnError: true });
    expect(repo.onNotRepository).toHaveBeenCalledWith("/notes", { keepOnError: true });
    expect(repo.error.value).toBe("");
  });

  test("failing, says why in place of a repository", async () => {
    const repo = repository({ open: overviewOf("/a") });
    await repo.loadRepository("/gone");
    expect(repo.overview.value).toBeNull();
    expect(repo.error.value).toBe("Couldn't open /gone: Couldn't open /gone");
  });

  test("failing with one showing that's to be kept, says so beside it", async () => {
    const repo = repository({ open: overviewOf("/a") });
    await repo.loadRepository("/gone", { keepOnError: true });
    expect(repo.overview.value.path).toBe("/a");
    expect(repo.onOpenFailed).toHaveBeenCalledWith("/gone", "Couldn't open /gone");
  });
});

describe("a background refresh", () => {
  test("that fails keeps showing what it last read", async () => {
    const repo = repository({ open: overviewOf("/a", { files: [{ path: "x" }] }) });
    await repo.loadRepository("/a", { quiet: true });
    expect(repo.overview.value.files).toEqual([{ path: "x" }]);
    expect(repo.error.value).toBe("");
    expect(repo.folderGone.value).toBe(false);
  });

  test("that fails because the folder's gone says so, until it's back", async () => {
    foldersGone.add("/a");
    const repo = repository({ open: overviewOf("/a") });
    await repo.loadRepository("/a", { quiet: true });
    expect(repo.folderGone.value).toBe(true);
    expect(repo.overview.value.path).toBe("/a");

    foldersGone.delete("/a");
    overviews["/a"] = overviewOf("/a");
    await repo.loadRepository("/a", { quiet: true });
    expect(repo.folderGone.value).toBe(false);
  });

  test("doesn't show loading", async () => {
    const slow = waiting();
    overviews["/a"] = slow.answer;
    const repo = repository({ open: overviewOf("/a") });
    const refreshing = repo.loadRepository("/a", { quiet: true });
    expect(repo.loading.value).toBe(false);
    slow.release(overviewOf("/a"));
    await refreshing;
  });
});

describe("refresh", () => {
  test("reloads the repository showing, telling the views", async () => {
    overviews["/a"] = overviewOf("/a", { changes: 1 });
    const repo = repository({ open: overviewOf("/a") });
    repo.refresh();
    await settle();
    expect(repo.refreshKey.value).toBe(1);
    expect(repo.overview.value.changes).toBe(1);
    expect(repo.loading.value).toBe(false);
  });

  test("runs one at a time: asked again meanwhile, it goes once more after", async () => {
    const first = waiting();
    overviews["/a"] = first.answer;
    const repo = repository({ open: overviewOf("/a") });
    repo.refresh();
    repo.refresh();
    repo.refresh();
    await settle();
    expect(loads()).toBe(1);

    overviews["/a"] = overviewOf("/a");
    first.release(overviewOf("/a"));
    await settle();
    expect(loads()).toBe(2);
    expect(repo.refreshKey.value).toBe(2);
  });

  test("keeps the files showing when another refresh is to follow, as they may be from before", async () => {
    const first = waiting();
    overviews["/a"] = first.answer;
    const repo = repository({ open: overviewOf("/a", { files: [{ path: "staged.txt", staged: "modified" }] }) });
    repo.refresh();
    await settle();
    // Asked again, as when files were staged meanwhile.
    repo.refresh();
    overviews["/a"] = overviewOf("/a", { files: [{ path: "staged.txt", staged: "modified" }], changes: 2 });
    first.release(overviewOf("/a", { files: [{ path: "staged.txt", unstaged: "modified" }], changes: 1 }));
    await settle();
    // The first's files waited for the second's; the rest of what it read showed.
    expect(loads()).toBe(2);
    expect(repo.overview.value.files).toEqual([{ path: "staged.txt", staged: "modified" }]);
    expect(repo.overview.value.changes).toBe(2);
  });

  test("with the folder gone, leaves the views as they were, until it's back", async () => {
    foldersGone.add("/a");
    overviews["/a"] = overviewOf("/a", { changes: 1 });
    const repo = repository({ open: overviewOf("/a") });
    repo.refresh();
    await settle();
    expect(repo.folderGone.value).toBe(true);
    // Neither read again nor told to read theirs.
    expect(loads()).toBe(0);
    expect(repo.refreshKey.value).toBe(0);

    foldersGone.delete("/a");
    repo.refresh();
    await settle();
    expect(repo.folderGone.value).toBe(false);
    expect(repo.refreshKey.value).toBe(1);
    expect(repo.overview.value.changes).toBe(1);
  });

  test("waits while a repository that was chosen is still opening, and needs one showing", async () => {
    const opening = waiting();
    overviews["/b"] = opening.answer;
    const repo = repository({ open: overviewOf("/a") });
    const choosing = repo.loadRepository("/b");
    repo.refresh();
    expect(loads()).toBe(1);
    opening.release(overviewOf("/b"));
    await choosing;

    const empty = repository();
    empty.refresh();
    expect(empty.refreshKey.value).toBe(0);
  });

  test("already under way as a repository is chosen, as when the folder picker closes, doesn't win over it", async () => {
    // The window comes forward as the picker closes, so a refresh can start, and be
    // waiting to hear whether the folder's there, before the chosen one starts opening.
    let exists;
    const backend = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((command, args) =>
      command === "folder_exists" ? new Promise((resolve) => (exists = resolve)) : backend(command, args),
    );
    overviews["/a"] = overviewOf("/a");
    const opening = waiting();
    overviews["/b"] = opening.answer;
    const repo = repository({ open: overviewOf("/a") });
    repo.refresh();
    const choosing = repo.loadRepository("/b", { keepOnError: true });
    exists(true);
    await settle();
    opening.release(overviewOf("/b"));
    await choosing;
    await settle();
    expect(repo.overview.value.path).toBe("/b");
    expect(repo.refreshKey.value).toBe(0);
  });

  test("already under way as a repository chosen opens, all before it hears back, doesn't win over it", async () => {
    // The chosen one opens before the refresh hears whether its folder's there, as on a
    // slow drive: it mustn't reload the one it started with, nor say that one's gone.
    let exists;
    const backend = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((command, args) =>
      command === "folder_exists" ? new Promise((resolve) => (exists = resolve)) : backend(command, args),
    );
    overviews["/a"] = overviewOf("/a");
    overviews["/b"] = overviewOf("/b");
    const repo = repository({ open: overviewOf("/a") });
    repo.refresh();
    await repo.loadRepository("/b", { keepOnError: true });
    expect(repo.overview.value.path).toBe("/b");
    exists(false);
    await settle();
    expect(repo.overview.value.path).toBe("/b");
    expect(repo.folderGone.value).toBe(false);
    expect(repo.refreshKey.value).toBe(0);
  });

  test("happens when the window comes forward, until the page goes", async () => {
    overviews["/a"] = overviewOf("/a");
    const repo = repository({ open: overviewOf("/a") });
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(loads()).toBe(1);
    allMounted.pop().unmount();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(loads()).toBe(1);
    expect(repo.refreshKey.value).toBe(1);
  });
});
