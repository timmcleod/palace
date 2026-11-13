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
import { activeTab, closeTab, moveTab, openTab, showNext, showNumber, tabWith, tabsForBackend } from "./lib/tabs.js";
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
  // With git missing, the window has no repositories: otherwise opening one it had in
  // another window would bring this one forward (see show_window_with).
  if (gitMissing.value) invoke("set_window_tabs", { tabs: { repos: [], active: null } }).catch(() => {});
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

// What the window starts with: the tabs it had, as when its page reloads, or is to
// open, as a new one for a worktree is; or in the first window at startup, the last
// repository opened; otherwise one tab, to choose a repository in.
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
  // Opened for a task (New Agent Task), the tab showing's agent starts on it.
  if (start.task) activeTab(tabs).task = start.task;
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

// What a tab's workspace shows, for the tab to say.
function onShows(tab, shown) {
  tab.path = shown?.path ?? null;
  tab.name = shown?.name ?? null;
  tab.branch = shown?.branch ?? null;
}

/** Opens a tab to choose a repository in. */
const newTab = () => openTab(tabs);

/** Opens a new window, to open repositories in, side by side with this one. */
const newWindow = () =>
  invoke("new_window", { dark: document.documentElement.dataset.theme === "dark" }).catch((e) =>
    tell("Couldn't Open a Window", String(e)),
  );

// Shows the repository at `path` where it's open already, rather than opening it again
// in the tab `from`: in another tab here, or another window. Says whether it is.
async function showElsewhere(path, from) {
  const other = tabWith(tabs, path);
  if (other && other !== from) {
    tabs.active = other.id;
    return true;
  }
  return !other && (await invoke("show_window_with", { path }).catch(() => false));
}

// Opens the repository at `path` in a tab of its own, as for a worktree, with `task`
// for its agent; or where it's open already, shows that.
async function openRepoTab({ path, task = null }) {
  if (await showElsewhere(path, null)) return;
  openTab(tabs, path, { task });
}

// Closes the tab `id`, asking first while programs run in its terminals or its files
// have edits not saved. Its terminals are hung up, and those edits let go of. The last
// closes the window, which asks as its close button does.
async function askToClose(id) {
  const tab = tabs.list.find((t) => t.id === id);
  if (!tab) return;
  if (tabs.list.length === 1) return thisWindow.close();
  const { busyIn, closeTerminalsOf } = await import("./lib/terminals.js");
  if (tab.path) {
    if (settings.autoSave) await finishSaving();
    const lines = [];
    const edited = unsavedFiles().filter((f) => f.path === tab.path).map((f) => `“${f.file.split("/").pop()}”`);
    if (edited.length) lines.push(`Edits to ${edited.join(", ")} aren't saved. Closing the tab loses them.`);
    const running = (await busyIn(tab.path)).map((label) => `“${label}”`);
    if (running.length === 1) lines.push(`${running[0]} is still running. Closing the tab stops it.`);
    else if (running.length) lines.push(`${running.length} terminals are still running: ${running.join(", ")}. Closing the tab stops them.`);
    const ok = !lines.length || (await askConfirm({ title: "Close Tab?", message: lines.join("\n\n"), confirmLabel: "Close", danger: true }));
    if (!ok) return;
  }
  dropTab(tab, closeTerminalsOf);
}

// Takes the tab away, with its terminals and edits not saved.
function dropTab(tab, closeTerminalsOf) {
  if (tab.path) {
    closeTerminalsOf(tab.path);
    forgetEditsIn(tab.path);
  }
  closeTab(tabs, tab.id);
  delete workspaces[tab.id];
}

// A worktree removed (see close_tabs_with): its tab closes without asking, the user
// having been asked already, and its terminals already hung up. The window goes with its
// last tab.
const unlistenCloseRepo = thisWindow.listen("close-repo", async ({ payload }) => {
  const tab = tabWith(tabs, payload.path);
  if (!tab) return;
  if (tabs.list.length === 1) return invoke("quit_confirmed", { quitting: false }).catch(() => {});
  const { closeTerminalsOf } = await import("./lib/terminals.js");
  dropTab(tab, closeTerminalsOf);
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
// showing's. Not while a dialog's open, which they'd go out from under.
const unlistenMenu = thisWindow.listen("menu", ({ payload }) => {
  if (!started.value || overlayOpen()) return;
  if (payload === "new-tab") newTab();
  if (payload === "new-window") newWindow();
  if (payload === "close-tab") askToClose(tabs.active);
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
    dialogOpen: overlayOpen(),
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
          :ref="(workspace) => (workspaces[tab.id] = workspace ?? undefined)"
          ready
          :opens="tab.path"
          :task="tab.task"
          :tidy-recents="tab.id === tidies"
          :open-elsewhere="(path) => showElsewhere(path, tab)"
          :agent-states="agentStates"
          :active="tab.id === tabs.active"
          @shows="(shown) => onShows(tab, shown)"
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
