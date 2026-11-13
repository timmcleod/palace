import { folderName } from "./format.js";

// A window's tabs, across its top, each a workspace of its own (Workspace.vue): a
// repository, with its views and terminals, or with none open yet, the welcome screen to
// choose one. Each is kept running while another shows.
//
// The tabs are { list, active }: `list` in the order they're shown, each
//   { id, path, name, branch, task, seen }
// where `path` is the repository it has open, or is opening, or null for none; `name`
// and `branch` what it shows of it; `task`, given as it opens, what its agent is to start
// on; and `seen`, every repository it's shown, once it has, whose terminals go on
// running as it shows another. `active` is the id of the one showing.

let nextId = 1;

/** A new tab, for the repository at `path`, or with none, still to choose one. */
export function makeTab(path = null, { task = null } = {}) {
  return { id: nextId++, path, name: path ? folderName(path) : null, branch: null, task, seen: [] };
}

/** Notes that the tab shows `shown` ({ path, name, branch }), or none. */
export function showIn(tab, shown) {
  tab.path = shown?.path ?? null;
  tab.name = shown?.name ?? null;
  tab.branch = shown?.branch ?? null;
  if (tab.path && !tab.seen.includes(tab.path)) tab.seen.push(tab.path);
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

/**
 * Where the tab `id`, dropped before the tab `target`, or with `after`, after it, goes:
 * its place in the list once it's taken out of its own, as moveTab takes it. Null where
 * it would stay where it is, or `target` isn't one.
 */
export function dropPlace(tabs, id, target, after) {
  const others = tabs.list.filter((tab) => tab.id !== id);
  const at = others.findIndex((tab) => tab.id === target);
  if (at < 0) return null;
  const to = at + (after ? 1 : 0);
  return tabs.list.findIndex((tab) => tab.id === id) === to ? null : to;
}

/**
 * Where a tab dragged along the row would land, with the pointer at `x`: at whichever
 * place between two tabs, or at an end, is nearest, as { id, after }, before the tab
 * `id`, or after it at the end; null with no tabs. `spans` is where each tab is along
 * the row, { id, left, right }, in order: as they were when the drag started, so the
 * gap that opens where it'd land, moving the tabs, doesn't move where that is.
 */
export function landingAt(spans, x) {
  if (!spans.length) return null;
  const places = spans.map((span, i) => (i ? (spans[i - 1].right + span.left) / 2 : span.left));
  places.push(spans.at(-1).right);
  let nearest = 0;
  places.forEach((place, i) => {
    if (Math.abs(x - place) < Math.abs(x - places[nearest])) nearest = i;
  });
  return nearest < spans.length ? { id: spans[nearest].id, after: false } : { id: spans.at(-1).id, after: true };
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
