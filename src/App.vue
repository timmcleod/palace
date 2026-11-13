<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
import { finishSaving, unsavedFiles } from "./lib/editing.js";
import { losses, quoted } from "./lib/losses.js";
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
import { inTextField, useShortcuts } from "./lib/shortcuts.js";
import { moveTab, showNext, showNumber } from "./lib/tabs.js";
import { useTabs } from "./lib/windowTabs.js";
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

// The window's tabs (see windowTabs.js), made once git's found usable.
const { tabs, started, opened, many, first, workspaces, start, newTab, shows, showElsewhere, shownElsewhere, openRepoTab, askToClose } = useTabs({
  window: thisWindow,
});

watch(
  () => gitChecked.value && !gitMissing.value && !started.value,
  (ready) => ready && start(),
);

// Whether a dialog or menu is open, the window's or the tab showing's own, as Create
// Pull Request, which the window's keys and menu mustn't go out from under.
const dialogOpen = overlayOpen;

/** Opens a new window, to open repositories in, side by side with this one. */
const newWindow = () =>
  invoke("new_window", { dark: document.documentElement.dataset.theme === "dark" }).catch((e) =>
    tell("Couldn't Open a Window", String(e)),
  );

// The File menu's items, on a Mac (see menu.rs); the Palace menu's are the workspace
// showing's. Not while a dialog's open, which they'd go out from under. Before there are
// tabs, as with git missing, Close Tab closes the window, as a new window's does.
const unlistenMenu = thisWindow.listen("menu", ({ payload }) => {
  if (dialogOpen()) return;
  if (payload === "new-window") newWindow();
  if (payload === "new-tab" && started.value) newTab();
  if (payload === "close-tab") started.value ? askToClose(tabs.active) : thisWindow.close();
});
onBeforeUnmount(() => unlistenMenu.then((stop) => stop()));

// The window's own shortcuts, for its tabs (see shortcutFor); its workspaces' are
// theirs.
useShortcuts(
  (event) => ({
    inTerminal: !!event.target.closest?.(".terminal-panel"),
    inTextField: inTextField(event.target),
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
// Asked once each, closing or quitting, while it's showing; quitting while closing's
// asked, as with ⌘Q, comes first, the window's own question back after if it's said not
// to.
const asking = { close: false, quit: false };
const unlistenQuit = thisWindow.listen("quit-requested", async ({ payload }) => {
  // Palace goes ahead anyway on a second try if the page doesn't say it's asking.
  invoke("quit_asking").catch(() => {});
  const { quitting } = payload;
  const kind = quitting ? "quit" : "close";
  if (asking.quit || asking[kind]) return;
  asking[kind] = true;
  // Saving automatically, edits are saved first, and only those that couldn't be are
  // asked about.
  if (settings.autoSave) await finishSaving();
  const edited = unsavedFiles().map((f) => `${quoted(f.file.split("/").pop())} in ${folderName(f.path)}`);
  // Those this page knows by name: one it's let go of, as its tab closed while its shell
  // started, is counted but can't be named.
  const { describeTerminals } = payload.terminals.length ? await import("./lib/terminals.js") : { describeTerminals: () => [] };
  const running = describeTerminals(payload.terminals).map((t) => `${quoted(t.label)} in ${t.repository}`);
  const lines = losses({ edited, running, count: payload.terminals.length, doing: quitting ? "Quitting" : "Closing the window" });
  const elsewhere = [
    ...payload.other_edits.map((file) => `edits to ${file} aren't saved`),
    ...payload.other_terminals.map((folder) => `a terminal in ${folder} is still running`),
  ];
  if (elsewhere.length) {
    const said = elsewhere.join("; ");
    lines.push(`In other windows, ${said}. Quitting ${payload.other_edits.length ? "loses" : "stops"} ${elsewhere.length === 1 ? "it" : "them"}.`);
  }
  if (!lines.length) {
    asking[kind] = false;
    invoke("quit_confirmed", { quitting }).catch(() => {});
    return;
  }
  // Before any other question showing: quitting otherwise seems to do nothing.
  const ok = await askConfirm({
    first: true,
    title: quitting ? "Quit Palace?" : "Close Window?",
    message: lines.join("\n\n"),
    confirmLabel: quitting ? "Quit" : "Close",
    danger: true,
  });
  asking[kind] = false;
  if (ok) invoke("quit_confirmed", { quitting }).catch(() => {});
});
onBeforeUnmount(() => unlistenQuit.then((unlisten) => unlisten()));
</script>

<template>
  <div v-if="isMac && (gitMissing || !started)" class="title-strip" />
  <GitMissing v-if="gitMissing" :status="gitStatus" :checking="checkingGit" @recheck="checkGit" />
  <div v-else-if="started" class="tabbed">
    <TabStrip
      v-if="many"
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
          :first="tab.id === first"
          :open-elsewhere="(path) => showElsewhere(path, tab)"
          :shown-elsewhere="(path) => shownElsewhere(path, tab)"
          :agent-states="agentStates"
          :active="tab.id === tabs.active"
          @shows="(shown) => shows(tab, shown)"
          @open-tab="openRepoTab"
          @new-tab="newTab"
          @new-window="newWindow"
          @close="askToClose(tab.id)"
        />
      </div>
    </div>
  </div>

  <!-- Overlays, shown over whichever screen is up. -->
  <FormDialog v-if="formDialog" :key="formDialog.id" :dialog="formDialog" />
  <TagDialog v-if="tagDialog" :key="tagDialog.id" :dialog="tagDialog" />
  <PullDialog v-if="pullDialog" :key="pullDialog.id" :dialog="pullDialog" />
  <MergeDialog v-if="mergeDialog" :key="mergeDialog.id" :dialog="mergeDialog" />
  <ResetDialog v-if="resetDialog" :key="resetDialog.id" :dialog="resetDialog" />
  <CloneDialog v-if="cloneDialog" :key="cloneDialog.id" :dialog="cloneDialog" />
  <ConfirmDialog v-if="confirmDialog" :key="confirmDialog.id" :dialog="confirmDialog" />
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
