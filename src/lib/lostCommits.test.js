import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { mountComposable } from "../test/mount.js";
import { branchChanges, describeLost, restoredName, useLostCommits } from "./lostCommits.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const branch = (name, tip) => ({ name, tip });
const overviewOf = (branches, path = "/repo") => ({ path, branches });

describe("branchChanges", () => {
  test("lists the branches that moved or went, and only those", () => {
    const before = [branch("main", "c3"), branch("feature", "f1"), branch("old", "o1"), branch("empty", null)];
    const after = [branch("main", "c1"), branch("feature", "f1"), branch("new", "n1"), branch("empty", null)];
    expect(branchChanges(before, after)).toEqual([
      { name: "main", old: "c3", new: "c1" },
      { name: "old", old: "o1", new: null },
    ]);
  });
});

describe("describeLost", () => {
  test("says which branch, how, and how many", () => {
    expect(describeLost([{ name: "main", new: "c1", count: 2 }]).title).toBe("“main” moved back, leaving 2 commits on no branch");
    expect(describeLost([{ name: "spike", new: null, count: 1 }]).title).toBe("“spike” was deleted, with a commit on no other branch");
    expect(describeLost([{ name: "main", new: "c1", count: 1000 }]).title).toContain("a thousand or more commits");
  });

  test("lists each, for several at once", () => {
    const { title, message } = describeLost([
      { name: "main", new: "c1", count: 2 },
      { name: "spike", new: null, count: 1 },
    ]);
    expect(title).toBe("2 branches lost commits");
    expect(message).toContain("“main” moved back, leaving 2 commits.");
    expect(message).toContain("“spike” was deleted, with a commit.");
  });
});

test("a restored branch is named after the one that lost it, not a name that's taken", () => {
  expect(restoredName("main", new Set(["main"]))).toBe("main-restored");
  expect(restoredName("main", new Set(["main-restored", "main-restored-2"]))).toBe("main-restored-3");
});

describe("watching for lost commits", () => {
  let mounted;
  // The window's repository, its reads, its operations and what's said, stood in for.
  // The backend counts 2 commits left behind for any branch asked about.
  function watching(branches) {
    let reads = 1;
    const overview = ref({ ...overviewOf(branches), readAt: reads });
    const busy = ref(false);
    const show = vi.fn();
    const run = vi.fn(async () => null);
    mounted = mountComposable(() => useLostCommits({ overview, loadsStarted: () => reads, busy: () => busy.value, show, run }));
    // A read starting now, to land later with these branches.
    const read = () => {
      const readAt = ++reads;
      return (branches, path = "/repo") => (overview.value = { ...overviewOf(branches, path), readAt });
    };
    // A read that starts and lands at once.
    const refresh = (branches, path) => read()(branches, path);
    return { overview, busy, show, run, read, refresh };
  }
  const settle = async () => {
    for (let i = 0; i < 8; i++) await nextTick();
  };

  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockImplementation(async (command) => (command === "commits_left_behind" ? 2 : null));
  });
  afterEach(() => mounted?.unmount());

  test("says when a branch moves back outside the window, and restores its commits as a branch", async () => {
    const { refresh, show, run } = watching([branch("main", "c3")]);
    refresh([branch("main", "c1")]);
    await settle();
    expect(invoke).toHaveBeenCalledWith("commits_left_behind", { path: "/repo", old: "c3", new: "c1" });
    const card = show.mock.calls[0][0];
    expect(card).toMatchObject({ title: "“main” moved back, leaving 2 commits on no branch", state: "conflict" });

    await card.actions[0].run();
    expect(run).toHaveBeenCalledWith(expect.any(Array), "create_branch", { name: "main-restored", start: "c3", checkout: false });
  });

  test("says nothing when nothing was left behind, as for a rewrite", async () => {
    vi.mocked(invoke).mockResolvedValue(0);
    const { refresh, show } = watching([branch("main", "c3")]);
    refresh([branch("main", "c4")]);
    await settle();
    expect(show).not.toHaveBeenCalled();
  });

  test("never takes the window's own operation for a loss, even with a read from during it landing after", async () => {
    const { busy, read, refresh, show } = watching([branch("main", "c3")]);
    busy.value = true;
    await settle();
    // Read while the operation (a reset to c1) ran, and landing after it's done.
    const slow = read();
    busy.value = false;
    await settle();
    slow([branch("main", "c3")]);
    await settle();
    // Then the read after it, with the reset, and one after that.
    refresh([branch("main", "c1")]);
    await settle();
    refresh([branch("main", "c1")]);
    await settle();
    expect(show).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();

    // After that, it watches again.
    refresh([branch("main", "c0")]);
    await settle();
    expect(show).toHaveBeenCalledOnce();
  });

  test("keeps what it finds while an operation runs until it's done, rather than take its card's place", async () => {
    let answer;
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { busy, refresh, show } = watching([branch("main", "c3")]);
    refresh([branch("main", "c1")]);
    await settle();
    busy.value = true;
    answer(2);
    await settle();
    expect(show).not.toHaveBeenCalled();
    busy.value = false;
    await settle();
    expect(show).toHaveBeenCalledOnce();
  });

  test("checks each change in turn, so a loss isn't missed for the next", async () => {
    // The backend slow to answer: the second change comes while the first's checked.
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(2), 5)));
    const { refresh, show } = watching([branch("main", "c3"), branch("spike", "s2")]);
    refresh([branch("main", "c1"), branch("spike", "s2")]);
    await settle();
    refresh([branch("main", "c1")]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(show.mock.calls.map(([card]) => card.title)).toEqual([
      "“main” moved back, leaving 2 commits on no branch",
      "“spike” was deleted, with 2 commits on no other branch",
    ]);
  });

  test("doesn't compare one repository with another", async () => {
    const { refresh, show } = watching([branch("main", "c3")]);
    refresh([branch("main", "x1")], "/other");
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });
});
