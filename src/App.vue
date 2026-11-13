<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import CloneDialog from "./components/CloneDialog.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import ContextMenu from "./components/ContextMenu.vue";
import FormDialog from "./components/FormDialog.vue";
import GitMissing from "./components/GitMissing.vue";
import MergeDialog from "./components/MergeDialog.vue";
import PullDialog from "./components/PullDialog.vue";
import ResetDialog from "./components/ResetDialog.vue";
import StarNotice from "./components/StarNotice.vue";
import TabStrip from "./components/TabStrip.vue";
import TagDialog from "./components/TagDialog.vue";
import UpdateNotice from "./components/UpdateNotice.vue";
import Workspace from "./components/Workspace.vue";
import { allAgentStates } from "./lib/agentStates.js";
import { finishSaving, forgetEditsIn, unsavedFiles } from "./lib/editing.js";
import { folderName } from "./lib/format.js";
import {
  askConfirm,
  cloneDialog,
  confirmDialog,
  contextMenu,
  formDialog,
  mergeDialog,
  overlayOpen,
  pullDialog,
  resetDialog,
  tagDialog,
  tell,
} from "./lib/overlays.js";
import { isMac } from "./lib/platform.js";
import { lastRepository } from "./lib/recents.js";
import { useShortcuts } from "./lib/shortcuts.js";
import { closeTab, closingLoses, leftBy, moveTab, openTab, showIn, showNext, showNumber, tabWith, tabsForBackend } from "./lib/tabs.js";
import { settings } from "./lib/settings.js";
import { starRequest } from "./lib/star.js";
import { updateNoticeShown } from "./lib/updates.js";

// The window: what's the window's own, whatever it shows. Git checked for at startup,
// its tabs across its top, the dialogs and menus shown over everything, asking
// before it closes, and every window's agents. Each tab is a Workspace.vue: a
// repository, or the welcome screen without one.

const thisWindow = getCurrentWebviewWindow();

// --- Checks at startup -------------------------------------------------------------

// Without a usable git, Palace shows how to install it instead of the app.
const gitStatus = ref(null);
const checkingGit = ref(false);
const gitMissing = computed(() => gitStatus.value && !gitStatus.value.supported);
// Once git's been checked for, the workspace can open a repository. Couldn't ask, it
// carries on rather than block the app.
const gitChecked = ref(false);

async function checkGit() {
  checkingGit.value = true;
  try {
    gitStatus.value = await invoke("git_check");
  } catch {
    gitStatus.value = null;
  } finally {
    checkingGit.value = false;
  }
  // With git missing, the tabs it had, as after Palace restarted into an update, are
  // kept, for when git's been installed and Recheck finds it.
  gitChecked.value = true;
}

onMounted(checkGit);

// --- Tabs --------------------------------------------------------------------------

// The window's tabs (see tabs.js), made once git's found usable.
const tabs = reactive({ list: [], active: null });
const started = ref(false);
// The tab that takes the recent repositories gone since Palace last ran off the list,
// once: the first window's, at startup.
let tidies = null;
// Each tab's workspace, by tab, to show a terminal tab in.
const workspaces = {};
// The tabs' workspaces in the order they were opened, rather than the order the tabs
// are in: moving a tab then doesn't move its workspace in the page, which would lose
// where its views were scrolled to.
const opened = computed(() => [...tabs.list].sort((a, b) => a.id - b.id));

// What the window starts with: the tabs it had, as when its page reloads or Palace has
// restarted into an update; or in the first window at startup, the last repository
// opened; otherwise one tab, to choose a repository in.
async function startTabs() {
  const start = await invoke("window_start").catch(() => ({ tabs: { repos: [], active: null }, first: true }));
  const repos = [...(start.tabs?.repos ?? [])];
  if (!repos.length && start.first) {
    const last = await lastRepository();
    if (last) repos.push(last);
  }
  for (const path of repos) openTab(tabs, path);
  if (!tabs.list.length) openTab(tabs);
  tabs.active = (tabs.list[start.tabs?.active ?? 0] ?? tabs.list[0]).id;
  if (start.first) tidies = tabs.active;
  started.value = true;
}

watch(
  () => gitChecked.value && !gitMissing.value && !started.value,
  (ready) => ready && startTabs(),
);

// The backend's told the tabs as they change, so another window shows the one with a
// repository it's asked to open, and they reopen as they were (see reopen.rs).
watch(
  () => started.value && JSON.stringify(tabsForBackend(tabs)),
  (said) => said && invoke("set_window_tabs", { tabs: JSON.parse(said) }).catch(() => {}),
);

// With one tab, the window looks as it would without tabs: no row of them, the macOS
// window buttons in the sidebar's top (see Sidebar.vue). A second brings the row, which
// the page's styles are told of.
const manyTabs = computed(() => tabs.list.length > 1);
watch(manyTabs, (many) => {
  if (many) document.documentElement.dataset.tabs = "many";
  else delete document.documentElement.dataset.tabs;
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

// Whether a dialog or menu is open, the window's or the tab showing's own, as Create
// Pull Request, which the window's keys and menu mustn't go out from under.
const dialogOpen = () => overlayOpen() || !!workspaces[tabs.active]?.dialogOpen();

/** Opens a tab to choose a repository in. */
const newTab = () => openTab(tabs);

/** Opens a new window, to open repositories in, side by side with this one. */
const newWindow = () =>
  invoke("new_window", { dark: document.documentElement.dataset.theme === "dark" }).catch((e) =>
    tell("Couldn't Open a Window", String(e)),
  );

// Shows the repository at `path` where it's open already, rather than opening it again
// in the tab `from`: in another tab here, or another window. Says whether it is. `from`
// may have it already, as one opening it does: that isn't elsewhere.
async function showElsewhere(path, from) {
  const other = tabWith(tabs, path);
  if (other && other !== from) {
    tabs.active = other.id;
    return true;
  }
  return await invoke("show_window_with", { path }).catch(() => false);
}

// Opens the repository at `path` in a tab of its own, as for a worktree, with `task`
// for its agent; or where it's open already, shows that.
async function openRepoTab({ path, task = null }) {
  if (await showElsewhere(path, null)) return;
  openTab(tabs, path, { task });
}

// Closes the tab `id`, asking first while programs run in its terminals or its files
// have edits not saved, in any repository it's shown that no other tab has open (see
// leftBy). Those terminals are hung up, and those edits let go of. The last closes the
// window, which asks as its close button does.
async function askToClose(id) {
  const tab = tabs.list.find((t) => t.id === id);
  if (!tab) return;
  if (tabs.list.length === 1) return thisWindow.close();
  const { busyIn } = await import("./lib/terminals.js");
  if (settings.autoSave) await finishSaving();
  const paths = leftBy(tabs, tab);
  const edited = unsavedFiles()
    .filter((f) => paths.includes(f.path))
    .map((f) => f.file.split("/").pop());
  const running = (await Promise.all(paths.map(busyIn))).flat();
  const loses = closingLoses({ edited, running });
  if (loses && !(await askConfirm({ title: "Close Tab?", message: loses, confirmLabel: "Close", danger: true }))) return;
  // Meanwhile, another may have closed, or this one: the last closes the window.
  if (!tabs.list.includes(tab)) return;
  if (tabs.list.length === 1) return thisWindow.close();
  dropTab(tab);
}

// Takes the tab away, then, its workspace gone, the terminals and edits not saved of
// what it's shown that no other tab has: before, its editor, closing, would keep its
// edits again.
async function dropTab(tab) {
  const paths = leftBy(tabs, tab);
  closeTab(tabs, tab.id);
  await nextTick();
  const { closeTerminalsOf } = await import("./lib/terminals.js");
  for (const path of paths) {
    closeTerminalsOf(path);
    forgetEditsIn(path);
  }
}

// A worktree removed (see close_tabs_with): its tab closes without asking, the user
// having been asked already, and its terminals already hung up. The window goes with its
// last tab.
const unlistenCloseRepo = thisWindow.listen("close-repo", async ({ payload }) => {
  const tab = tabWith(tabs, payload.path);
  if (!tab) return;
  if (tabs.list.length === 1) return invoke("quit_confirmed", { quitting: false }).catch(() => {});
  dropTab(tab);
});

// Another window opening a repository open here shows its tab (see show_window_with).
const unlistenShowRepo = thisWindow.listen("show-repo", ({ payload }) => {
  const tab = tabWith(tabs, payload.path);
  if (tab) tabs.active = tab.id;
});

// A terminal's notice, or the system's notification, clicked: the tab with its
// repository shows, opened if it's been closed since, then the terminal tab there.
const unlistenShowTerminalTab = thisWindow.listen("show-terminal-tab", async ({ payload }) => {
  const tab = tabWith(tabs, payload.path) ?? openTab(tabs, payload.path);
  tabs.active = tab.id;
  await nextTick();
  workspaces[tab.id]?.showTerminalTab(payload);
});

// The File menu's items, on a Mac (see menu.rs); the Palace menu's are the workspace
// showing's. Not while a dialog's open, which they'd go out from under. Before there are
// tabs, as with git missing, Close Tab closes the window, as a new window's does.
const unlistenMenu = thisWindow.listen("menu", ({ payload }) => {
  if (dialogOpen()) return;
  if (payload === "new-window") newWindow();
  if (payload === "new-tab" && started.value) newTab();
  if (payload === "close-tab") started.value ? askToClose(tabs.active) : thisWindow.close();
});

onBeforeUnmount(() => {
  for (const unlisten of [unlistenCloseRepo, unlistenShowRepo, unlistenShowTerminalTab, unlistenMenu]) unlisten.then((stop) => stop());
});

// The window's own shortcuts, for its tabs (see shortcutFor); its workspaces' are
// theirs.
useShortcuts(
  (event) => ({
    inTerminal: !!event.target.closest?.(".terminal-panel"),
    inTextField: false,
    inEditor: false,
    dialogOpen: dialogOpen(),
    repository: false,
  }),
  {
    newTab: () => started.value && newTab(),
    newWindow: () => newWindow(),
    closeTab: () => started.value && askToClose(tabs.active),
    showTab: (_, event) => showNumber(tabs, Number(event.code.slice("Digit".length))),
    nextTab: () => showNext(tabs),
    previousTab: () => showNext(tabs, -1),
  },
);

// Terminals a page started before it reloaded have nothing to show them any more.
invoke("terminal_close_all").catch(() => {});

// --- Every window's agents ---------------------------------------------------------

// What each repository's agents are doing, in every window, by path (see agentStates.js),
// for Worktrees to show which is busy or wants you.
const agentStates = ref({});
// Listening first, then asking: a change sent meanwhile isn't overwritten by older news.
let heardAgents = false;
const unlistenAgents = listen("agent-states", ({ payload }) => {
  heardAgents = true;
  agentStates.value = allAgentStates(payload);
});
onBeforeUnmount(() => unlistenAgents.then((unlisten) => unlisten()));
unlistenAgents
  .then(() => invoke("agent_states"))
  .then((byWindow) => heardAgents || (agentStates.value = allAgentStates(byWindow)))
  .catch(() => {});

// --- Quitting and closing the window -----------------------------------------------

// Quitting, or closing the window, with programs still running in terminals or edits
// not saved asks first, naming them (see quit.rs).
// Closing a window asks about its own; quitting, about every window's.
let askingToQuit = false;
const unlistenQuit = thisWindow.listen("quit-requested", async ({ payload }) => {
  // Palace goes ahead anyway on a second try if the page doesn't say it's asking.
  invoke("quit_asking").catch(() => {});
  if (askingToQuit) return;
  askingToQuit = true;
  const { quitting } = payload;
  // Saving automatically, edits are saved first, and only those that couldn't be are
  // asked about.
  if (settings.autoSave) await finishSaving();
  const doing = quitting ? "Quitting" : "Closing the window";
  const lines = [];
  const edited = unsavedFiles().map((f) => `“${f.file.split("/").pop()}” in ${folderName(f.path)}`);
  if (edited.length) {
    lines.push(`Edits to ${edited.join(", ")} aren't saved. ${doing} loses them.`);
  }
  if (payload.terminals.length) {
    const { describeTerminals } = await import("./lib/terminals.js");
    const names = describeTerminals(payload.terminals).map((t) => `“${t.label}” in ${t.repository}`);
    lines.push(
      names.length === 1
        ? `${names[0]} is still running. ${doing} stops it.`
        : `${names.length} terminals are still running: ${names.join(", ")}. ${doing} stops them.`,
    );
  }
  const elsewhere = [
    ...payload.other_edits.map((file) => `edits to ${file} aren't saved`),
    ...payload.other_terminals.map((folder) => `a terminal in ${folder} is still running`),
  ];
  if (elsewhere.length) {
    const said = elsewhere.join("; ");
    lines.push(`In other windows, ${said}. Quitting ${payload.other_edits.length ? "loses" : "stops"} ${elsewhere.length === 1 ? "it" : "them"}.`);
  }
  if (!lines.length) {
    askingToQuit = false;
    invoke("quit_confirmed", { quitting }).catch(() => {});
    return;
  }
  const ok = await askConfirm({
    title: quitting ? "Quit Palace?" : "Close Window?",
    message: lines.join("\n\n"),
    confirmLabel: quitting ? "Quit" : "Close",
    danger: true,
  });
  askingToQuit = false;
  if (ok) invoke("quit_confirmed", { quitting }).catch(() => {});
});
onBeforeUnmount(() => unlistenQuit.then((unlisten) => unlisten()));
</script>

<template>
  <div v-if="isMac && (gitMissing || !started)" class="title-strip" />
  <GitMissing v-if="gitMissing" :status="gitStatus" :checking="checkingGit" @recheck="checkGit" />
  <div v-else-if="started" class="tabbed">
    <TabStrip
      v-if="manyTabs"
      :tabs="tabs.list"
      :active="tabs.active"
      :agents="agentStates"
      @select="(id) => (tabs.active = id)"
      @close="askToClose"
      @new="newTab"
      @move="(id, to) => moveTab(tabs, id, to)"
    />
    <div class="workspaces">
      <!-- Hidden rather than removed, each tab's workspace goes on running. -->
      <div v-for="tab in opened" v-show="tab.id === tabs.active" :key="tab.id" class="workspace">
        <Workspace
          :ref="(workspace) => (workspace ? (workspaces[tab.id] = workspace) : delete workspaces[tab.id])"
          :opens="tab.path"
          :task="tab.task"
          :tidy-recents="tab.id === tidies"
          :open-elsewhere="(path) => showElsewhere(path, tab)"
          :agent-states="agentStates"
          :active="tab.id === tabs.active"
          @shows="(shown) => showIn(tab, shown)"
          @open-tab="openRepoTab"
          @new-tab="newTab"
          @new-window="newWindow"
          @close="askToClose(tab.id)"
        />
      </div>
    </div>
  </div>

  <!-- Overlays, shown over whichever screen is up. -->
  <FormDialog v-if="formDialog" :key="formDialog.title" :dialog="formDialog" />
  <TagDialog v-if="tagDialog" :dialog="tagDialog" />
  <PullDialog v-if="pullDialog" :dialog="pullDialog" />
  <MergeDialog v-if="mergeDialog" :dialog="mergeDialog" />
  <ResetDialog v-if="resetDialog" :dialog="resetDialog" />
  <CloneDialog v-if="cloneDialog" :dialog="cloneDialog" />
  <ConfirmDialog v-if="confirmDialog" :dialog="confirmDialog" />
  <UpdateNotice />
  <StarNotice v-if="starRequest && !updateNoticeShown" />
  <ContextMenu v-if="contextMenu" :menu="contextMenu" />
</template>

<style scoped>
/* The tabs across the top, and below them, the one showing. */
.tabbed {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.workspaces {
  flex: 1;
  min-height: 0;
}

.workspace {
  height: 100%;
}
</style>
