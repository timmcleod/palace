import { folderName } from "./format.js";

// A window's tabs, across its top, each a workspace of its own (Workspace.vue): a
// repository, with its views and terminals, or with none open yet, the welcome screen to
// choose one. Each is kept running while another shows.
//
// The tabs are { list, active }: `list` in the order they're shown, each
//   { id, path, name, branch, home, ahead, behind, changes, task, seen }
// where `path` is the repository it has open, or is opening, or null for none; `name`
// and `branch` what it shows of it; `home`, for a worktree, the repository it was added
// to, or else `path` again; `ahead` and `behind`, its branch's commits not pushed and not
// pulled; `changes`, how many files have changes not committed; `task`, given as it
// opens, what its agent is to start on; and `seen`, every repository it's shown, once it
// has, whose terminals go on running as it shows another. `active` is the id of the one
// showing.

let nextId = 1;

/** A new tab, for the repository at `path`, or with none, still to choose one. */
export function makeTab(path = null, { task = null } = {}) {
  return { id: nextId++, path, name: path ? folderName(path) : null, branch: null, home: path, ahead: 0, behind: 0, changes: 0, task, seen: [] };
}

/**
 * Notes that the tab shows `shown`, or none: { path, name, branch }, and as it can,
 * { home, ahead, behind, changes } (see the tabs, above).
 */
export function showIn(tab, shown) {
  tab.path = shown?.path ?? null;
  tab.name = shown?.name ?? null;
  tab.branch = shown?.branch ?? null;
  tab.home = shown?.home ?? tab.path;
  tab.ahead = shown?.ahead ?? 0;
  tab.behind = shown?.behind ?? 0;
  tab.changes = shown?.changes ?? 0;
  if (tab.path && !tab.seen.includes(tab.path)) tab.seen.push(tab.path);
}

// How many colors a tab can have, the graph's lanes' (--graph-1 to --graph-6).
const COLORS = 6;

/**
 * The tab's color, 1 to 6, of the graph's, or null with no repository: the same for a
 * repository every time, worked out from where it is, to know it by at a glance, and its
 * worktrees' the same as its own.
 */
export function tabColor(tab) {
  const home = tab.home ?? tab.path;
  if (!home) return null;
  // FNV-1a, for colors spread evenly over paths alike but for a letter or two.
  let hash = 0x811c9dc5;
  for (const char of home) hash = Math.imul(hash ^ char.codePointAt(0), 0x01000193);
  return ((hash >>> 0) % COLORS) + 1;
}

/** Whether the tab shows a worktree, rather than a repository's own working copy. */
export const isWorktree = (tab) => !!(tab.path && tab.home && tab.home !== tab.path);

/**
 * The letter a tab's repository is known by, on its tile: its name's first letter or
 * digit, or with none, as "_build", its first character.
 */
export const tabInitial = (name) => (name?.match(/[\p{L}\p{N}]/u)?.[0] ?? name?.trim().charAt(0) ?? "").toLocaleUpperCase();

// What a tab says of its agent, as an agent's state (see agentStates.js) has it.
const AGENT_SAYS = { working: "agent working", blocked: "needs you", done: "finished", error: "stopped with an error" };

/**
 * What a tab says below its name, in parts, each { text, kind }: its branch; what its
 * agent's doing, `agent`, kind "agent", or "attention" where it needs the user or has
 * stopped; its commits to push and pull, "↑2 ↓1"; and its changes not committed, kind
 * "changes".
 */
export function tabDetails(tab, agent = null) {
  const parts = [];
  if (tab.branch) parts.push({ text: tab.branch, kind: "branch" });
  if (AGENT_SAYS[agent]) parts.push({ text: AGENT_SAYS[agent], kind: agent === "blocked" || agent === "error" ? "attention" : "agent" });
  const sync = [tab.ahead && `↑${tab.ahead}`, tab.behind && `↓${tab.behind}`].filter(Boolean).join(" ");
  if (sync) parts.push({ text: sync, kind: "sync" });
  if (tab.changes) parts.push({ text: `${tab.changes} changed`, kind: "changes" });
  return parts;
}

/**
 * The repositories whose terminals and edits not saved go with the tab as it closes:
 * those it's shown, but for any another tab has open or has shown too. Terminals are
 * kept by repository, not by tab, so one another tab has shown may be its.
 */
export function leftBy(tabs, tab) {
  const others = tabs.list.filter((other) => other !== tab);
  const theirs = new Set(others.flatMap((other) => [other.path, ...other.seen]));
  return tab.seen.filter((path) => !theirs.has(path));
}

/**
 * What each tab's called, by id: its repository's name, or with another tab's of the
 * same name, as two clones of one repository, the folder it's in before it, to tell
 * them apart; "New Tab" for one with none.
 */
export function tabNames(list) {
  const count = new Map();
  for (const tab of list) if (tab.name) count.set(tab.name, (count.get(tab.name) ?? 0) + 1);
  return new Map(
    list.map((tab) => {
      if (!tab.name) return [tab.id, "New Tab"];
      const parent = tab.path?.split(/[\\/]/).filter(Boolean).at(-2);
      return [tab.id, count.get(tab.name) > 1 && parent ? `${parent}/${tab.name}` : tab.name];
    }),
  );
}

/** The tab showing. */
export const activeTab = (tabs) => tabs.list.find((tab) => tab.id === tabs.active) ?? null;

/** The tab with the repository at `path` open, if there is one. */
export const tabWith = (tabs, path) => (path ? (tabs.list.find((tab) => tab.path === path) ?? null) : null);

/** Opens a new tab, as `makeTab` makes it, after the one showing, and shows it. */
export function openTab(tabs, path = null, options) {
  const tab = makeTab(path, options);
  const at = tabs.list.findIndex((t) => t.id === tabs.active);
  tabs.list.splice(at < 0 ? tabs.list.length : at + 1, 0, tab);
  tabs.active = tab.id;
  return tab;
}

/**
 * Closes the tab `id`. Closing the one showing shows the one after it, or with none
 * after, the one before, as a browser does.
 */
export function closeTab(tabs, id) {
  const at = tabs.list.findIndex((tab) => tab.id === id);
  if (at < 0) return;
  tabs.list.splice(at, 1);
  if (tabs.active === id) tabs.active = (tabs.list[at] ?? tabs.list[at - 1])?.id ?? null;
}

/** Shows the `n`th tab, from 1, as ⌘1 to ⌘8 do; ⌘9 is the last, however many there are. */
export function showNumber(tabs, n) {
  const tab = n === 9 ? tabs.list.at(-1) : tabs.list[n - 1];
  if (tab) tabs.active = tab.id;
}

/** Shows the tab after the one showing, or with `by` -1, before it, going round. */
export function showNext(tabs, by = 1) {
  const count = tabs.list.length;
  if (!count) return;
  const at = tabs.list.findIndex((tab) => tab.id === tabs.active);
  tabs.active = tabs.list[(at + by + count) % count].id;
}

/** Moves the tab `id` to be at `to` in the list, as dragged there. */
export function moveTab(tabs, id, to) {
  const at = tabs.list.findIndex((tab) => tab.id === id);
  if (at < 0) return;
  const [tab] = tabs.list.splice(at, 1);
  tabs.list.splice(Math.max(0, Math.min(to, tabs.list.length)), 0, tab);
}

/**
 * The tabs as the backend keeps them (see Tabs in windows.rs): the repositories open,
 * in order, and which of them is showing, by its place among them; and `kept`, those
 * tabs showed before and keep the terminals and edits of, not open now. Tabs with none
 * open are left out, and a repository is open in one tab at a time.
 */
export function tabsForBackend(tabs) {
  const open = tabs.list.filter((tab) => tab.path);
  const at = open.findIndex((tab) => tab.id === tabs.active);
  const repos = open.map((tab) => tab.path);
  const kept = [...new Set(tabs.list.flatMap((tab) => tab.seen))].filter((path) => !repos.includes(path));
  return { repos, active: at < 0 ? null : at, kept };
}
