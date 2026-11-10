import { describe, expect, test } from "vitest";
import { OLDER_TAGS, RECENT_TAGS, sidebarSections } from "./sidebarRows.js";

// A repository's overview, as the backend gives it, with only what's asked for.
function overview(parts = {}) {
  return {
    path: "/repo",
    changes: 0,
    branches: [],
    tags: [],
    remotes: [],
    stashes: [],
    submodules: [],
    worktrees: [],
    ...parts,
  };
}
const branch = (name, more = {}) => ({ name, is_head: false, ahead: 0, behind: 0, upstream: null, worktree: null, ...more });

const section = (sections, id) => sections.find((s) => s.id === id);
const keys = (sections, id) => section(sections, id)?.rows.map((r) => r.key);
// Tags, newest first, as the backend sorts them: v20, v19, … v1.
const tags = (count) => Array.from({ length: count }, (_, i) => `v${count - i}`);

describe("sidebarSections", () => {
  test("lists the sections in order, leaving out empty worktrees, stashes and submodules", () => {
    expect(sidebarSections(overview(), {}).map((s) => s.id)).toEqual(["workspace", "branches", "tags", "remotes"]);
    const full = overview({
      worktrees: [{ path: "/repo", branch: "main", main: true, current: true }],
      stashes: [{ index: 0, message: "WIP on main" }],
      submodules: [{ name: "vendor", path: "vendor" }],
    });
    expect(sidebarSections(full, {}).map((s) => s.id)).toEqual([
      "workspace",
      "branches",
      "worktrees",
      "tags",
      "remotes",
      "stashes",
      "submodules",
    ]);
  });

  test("counts changes and stashes in Workspace, and shows Issues and Pull Requests only when given", () => {
    const sections = sidebarSections(overview({ changes: 3, stashes: [{ index: 0, message: "a" }] }), {});
    const rows = section(sections, "workspace").rows;
    expect(rows.map((r) => r.key)).toEqual(["workspace:files", "workspace:working-copy", "workspace:stashes"]);
    expect(rows[1].count).toBe(3);
    expect(rows[2].count).toBe(1);

    const github = section(sidebarSections(overview(), { issues: { count: 4, fresh: 2 }, pulls: { count: 0 } }), "workspace").rows;
    const issues = github.find((r) => r.key === "workspace:issues");
    expect(issues).toMatchObject({ count: 4, fresh: true, title: "2 new since you last looked" });
    // None open: no count, but the row's there.
    expect(github.find((r) => r.key === "workspace:pulls").count).toBeNull();
  });

  test("puts branches with slashes in folders, which close", () => {
    const repo = overview({ branches: [branch("main", { is_head: true }), branch("feature/a"), branch("feature/b")] });
    expect(keys(sidebarSections(repo, {}), "branches")).toEqual([
      "branch-folder:feature/",
      "branch:feature/a",
      "branch:feature/b",
      "branch:main",
    ]);
    const closed = sidebarSections(repo, { collapsed: new Set(["branch-folder:feature/"]) });
    expect(keys(closed, "branches")).toEqual(["branch-folder:feature/", "branch:main"]);
    expect(section(closed, "branches").rows[1]).toMatchObject({ head: true, current: true });
  });

  test("lists branches in the order they were dragged into, with their dividers, but not while filtering", () => {
    const repo = overview({ branches: [branch("a"), branch("b"), branch("c")] });
    const view = {
      order: ["branch:c", "branch-divider:1", "branch:a"],
      dividers: [{ key: "branch-divider:1", divider: true, label: "Done" }],
    };
    expect(keys(sidebarSections(repo, view), "branches")).toEqual(["branch:c", "branch-divider:1", "branch:a", "branch:b"]);
    expect(keys(sidebarSections(repo, { ...view, query: "a" }), "branches")).toEqual(["branch:a"]);
  });

  test("filters every section, opening the folders matches are in", () => {
    const repo = overview({
      branches: [branch("main"), branch("feature/login")],
      tags: ["v2", "v1"],
      remotes: [{ name: "origin", url: "git@example.com:o/r.git", branches: ["main", "feature/login"] }],
      stashes: [{ index: 0, message: "login form" }],
    });
    const sections = sidebarSections(repo, { query: "login", collapsed: new Set(["branch-folder:feature/", "remote:origin/"]) });
    expect(keys(sections, "branches")).toEqual(["branch-folder:feature/", "branch:feature/login"]);
    expect(keys(sections, "tags")).toEqual([]);
    expect(keys(sections, "remotes")).toEqual(["remote:origin/", "remote:origin/feature/", "remote-branch:origin/feature/login"]);
    expect(keys(sections, "stashes")).toEqual(["stash:0"]);
  });

  test("leaves out a remote with nothing matching the filter, but keeps one whose name does", () => {
    const repo = overview({ remotes: [{ name: "origin", branches: ["main"] }, { name: "upstream", branches: ["main"] }] });
    expect(keys(sidebarSections(repo, { query: "upstream" }), "remotes")).toEqual(["remote:upstream/"]);
  });

  describe("tags", () => {
    test("show all of them when there are only a few more than the newest", () => {
      const rows = section(sidebarSections(overview({ tags: tags(RECENT_TAGS + 2) }), {}), "tags").rows;
      expect(rows.map((r) => r.key)).toEqual(tags(RECENT_TAGS + 2).map((t) => `tag:${t}`));
    });

    test("keep all but the newest in Older, closed until it's opened, counting them", () => {
      const repo = overview({ tags: tags(20) });
      const closed = section(sidebarSections(repo, {}), "tags").rows;
      expect(closed.map((r) => r.key)).toEqual(["tag:v20", "tag:v19", "tag:v18", "tag:v17", "tag:v16", OLDER_TAGS]);
      expect(closed.at(-1)).toMatchObject({ label: "Older", folder: true, open: false, count: 15 });

      const open = section(sidebarSections(repo, { olderTagsOpen: true }), "tags").rows;
      expect(open).toHaveLength(RECENT_TAGS + 1 + 15);
      expect(open.at(-1)).toMatchObject({ key: "tag:v1", depth: 1 });
    });

    test("filtering finds among the older ones too, without the folder", () => {
      const rows = section(sidebarSections(overview({ tags: tags(20) }), { query: "v1" }), "tags").rows;
      expect(rows.map((r) => r.key)).toEqual([
        "tag:v19",
        "tag:v18",
        "tag:v17",
        "tag:v16",
        "tag:v15",
        "tag:v14",
        "tag:v13",
        "tag:v12",
        "tag:v11",
        "tag:v10",
        "tag:v1",
      ]);
    });

    test("in a folder among both the newest and the older keep their keys apart", () => {
      const repo = overview({ tags: ["x/7", "x/6", "x/5", "x/4", "x/3", "x/2", "x/1", "v2", "v1"] });
      const rows = section(sidebarSections(repo, { olderTagsOpen: true }), "tags").rows;
      const all = rows.map((r) => r.key);
      expect(new Set(all).size).toBe(all.length);
      expect(all).toContain("tag-folder:x/");
      expect(all).toContain("tag-folder-older:x/");
    });
  });

  test("marks a branch with what the agent's doing in the worktree it's checked out in", () => {
    const repo = overview({
      branches: [branch("main", { is_head: true }), branch("a", { worktree: "/code/repo-a" }), branch("b", { worktree: "/code/repo-b" }), branch("c")],
    });
    const agents = { "/repo": "working", "/code/repo-a": "blocked", "/code/repo-b": "something new" };
    const [main, a, b, c] = section(sidebarSections(repo, { agents }), "branches").rows;
    expect(main.agent).toBe("working");
    expect(a.agent).toBe("blocked");
    expect(a.title).toContain("Its agent needs you");
    // A state it doesn't know shows nothing.
    expect(b.agent).toBeNull();
    expect(c.agent).toBeNull();
  });

  test("marks each worktree with what its agent's doing, in whichever window", () => {
    const repo = overview({
      worktrees: [
        { path: "/code/repo", branch: "main", main: true, current: true },
        { path: "/code/repo-a", branch: "a" },
        { path: "/code/repo-b", branch: "b" },
      ],
    });
    const agents = { "/code/repo-a": "blocked", "/code/repo-b": "something new" };
    const [main, a, b] = section(sidebarSections(repo, { agents }), "worktrees").rows;
    expect(main.agent).toBeNull();
    expect(a.agent).toBe("blocked");
    expect(a.title).toContain("Its agent needs you");
    // A state it doesn't know shows nothing.
    expect(b.agent).toBeNull();
  });

  test("names worktrees by folder, beside their branch, saying when the folder's gone", () => {
    const repo = overview({
      worktrees: [
        { path: "/code/repo", branch: "main", main: true, current: true },
        { path: "/code/repo-feature", branch: null, prunable: true, locked: true },
      ],
    });
    const [main, gone] = section(sidebarSections(repo, {}), "worktrees").rows;
    expect(main).toMatchObject({ key: "worktree:/code/repo", label: "repo", detail: "main", current: true });
    expect(gone).toMatchObject({ label: "repo-feature", detail: "folder gone", gone: true, locked: true });
  });
});
