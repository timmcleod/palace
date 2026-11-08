import { beforeEach, describe, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { forgetGoneRepositories, lastRepository, recentRepositories, rememberRepository, remembering } from "./recents.js";
import { writeJson } from "./storage.js";

// storage.js listens for Palace's other windows as it loads.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));

const repo = (name) => ({ name, path: `/code/${name}` });
const worktree = (name, more = {}) => ({ path: `/code/${name}`, branch: name, main: false, current: false, locked: false, prunable: false, ...more });

describe("remembering a repository", () => {
  test("puts it first, once", () => {
    const overview = { name: "palace", path: "/code/palace", worktrees: [] };
    expect(remembering([repo("blog"), repo("palace")], overview)).toEqual([repo("palace"), repo("blog")]);
  });

  test("remembers a worktree as its repository, leaving out its other worktrees", () => {
    const overview = {
      name: "palace-search",
      path: "/code/palace-search",
      worktrees: [worktree("palace", { main: true }), worktree("palace-search", { current: true }), worktree("palace-login")],
    };
    const recents = [repo("palace-login"), repo("blog"), repo("palace"), repo("palace-search")];
    expect(remembering(recents, overview)).toEqual([repo("palace"), repo("blog")]);
  });

  test("remembers the repository itself, opened, without its worktrees", () => {
    const overview = { name: "palace", path: "/code/palace", worktrees: [worktree("palace", { main: true, current: true }), worktree("palace-login")] };
    expect(remembering([repo("palace-login"), repo("blog")], overview)).toEqual([repo("palace"), repo("blog")]);
  });

  test("with no folder of its own, as for a bare repository, remembers each worktree for itself", () => {
    const overview = { name: "palace-search", path: "/code/palace-search", worktrees: [worktree("palace-search", { current: true }), worktree("palace-login")] };
    expect(remembering([repo("palace-login"), repo("blog")], overview)).toEqual([repo("palace-search"), repo("blog")]);
  });

  test("notes a worktree as the last opened, to open again, though the list has its repository", async () => {
    writeJson("palace.recentRepositories", []);
    rememberRepository({ name: "palace-search", path: "/code/palace-search", worktrees: [worktree("palace", { main: true }), worktree("palace-search", { current: true })] });
    expect(recentRepositories()).toEqual([repo("palace")]);
    vi.mocked(invoke).mockResolvedValue(true);
    expect(await lastRepository()).toBe("/code/palace-search");
    // The worktree removed since, its repository opens.
    vi.mocked(invoke).mockResolvedValue(false);
    expect(await lastRepository()).toBe("/code/palace");
  });
});

describe("forgetting repositories that are gone", () => {
  beforeEach(() => writeJson("palace.recentRepositories", [repo("palace"), repo("deleted"), repo("blog")]));

  test("takes those whose folders are gone off the list", async () => {
    vi.mocked(invoke).mockResolvedValue(["/code/deleted"]);
    await forgetGoneRepositories();
    expect(invoke).toHaveBeenCalledWith("folders_gone", { paths: ["/code/palace", "/code/deleted", "/code/blog"] });
    expect(recentRepositories()).toEqual([repo("palace"), repo("blog")]);
  });

  test("keeps them all when it can't tell", async () => {
    vi.mocked(invoke).mockRejectedValue("No.");
    await forgetGoneRepositories();
    expect(recentRepositories()).toHaveLength(3);
  });
});
