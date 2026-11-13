import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { askConfirm, openForm, openPullDialog, openTagDialog } from "./overlays.js";
import { addDivider, branchOrder, resetOrder } from "./branchOrder.js";
import { CANCELED } from "./errors.js";
import { draftFor } from "./drafts.js";
import { agentCommand, setAgentCommand } from "./agents.js";
import { useGitActions } from "./gitActions.js";

// The backend answers nothing unless a test says otherwise; github.js asks it as it loads.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
// The dialogs answer as each test says.
vi.mock("./overlays.js", () => ({
  askConfirm: vi.fn(),
  openForm: vi.fn(),
  openMergeDialog: vi.fn(),
  openPullDialog: vi.fn(),
  openResetDialog: vi.fn(),
  openTagDialog: vi.fn(),
  tell: vi.fn(),
}));

// A repository's overview, with `main` checked out and nothing else unless asked for.
function repo(parts = {}) {
  return {
    path: "/code/palace",
    head: { branch: "main" },
    branches: [{ name: "main", is_head: true, upstream: "origin/main", worktree: null }],
    remotes: [{ name: "origin", url: "https://github.com/o/palace.git", branches: ["main"] }],
    tags: [],
    worktrees: [],
    operation: null,
    ...parts,
  };
}
const branch = (name, more = {}) => ({ name, is_head: false, upstream: null, worktree: null, ...more });

// The actions on `repo(parts)`, with what they run recorded. Each command succeeds
// unless `fails` says what it fails with.
function actionsOn(parts = {}, { fails = {}, agentReady = async () => true } = {}) {
  const run = vi.fn(async (_titles, command) => fails[command] ?? null);
  const openWorktree = vi.fn();
  const compare = vi.fn();
  const overview = ref(repo(parts));
  const actions = useGitActions({ overview, run, compare, openWorktree, agentReady, pullRequest: { available: () => false } });
  // Each command run, as [command, args].
  const ran = () => run.mock.calls.map(([, command, args]) => [command, args]);
  return { actions, run, ran, openWorktree, compare, overview };
}

// A menu's items by label, leaving out what it doesn't show.
const menuItems = (menu) => menu.filter((item) => item && !item.separator);
const labels = (menu) => menuItems(menu).map((item) => item.label);
const item = (menu, label) => menuItems(menu).find((i) => i.label === label);

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
  vi.mocked(askConfirm).mockReset();
  vi.mocked(openForm).mockReset();
  vi.mocked(openPullDialog).mockReset();
});

// The branches' arrangement is kept for all of Palace, so each test's goes.
afterEach(() => resetOrder("/code/palace"));

describe("a branch's menu", () => {
  test("for the current branch, offers neither merging it into itself nor deleting it", () => {
    const { actions } = actionsOn();
    const menu = actions.branchMenu("main");
    expect(item(menu, "Check Out").disabled).toBe(true);
    expect(labels(menu).some((l) => l.startsWith("Merge") || l.startsWith("Rebase"))).toBe(false);
    expect(item(menu, "Delete…").disabled).toBe(true);
    // Its upstream can be compared with and force pushed to.
    expect(labels(menu)).toContain("Compare “main” with “origin/main”");
    expect(labels(menu)).toContain("Force Push…");
  });

  test("for another, merges or rebases with the current one, except mid-operation", () => {
    const { actions } = actionsOn({ branches: [branch("main", { is_head: true }), branch("feature")] });
    const menu = actions.branchMenu("feature");
    expect(item(menu, "Merge “feature” into “main”…").disabled).toBe(false);
    expect(item(menu, "Rebase “main” onto “feature”…").disabled).toBe(false);
    expect(labels(menu)).toContain("New Worktree…");
    expect(item(menu, "Delete…").disabled).toBe(false);

    const busy = actionsOn({ branches: [branch("main", { is_head: true }), branch("feature")], operation: "rebase" });
    expect(item(busy.actions.branchMenu("feature"), "Merge “feature” into “main”…").disabled).toBe(true);
  });

  test("for one checked out in another worktree, opens that instead, and can't delete it", () => {
    const { actions, openWorktree } = actionsOn({
      branches: [branch("main", { is_head: true }), branch("feature", { worktree: "/code/palace-feature" })],
    });
    const menu = actions.branchMenu("feature");
    expect(labels(menu)).not.toContain("Check Out");
    expect(labels(menu)).not.toContain("New Worktree…");
    expect(item(menu, "Delete…").disabled).toBe(true);
    item(menu, "Open Worktree “palace-feature”").action();
    expect(openWorktree).toHaveBeenCalledWith("/code/palace-feature");
  });

  test("offers to publish a branch without an upstream, where there's a remote to", () => {
    const parts = { branches: [branch("main", { is_head: true }), branch("draft")] };
    expect(item(actionsOn(parts).actions.branchMenu("draft"), "Publish “draft”…").disabled).toBe(false);
    expect(item(actionsOn({ ...parts, remotes: [] }).actions.branchMenu("draft"), "Publish “draft”…").disabled).toBe(true);
  });

  test("adds dividers only beside top-level branches", () => {
    const { actions } = actionsOn({ branches: [branch("main", { is_head: true }), branch("feature/a")] });
    expect(labels(actions.branchMenu("main"))).toContain("Add Divider Below…");
    expect(labels(actions.branchMenu("feature/a"))).not.toContain("Add Divider Below…");
  });
});

describe("deleting a branch", () => {
  const parts = { branches: [branch("main", { is_head: true }), branch("feature")] };

  test("asks first, then deletes it", async () => {
    const { actions, ran } = actionsOn(parts);
    vi.mocked(askConfirm).mockResolvedValue(true);
    await item(actions.branchMenu("feature"), "Delete…").action();
    expect(ran()).toEqual([["delete_branch", { name: "feature", force: false }]]);
  });

  test("asks again before deleting one with commits merged nowhere, and forces it only then", async () => {
    const { actions, ran } = actionsOn(parts, { fails: { delete_branch: "error: the branch 'feature' is not fully merged" } });
    vi.mocked(askConfirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await item(actions.branchMenu("feature"), "Delete…").action();
    // Said not to: only the first, unforced try.
    expect(ran()).toEqual([["delete_branch", { name: "feature", force: false }]]);
    expect(vi.mocked(askConfirm).mock.calls[1][0].title).toBe("Delete Unmerged Branch?");

    vi.mocked(askConfirm).mockResolvedValue(true);
    const again = actionsOn(parts, { fails: { delete_branch: "error: the branch 'feature' is not fully merged" } });
    await item(again.actions.branchMenu("feature"), "Delete…").action();
    expect(again.ran().at(-1)).toEqual(["delete_branch", { name: "feature", force: true }]);
  });

  test("doesn't force it once another repository's opened in the tab while it asked", async () => {
    const { actions, ran, overview } = actionsOn(parts, { fails: { delete_branch: "error: the branch 'feature' is not fully merged" } });
    vi.mocked(askConfirm)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        overview.value = { ...overview.value, path: "/code/other" };
        return true;
      });
    await item(actions.branchMenu("feature"), "Delete…").action();
    expect(ran()).toEqual([["delete_branch", { name: "feature", force: false }]]);
  });

  test("does nothing when canceled", async () => {
    const { actions, run } = actionsOn(parts);
    vi.mocked(askConfirm).mockResolvedValue(false);
    await item(actions.branchMenu("feature"), "Delete…").action();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("once another repository's opened in the tab as an operation runs", () => {
  // The actions, with `command` opening another repository as it runs.
  function switchedDuring(command, parts = {}) {
    const on = actionsOn(parts);
    on.run.mockImplementation(async (_titles, ran) => {
      if (ran === command) on.overview.value = repo({ path: "/code/other" });
      return null;
    });
    return on;
  }

  test("what was to follow on a remote isn't done there", async () => {
    const tag = switchedDuring("delete_tag");
    vi.mocked(openForm).mockResolvedValue({ remote: true });
    await item(tag.actions.tagMenu("v1.0"), "Delete…").action();
    expect(tag.ran()).toEqual([["delete_tag", { name: "v1.0" }]]);

    const created = switchedDuring("create_tag");
    vi.mocked(openTagDialog).mockResolvedValue({ name: "v2.0", revision: "HEAD", message: "", push: true });
    await item(created.actions.sectionMenu("tags"), "Create New Tag…").action();
    expect(created.ran().map(([command]) => command)).toEqual(["create_tag"]);

    const branched = switchedDuring("create_branch");
    vi.mocked(openForm).mockResolvedValue({ name: "feature", checkout: false, publish: true });
    await branched.actions.newBranch();
    expect(branched.ran().map(([command]) => command)).toEqual(["create_branch"]);
  });

  test("the branches' arrangement changes in the repository it ran in", async () => {
    const { actions } = switchedDuring("delete_merged_branch");
    addDivider("/code/palace", "", null, ["branch:feature"]);
    addDivider("/code/other", "", null, ["branch:feature"]);
    await actions.deleteMergedBranch("feature", "abc123");
    expect(branchOrder("/code/palace")).not.toContain("branch:feature");
    expect(branchOrder("/code/other")).toContain("branch:feature");
  });
});

describe("checking out", () => {
  test("from a detached HEAD at commits nothing else has, asks first", async () => {
    const { actions, run } = actionsOn({ head: { branch: null }, branches: [branch("main")] });
    vi.mocked(invoke).mockResolvedValue(2);
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await actions.checkout("branch", "main")).toBe(CANCELED);
    expect(vi.mocked(askConfirm).mock.calls[0][0].message).toContain("2 commits that no branch or tag has");
    expect(run).not.toHaveBeenCalled();
  });

  test("from a branch, just checks out", async () => {
    const { actions, ran } = actionsOn();
    await actions.checkout("tag", "v1.0");
    expect(askConfirm).not.toHaveBeenCalled();
    expect(ran()).toEqual([["checkout", { kind: "tag", name: "v1.0" }]]);
  });
});

describe("pushing", () => {
  test("pushes a branch that has an upstream", async () => {
    const { actions, ran } = actionsOn();
    await actions.push();
    expect(ran()).toEqual([["push", undefined]]);
  });

  test("publishes one that hasn't, under the name chosen", async () => {
    const { actions, ran } = actionsOn({ head: { branch: "draft" }, branches: [branch("draft", { is_head: true })] });
    vi.mocked(openForm).mockResolvedValue({ name: " draft-2 " });
    await actions.push();
    expect(ran()).toEqual([["publish_branch", { branch: "draft", remote: "origin", name: "draft-2" }]]);
  });
});

describe("pulling", () => {
  test("with nothing to choose from, leaves it to the backend to say why", async () => {
    const { actions, ran } = actionsOn({ head: { branch: null }, branches: [] });
    await actions.pull();
    expect(openPullDialog).not.toHaveBeenCalled();
    expect(ran()).toEqual([["pull", undefined]]);
  });

  test("offers the branch asked for, or else the upstream", async () => {
    const { actions } = actionsOn({ remotes: [{ name: "origin", branches: ["main", "next"] }] });
    vi.mocked(invoke).mockResolvedValue("merge");
    vi.mocked(openPullDialog).mockResolvedValue(null);
    await actions.pull();
    expect(vi.mocked(openPullDialog).mock.calls[0][0].from).toBe("origin/main");
    await actions.pull("origin/next");
    expect(vi.mocked(openPullDialog).mock.calls[1][0].from).toBe("origin/next");
  });
});

describe("worktrees", () => {
  // As the backend lists them (see worktree.rs), every field there.
  const worktree = (path, more = {}) => ({ path, branch: null, main: false, current: false, locked: false, prunable: false, ...more });
  const main = worktree("/code/palace", { branch: "main", main: true, current: true });

  test("a new one goes beside the repository, named after it and the branch, and opens", async () => {
    const { actions, ran, openWorktree } = actionsOn({ worktrees: [main] });
    vi.mocked(openForm).mockResolvedValue({ name: " feature/login ", location: "/code/", open: true });
    await actions.newWorktree();
    expect(vi.mocked(openForm).mock.calls[0][0].fields.find((f) => f.key === "location").value).toBe("/code");
    expect(ran()).toEqual([
      ["add_worktree", { folder: "/code/palace-feature-login", branch: "main", create: "feature/login", remote: false }],
    ]);
    expect(openWorktree).toHaveBeenCalledWith("/code/palace-feature-login");
  });

  test("one for a remote branch with a local branch of its name uses the local one", async () => {
    const { actions, ran } = actionsOn({ worktrees: [main], branches: [branch("main", { is_head: true }), branch("next")] });
    vi.mocked(openForm).mockResolvedValue({ location: "/code", open: false });
    await actions.newWorktree({ branch: "origin/next", remote: true });
    expect(ran()).toEqual([["add_worktree", { folder: "/code/palace-next", branch: "next", create: null, remote: false }]]);
  });

  test("removing one open in a tab says what stops there, and closes it", async () => {
    const other = worktree("/code/palace-feature", { branch: "feature" });
    const { actions, ran } = actionsOn({ worktrees: [main, other] });
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "worktree_has_changes" ? false : { open: true, programs: ["claude"], edits: [] },
    );
    vi.mocked(askConfirm).mockResolvedValue(true);
    await item(actions.worktreeMenu(other.path), "Remove…").action();
    const asked = vi.mocked(askConfirm).mock.calls[0][0];
    expect(asked.message).toContain("It's open in a tab, which closes. Claude is still running in a terminal there, and is stopped.");
    expect(asked.confirmLabel).toBe("Remove and Stop");
    expect(ran()).toEqual([["remove_worktree", { worktree: other.path, close: true, force: false }]]);
  });

  test("removing one a tab showed before says its terminals there stop, and the tab stays", async () => {
    const other = worktree("/code/palace-feature", { branch: "feature" });
    const { actions, ran } = actionsOn({ worktrees: [main, other] });
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "worktree_has_changes" ? false : { open: false, programs: ["npm"], edits: [] },
    );
    vi.mocked(askConfirm).mockResolvedValue(true);
    await item(actions.worktreeMenu(other.path), "Remove…").action();
    const asked = vi.mocked(askConfirm).mock.calls[0][0];
    expect(asked.message).toContain("A tab showed it before, and still has its terminals. “npm” is still running in a terminal there, and is stopped.");
    expect(ran()).toEqual([["remove_worktree", { worktree: other.path, close: true, force: false }]]);
  });

  test("removing one forgets the agent command New Agent Task gave it", async () => {
    const other = worktree("/code/palace-feature", { branch: "feature" });
    setAgentCommand(other.path, "codex");
    const { actions } = actionsOn({ worktrees: [main, other] });
    vi.mocked(askConfirm).mockResolvedValue(true);
    await item(actions.worktreeMenu(other.path), "Remove…").action();
    expect(agentCommand(other.path)).not.toBe("codex");
  });

  test("removing one with changes forces it, once that's been said", async () => {
    const other = worktree("/code/palace-feature", { branch: "feature" });
    const { actions, ran } = actionsOn({ worktrees: [main, other] });
    vi.mocked(invoke).mockImplementation(async (command) => (command === "worktree_has_changes" ? true : null));
    vi.mocked(askConfirm).mockResolvedValue(true);
    await item(actions.worktreeMenu(other.path), "Remove…").action();
    expect(vi.mocked(askConfirm).mock.calls[0][0].confirmLabel).toBe("Remove and Lose Changes");
    expect(ran()).toEqual([["remove_worktree", { worktree: other.path, close: false, force: true }]]);
  });

  test("the repository's own, and the one showing, can't be removed", () => {
    const other = worktree("/code/palace-feature", { branch: "feature", current: true });
    const { actions } = actionsOn({ worktrees: [{ ...main, current: false }, other] });
    expect(labels(actions.worktreeMenu(main.path))).not.toContain("Remove…");
    expect(item(actions.worktreeMenu(other.path), "Remove…").disabled).toBe(true);
  });

  test("arranges the repository's branches from any of its worktrees alike", async () => {
    const other = worktree("/code/palace-feature", { branch: "feature", current: true });
    const { actions } = actionsOn({ path: other.path, worktrees: [{ ...main, current: false }, other] });
    vi.mocked(openForm).mockResolvedValue({ label: "" });
    await item(actions.branchMenu("main"), "Add Divider Below…").action();
    expect(branchOrder("/code/palace")).toEqual(["branch:main", expect.stringMatching(/^branch-divider:/)]);
    expect(branchOrder(other.path)).toEqual([]);
  });

  test("Prune shows only when a worktree's folder is gone", () => {
    const gone = worktree("/code/palace-old", { prunable: true });
    expect(labels(actionsOn({ worktrees: [main] }).actions.sectionMenu("worktrees"))).not.toContain("Prune Worktrees");
    expect(labels(actionsOn({ worktrees: [main, gone] }).actions.sectionMenu("worktrees"))).toContain("Prune Worktrees");
  });
});

describe("a new task", () => {
  const main = { path: "/code/palace", branch: "main", main: true, current: true, locked: false, prunable: false };

  test("starts on a branch named after it, beside the repository, in a window of its own", async () => {
    const { actions, ran, openWorktree } = actionsOn({ worktrees: [main], branches: [branch("main", { is_head: true }), branch("fix-the-login-bug")] });
    vi.mocked(openForm).mockResolvedValue({ task: " Fix the login bug ", name: "", location: "/code" });
    await actions.newTask();
    expect(ran()).toEqual([
      ["add_worktree", { folder: "/code/palace-fix-the-login-bug-2", branch: "main", create: "fix-the-login-bug-2", remote: false }],
    ]);
    expect(openWorktree).toHaveBeenCalledWith("/code/palace-fix-the-login-bug-2", { task: "Fix the login bug" });
  });

  test("takes the branch name given", async () => {
    const { actions, ran } = actionsOn({ worktrees: [main] });
    vi.mocked(openForm).mockResolvedValue({ task: "Anything", name: " feature/search ", location: "/code" });
    await actions.newTask();
    expect(ran()[0][1]).toMatchObject({ folder: "/code/palace-feature-search", create: "feature/search" });
  });

  test("starts nothing when canceled, or when the worktree couldn't be made", async () => {
    const { actions, run, openWorktree } = actionsOn({ worktrees: [main] });
    vi.mocked(openForm).mockResolvedValue(null);
    await actions.newTask();
    expect(run).not.toHaveBeenCalled();

    const failing = actionsOn({ worktrees: [main] }, { fails: { add_worktree: "fatal: already exists" } });
    vi.mocked(openForm).mockResolvedValue({ task: "Anything", name: "", location: "/code" });
    await failing.actions.newTask();
    expect(failing.openWorktree).not.toHaveBeenCalled();
    expect(openWorktree).not.toHaveBeenCalled();
    // What was typed waits for the next try.
    expect(draftFor(`new-task:${repo().path}`)).toMatchObject({ task: "Anything" });
  });

  test("asks nothing, and makes nothing, when the agent can't start", async () => {
    const { actions, run } = actionsOn({ worktrees: [main] }, { agentReady: async () => false });
    await actions.newTask();
    expect(openForm).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test("gives the worktree the agent this repository runs", async () => {
    setAgentCommand(repo().path, "codex --full-auto");
    const { actions } = actionsOn({ worktrees: [main] });
    vi.mocked(openForm).mockResolvedValue({ task: "Anything", name: "agent-task", location: "/code" });
    await actions.newTask();
    expect(agentCommand("/code/palace-agent-task")).toBe("codex --full-auto");
    setAgentCommand(repo().path, "");
  });

  test("is offered in the + menu and on Worktrees", () => {
    const { actions } = actionsOn();
    expect(labels(actions.addMenu())).toContain("New Agent Task…");
    expect(labels(actions.sectionMenu("worktrees"))).toContain("New Agent Task…");
  });
});

describe("cherry-picking", () => {
  const commit = (id) => ({ id: `${id}000000`, short_id: id });

  test("picks one commit, or several, in the order given", async () => {
    const { actions, ran } = actionsOn();
    await actions.cherryPick(commit("aaa"));
    await actions.cherryPick([commit("old"), commit("new")]);
    expect(ran()).toEqual([
      ["cherry_pick", { ids: ["aaa000000"] }],
      ["cherry_pick", { ids: ["old000000", "new000000"] }],
    ]);
  });

  test("several chosen in another branch's history, oldest first, from the menu", async () => {
    const { actions, ran } = actionsOn();
    // As the history lists them: newest first.
    const entries = [{ commit: commit("new"), index: 0 }, { commit: commit("old"), index: 1 }];
    const menu = actions.commitsMenu(entries, false, true);
    await item(menu, "Cherry-Pick 2 Commits into “main”").action();
    expect(ran()).toEqual([["cherry_pick", { ids: ["old000000", "new000000"] }]]);
    // Not in the current branch's own history, where they're already.
    expect(labels(actions.commitsMenu(entries, true, false))).not.toContain("Cherry-Pick 2 Commits into “main”");
  });
});

test("HEAD detached, its menu makes a branch where it is, without asking about leaving it", async () => {
  const { actions, ran } = actionsOn({ head: { branch: null, short_id: "4cbad69" }, branches: [branch("main")] });
  vi.mocked(openForm).mockResolvedValue({ name: "keep-this", checkout: true, publish: false });
  await item(actions.detachedMenu(), "New Branch Here…").action();
  expect(vi.mocked(openForm).mock.calls[0][0].message).toBe("The branch will start at 4cbad69.");
  expect(askConfirm).not.toHaveBeenCalled();
  expect(ran()).toEqual([["create_branch", { name: "keep-this", start: null, checkout: true }]]);
  // Mid-rebase, which detaches HEAD as it goes, git won't switch to a new branch.
  const rebasing = actionsOn({ head: { branch: null, short_id: "4cbad69" }, operation: "rebase" }).actions;
  expect(item(rebasing.detachedMenu(), "New Branch Here…").disabled).toBe(true);
});

test("a commit's menu resets the branch whose history is shown, and only rewrites what can be", () => {
  const commit = { id: "abc1234def", short_id: "abc1234" };
  const { actions } = actionsOn();
  const menu = actions.commitMenu(commit, false);
  expect(labels(menu)).toContain("Reset “main” to “abc1234”…");
  expect(item(menu, "Edit Message…").disabled).toBe(true);
  expect(item(actions.commitMenu(commit, true), "Edit Message…").disabled).toBe(false);
});
