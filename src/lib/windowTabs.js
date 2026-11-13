import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { finishSaving, forgetEditsIn, unsavedFiles } from "./editing.js";
import { losses, quoted } from "./losses.js";
import { askConfirm } from "./overlays.js";
import { fitTerminal } from "./panes.js";
import { lastRepository } from "./recents.js";
import { settings } from "./settings.js";
import { closeTab, leftBy, openTab, showIn, tabWith, tabsForBackend } from "./tabs.js";

// terminals.js, with xterm, loads the first time a terminal's wanted.
const terminals = () => import("./terminals.js");

/**
 * A window's tabs, each a Workspace.vue (see tabs.js for what a tab is): how the window
 * starts, opening, closing and going between them, and what the backend's told of them.
 * `window` is this one (getCurrentWebviewWindow), which closes with its last tab and
 * hears from the backend which tab to show or close.
 *
 * Returns the tabs, `started` once there are any, `opened` (the tabs in the order they
 * were opened, for their workspaces' place in the page, which moving a tab doesn't
 * change, so its views keep their scroll), `many` (two or more, when their row shows),
 * `first` (the tab that tidies the recent repositories, the first window's at startup),
 * `workspaces` (each tab's Workspace, by id, as App.vue fills it), and what's done with
 * them: start(), newTab(), shows(tab, shown), showElsewhere(path, from),
 * shownElsewhere(path, tab), openRepoTab({ path, task }) and askToClose(id).
 */
export function useTabs({ window }) {
  const tabs = reactive({ list: [], active: null });
  const started = ref(false);
  const first = ref(null);
  const workspaces = {};
  const opened = computed(() => [...tabs.list].sort((a, b) => a.id - b.id));
  const many = computed(() => tabs.list.length > 1);

  // What the window starts with: the tabs it had, as when its page reloads or Palace
  // reopens it as it starts; or in the first window, the last repository opened; or
  // one tab, to choose a repository in.
  async function start() {
    const start = await invoke("window_start").catch(() => ({ tabs: { repos: [], active: null }, first: true }));
    const repos = [...(start.tabs?.repos ?? [])];
    if (!repos.length && start.first) {
      const last = await lastRepository();
      if (last) repos.push(last);
    }
    for (const path of repos) openTab(tabs, path);
    if (!tabs.list.length) openTab(tabs);
    tabs.active = (tabs.list[start.tabs?.active ?? 0] ?? tabs.list[0]).id;
    if (start.first) first.value = tabs.active;
    started.value = true;
  }

  // The backend's told the tabs as they change, so another window shows the one with a
  // repository it's asked to open, and they reopen as they were (see reopen.rs).
  watch(
    () => started.value && JSON.stringify(tabsForBackend(tabs)),
    (said) => said && invoke("set_window_tabs", { tabs: JSON.parse(said) }).catch(() => {}),
  );

  // With one tab, the window looks as it would without tabs: no row of them, the macOS
  // window buttons in the sidebar's top (see Sidebar.vue). A second brings the row, which
  // the page's styles are told of, and which takes room from the panes above the
  // terminal panel.
  watch(many, (now) => {
    if (now) document.documentElement.dataset.tabs = "many";
    else delete document.documentElement.dataset.tabs;
    fitTerminal();
  });
  onBeforeUnmount(() => delete document.documentElement.dataset.tabs);

  // Leaving a tab, the keys go with it: a text field or terminal of one that's hidden
  // would otherwise go on taking what's typed.
  watch(
    () => tabs.active,
    async () => {
      await nextTick();
      const focused = document.activeElement;
      if (focused?.closest?.(".workspace")?.style.display === "none") focused.blur();
    },
  );

  /** Opens a tab to choose a repository in. */
  const newTab = () => openTab(tabs);

  /**
   * What the tab's workspace shows now, { path, name, branch }, or null for none. One
   * that couldn't open the repository it was opening lets go of what's left of that,
   * where no other tab has it, as the terminals of a tab that closed meanwhile.
   */
  function shows(tab, shown) {
    const opening = tab.path;
    showIn(tab, shown);
    const others = tabs.list.filter((other) => other !== tab);
    if (!shown && opening && !tab.seen.includes(opening) && !others.some((other) => other.path === opening || other.seen.includes(opening))) {
      letGoOf([opening]);
      invoke("release_repo", { path: opening }).catch(() => {});
    }
  }

  // Whether `tab` has the repository at `path` showing: opening one isn't showing it.
  const showing = (tab, path) => tab.path === path && tab.seen.includes(path);

  /** Whether a tab other than `tab` shows the repository at `path`. */
  const shownElsewhere = (path, tab) => tabs.list.some((other) => other !== tab && showing(other, path));

  /**
   * Shows the repository at `path` where it's open already, rather than opening it again
   * in the tab `from`: in another tab here, or another window. Says whether it is.
   * `from` may have it already, as one opening it does: that isn't elsewhere. A tab that
   * was only to choose a repository in, with nothing in it, closes, having done that.
   */
  async function showElsewhere(path, from) {
    const other = tabWith(tabs, path);
    let elsewhere = !!other && other !== from;
    if (elsewhere) tabs.active = other.id;
    else elsewhere = await invoke("show_window_with", { path }).catch(() => false);
    if (elsewhere && from && !from.path && !from.seen.length && tabs.list.length > 1) closeTab(tabs, from.id);
    return elsewhere;
  }

  /**
   * Opens the repository at `path` in a tab of its own, as for a worktree, with `task`
   * for its agent; or where it's open already, shows that.
   */
  async function openRepoTab({ path, task = null }) {
    if (await showElsewhere(path, null)) return;
    openTab(tabs, path, { task });
  }

  /**
   * Closes the tab `id`, asking first while programs run in its terminals or its files
   * have edits not saved, in any repository it's shown that no other tab has (see
   * leftBy). Those terminals are hung up, and those edits let go of. The last closes the
   * window, which asks as its close button does.
   */
  async function askToClose(id) {
    const tab = tabs.list.find((t) => t.id === id);
    if (!tab) return;
    if (tabs.list.length === 1) return window.close();
    if (!(await agreedToLose(leftBy(tabs, tab)))) return;
    // Meanwhile, another may have closed, or this one: the last closes the window.
    if (!tabs.list.includes(tab)) return;
    if (tabs.list.length === 1) return window.close();
    dropTab(tab);
  }

  // Whether closing a tab that leaves the repositories at `paths` would lose nothing, or
  // the user, asked, says to go ahead: their edits not saved, and programs running in
  // their terminals, would be.
  async function agreedToLose(paths) {
    if (!paths.length) return true;
    const { busyIn } = await terminals();
    if (settings.autoSave) await finishSaving();
    const edited = unsavedFiles()
      .filter((f) => paths.includes(f.path))
      .map((f) => quoted(f.file.split("/").pop()));
    const running = (await Promise.all(paths.map(busyIn))).flat().map(quoted);
    const lost = losses({ edited, running, doing: "Closing the tab" });
    return !lost.length || !!(await askConfirm({ title: "Close Tab?", message: lost.join("\n\n"), confirmLabel: "Close", danger: true }));
  }

  // Takes the tab away, then, its workspace gone, what's left of what it's shown that no
  // other tab has: before, its editor, closing, would keep its edits again.
  async function dropTab(tab) {
    const paths = leftBy(tabs, tab);
    closeTab(tabs, tab.id);
    await nextTick();
    await letGoOf(paths);
  }

  // Hangs up the terminals of the repositories at `paths`, and lets go of their edits
  // not saved.
  async function letGoOf(paths) {
    if (!paths.length) return;
    const { closeTerminalsOf } = await terminals();
    for (const path of paths) {
      closeTerminalsOf(path);
      forgetEditsIn(path);
    }
  }

  // A worktree removed (see close_tabs_with): its tab closes, the user having been asked
  // already about the worktree, and its terminals already hung up. What else the tab's
  // shown, that no other tab has, is asked about as closing it would be: kept, the tab
  // stays, saying its folder's gone. The window goes with its last tab.
  const unlistenCloseRepo = window.listen("close-repo", async ({ payload }) => {
    const tab = tabWith(tabs, payload.path);
    if (!tab) return;
    const removed = tab.path;
    if (!(await agreedToLose(leftBy(tabs, tab).filter((path) => path !== removed)))) return letGoOf([removed]);
    if (!tabs.list.includes(tab)) return;
    if (tabs.list.length === 1) return invoke("quit_confirmed", { quitting: false }).catch(() => {});
    dropTab(tab);
  });

  // Another window opening a repository open here shows its tab (see show_window_with).
  const unlistenShowRepo = window.listen("show-repo", ({ payload }) => {
    const tab = tabWith(tabs, payload.path);
    if (tab) tabs.active = tab.id;
  });

  // A terminal's notice, or the system's notification, clicked: the tab with its
  // repository shows, opened if it's been closed since, then the terminal tab there.
  const unlistenShowTerminalTab = window.listen("show-terminal-tab", async ({ payload }) => {
    const tab = tabWith(tabs, payload.path) ?? openTab(tabs, payload.path);
    tabs.active = tab.id;
    await nextTick();
    workspaces[tab.id]?.showTerminalTab(payload);
  });

  onBeforeUnmount(() => {
    for (const unlisten of [unlistenCloseRepo, unlistenShowRepo, unlistenShowTerminalTab]) unlisten.then((stop) => stop());
  });

  return { tabs, started, opened, many, first, workspaces, start, newTab, shows, showElsewhere, shownElsewhere, openRepoTab, askToClose };
}
