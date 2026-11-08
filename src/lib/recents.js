// The recent repositories, as the welcome screen and the repository menu list them, most
// recent first: one entry a repository, whichever of its worktrees was open, so one with
// several doesn't push the others down the list, or off it. Its worktrees open from its
// sidebar.
import { invoke } from "@tauri-apps/api/core";
import { folderName } from "./format.js";
import { readJson, writeJson } from "./storage.js";

export const RECENTS_KEY = "palace.recentRepositories";
// The folder last opened, a worktree's own, which the list has as its repository.
const LAST_KEY = "palace.lastRepository";
const MAX_RECENTS = 30;
// A list of more recent repositories than this, on the welcome screen or in the
// sidebar's menu, has a field to find one in, and shows this many at a time.
export const FILTER_RECENTS = 5;

/** The recent repositories: [{ name, path }]. */
export function recentRepositories() {
  const recents = readJson(RECENTS_KEY, []);
  return Array.isArray(recents) ? recents : [];
}

/**
 * `recents` with the repository `overview` shows put first: as its own folder, when a
 * worktree added to it is open, and without those worktrees, which an older Palace listed.
 */
export function remembering(recents, overview) {
  const main = overview.worktrees.find((w) => w.main);
  const repo = main && !main.current ? { name: folderName(main.path), path: main.path } : { name: overview.name, path: overview.path };
  const added = new Set(overview.worktrees.filter((w) => !w.main).map((w) => w.path));
  return [repo, ...recents.filter((r) => r.path !== repo.path && !added.has(r.path))];
}

/**
 * Puts the repository `overview` shows first among the recent ones (see remembering),
 * and notes its folder as the last opened.
 */
export function rememberRepository(overview) {
  writeJson(RECENTS_KEY, remembering(recentRepositories(), overview).slice(0, MAX_RECENTS));
  writeJson(LAST_KEY, overview.path);
}

/**
 * The folder last opened, to open again at startup: a worktree, if that's what it was,
 * unless it's been removed since, when it's the most recent repository.
 */
export async function lastRepository() {
  const last = readJson(LAST_KEY, null);
  if (last && (await invoke("folder_exists", { path: last }).catch(() => false))) return last;
  return recentRepositories()[0]?.path ?? null;
}

/** Takes the folders `paths` off the recent repositories. */
export function forgetRepositories(paths) {
  const forgotten = new Set(paths);
  writeJson(RECENTS_KEY, recentRepositories().filter((r) => !forgotten.has(r.path)));
}

/** Takes the recent repositories whose folders are gone off the list (see folders_gone). */
export async function forgetGoneRepositories() {
  const gone = await invoke("folders_gone", { paths: recentRepositories().map((r) => r.path) }).catch(() => []);
  if (gone.length) forgetRepositories(gone);
}
