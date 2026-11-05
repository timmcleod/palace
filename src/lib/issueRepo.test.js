import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { computed, nextTick, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { githubAccount, githubAccountChecked } from "./github.js";
import { openMenu } from "./overlays.js";
import { settings } from "./settings.js";
import { mountComposable } from "../test/mount.js";
import { useIssueRepo } from "./issueRepo.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./github.js", async () => {
  const { ref } = await import("vue");
  return { githubAccount: ref(null), githubAccountChecked: ref(true) };
});
vi.mock("./overlays.js", () => ({ openMenu: vi.fn() }));
vi.mock("./settings.js", () => ({ settings: { fetchInBackground: true, fetchMinutes: 5 } }));
// Local storage, kept in memory; issues.js keeps when issues were seen there too.
const stored = vi.hoisted(() => new Map());
vi.mock("./storage.js", () => ({
  readJson: (key, fallback) => (stored.has(key) ? structuredClone(stored.get(key)) : fallback),
  writeJson: (key, value) => stored.set(key, structuredClone(value)),
}));

const remote = (name, slug) => ({ name, url: `git@github.com:${slug}.git` });

// What GitHub says, by repository ("owner/repo"): its fork parent, features, and open
// issues and pull requests.
let github;
const issuesCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "github_issues").length;

let state;
beforeEach(() => {
  vi.useFakeTimers();
  stored.clear();
  githubAccount.value = { login: "me" };
  githubAccountChecked.value = true;
  Object.assign(settings, { fetchInBackground: true, fetchMinutes: 5 });
  github = {
    "me/app": { parent: null, features: { issues: true, pulls: true }, issues: [], pulls: 2 },
  };
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, { owner, repo, pulls } = {}) => {
    const found = github[`${owner}/${repo}`];
    if (command === "github_fork_parent") return found.parent;
    if (command === "github_repo_features") return found.features;
    if (command === "github_issues") return pulls ? { total: found.pulls, issues: [] } : { total: found.issues.length, issues: found.issues };
    throw new Error(`unexpected ${command}`);
  });
  vi.mocked(openMenu).mockReset();
  state = {
    overview: ref({ path: "/app", remotes: [remote("origin", "me/app")] }),
    selected: ref("workspace:history"),
    onChange: vi.fn(),
  };
});
afterEach(() => vi.useRealTimers());

function setUp() {
  return mountComposable(() =>
    useIssueRepo({
      overview: state.overview,
      isIssues: computed(() => state.selected.value === "workspace:issues"),
      isPulls: computed(() => state.selected.value === "workspace:pulls"),
      onChange: state.onChange,
    }),
  );
}

// Lets GitHub's answers arrive.
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("which repository", () => {
  test("is origin's, once GitHub has said it isn't a fork", async () => {
    const { result } = setUp();
    expect(result.issueRepo.value).toBeNull();
    await settle();
    expect(result.issueRepo.value).toMatchObject({ owner: "me", repo: "app", remotes: ["origin"] });
  });

  test("is a fork's parent, offered beside the fork", async () => {
    github["me/app"].parent = "upstream/app";
    github["upstream/app"] = { parent: null, features: { issues: true, pulls: true }, issues: [], pulls: 0 };
    const { result } = setUp();
    await settle();
    expect(result.issueRepo.value).toMatchObject({ owner: "upstream", repo: "app", forkedFrom: { owner: "me" } });
    expect(result.issueRepos.value.map((r) => `${r.owner}/${r.repo}`)).toEqual(["me/app", "upstream/app"]);
  });

  test("is the one chosen in the menu, remembered for the repository", async () => {
    state.overview.value.remotes.push(remote("other", "someone/app"));
    github["someone/app"] = { parent: null, features: { issues: true, pulls: true }, issues: [], pulls: 0 };
    const first = setUp();
    await settle();
    first.result.issueRepoMenu({ currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) } });
    const items = vi.mocked(openMenu).mock.calls[0][1];
    expect(items.map((i) => [i.label, i.checked])).toEqual([
      ["me/app", true],
      ["someone/app", false],
    ]);
    items[1].action();
    expect(first.result.issueRepo.value).toMatchObject({ owner: "someone" });
    first.unmount();

    const again = setUp();
    await settle();
    expect(again.result.issueRepo.value).toMatchObject({ owner: "someone" });
  });

  test("isn't waited for when signed out, and the sidebar leaves the views out", async () => {
    githubAccount.value = null;
    const { result } = setUp();
    expect(result.issueRepo.value).toMatchObject({ owner: "me", repo: "app" });
    expect(result.showsIssues.value).toBe(false);
    // Until Palace knows whether it's signed in, they stay.
    githubAccountChecked.value = false;
    expect(result.showsIssues.value).toBe(true);
  });
});

describe("counts", () => {
  test("of open issues and pull requests are asked for once the repository is known", async () => {
    github["me/app"].issues = [{ created_at: "2026-01-01T00:00:00Z" }];
    const { result } = setUp();
    await settle();
    expect([result.openIssues.value, result.openPulls.value]).toEqual([1, 2]);
    expect([result.hasIssues.value, result.hasPulls.value]).toEqual([true, true]);
  });

  test("aren't asked for what the repository has turned off", async () => {
    github["me/app"].features = { issues: false, pulls: true };
    const { result } = setUp();
    await settle();
    expect(result.hasIssues.value).toBe(false);
    expect(result.openIssues.value).toBeNull();
    expect(result.openPulls.value).toBe(2);
  });

  test("follow issues opened and closed here", async () => {
    const { result } = setUp();
    await settle();
    result.countStateChange("issues", undefined, "open");
    result.countStateChange("pulls", "open", "closed");
    result.countStateChange("pulls", "open", "open");
    expect([result.openIssues.value, result.openPulls.value]).toEqual([1, 1]);
  });

  test("start over, and let go of what was chosen, for another repository", async () => {
    const { result } = setUp();
    await settle();
    expect(state.onChange).toHaveBeenCalledTimes(2); // waiting for the fork check, then found
    github["them/lib"] = { parent: null, features: { issues: true, pulls: true }, issues: [], pulls: 7 };
    state.overview.value = { path: "/lib", remotes: [remote("origin", "them/lib")] };
    await nextTick();
    expect(result.openPulls.value).toBeNull();
    await settle();
    expect(result.openPulls.value).toBe(7);
    expect(state.onChange).toHaveBeenCalledTimes(4);
  });
});

describe("new issues", () => {
  test("are those opened since the Issues view was last looked at, until it's looked at again", async () => {
    stored.set("palace.issuesSeen", { "me/app": "2026-03-01T00:00:00Z" });
    github["me/app"].issues = [{ created_at: "2026-02-01T00:00:00Z" }, { created_at: "2026-04-01T00:00:00Z" }];
    const { result } = setUp();
    await settle();
    expect(result.freshIssues.value).toBe(1);

    state.selected.value = "workspace:issues";
    await nextTick();
    expect(result.freshIssues.value).toBe(0);
    expect(result.issuesSeenBefore.value).toBe("2026-03-01T00:00:00Z");
    expect(stored.get("palace.issuesSeen")["me/app"]).not.toBe("2026-03-01T00:00:00Z");
  });

  test("start from the first check, before which nothing is new", async () => {
    github["me/app"].issues = [{ created_at: "2026-02-01T00:00:00Z" }];
    const { result } = setUp();
    await settle();
    expect(result.freshIssues.value).toBe(0);
    expect(stored.get("palace.issuesSeen")["me/app"]).toBeTruthy();
  });
});

describe("checking in the background", () => {
  test("happens as often as fetching, not while the views are showing, and stops once unmounted", async () => {
    const { unmount } = setUp();
    await settle();
    const first = issuesCalls();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(issuesCalls()).toBe(2 * first);

    state.selected.value = "workspace:pulls";
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(issuesCalls()).toBe(2 * first);

    state.selected.value = "workspace:history";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(issuesCalls()).toBe(3 * first);

    unmount();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(issuesCalls()).toBe(3 * first);
  });
});
