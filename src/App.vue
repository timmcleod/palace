<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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
import TagDialog from "./components/TagDialog.vue";
import UpdateNotice from "./components/UpdateNotice.vue";
import Workspace from "./components/Workspace.vue";
import { allAgentStates } from "./lib/agentStates.js";
import { finishSaving, unsavedFiles } from "./lib/editing.js";
import { folderName } from "./lib/format.js";
import {
  askConfirm,
  cloneDialog,
  confirmDialog,
  contextMenu,
  formDialog,
  mergeDialog,
  pullDialog,
  resetDialog,
  tagDialog,
} from "./lib/overlays.js";
import { isMac } from "./lib/platform.js";
import { settings } from "./lib/settings.js";
import { starRequest } from "./lib/star.js";
import { updateNoticeShown } from "./lib/updates.js";

// The window: what's the window's own, whatever it shows. Git checked for at startup,
// the dialogs and menus shown over everything, asking before it closes, and every
// window's agents. What it shows of a repository, or the welcome screen without one,
// is Workspace.vue's.

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
  // With git missing, the window has no repository: otherwise opening the one it had in
  // another window would bring this one forward (see show_window_with).
  if (gitMissing.value) invoke("set_window_repo", { path: null }).catch(() => {});
  gitChecked.value = true;
}

onMounted(checkGit);

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
  <div v-if="isMac && gitMissing" class="title-strip" />
  <GitMissing v-if="gitMissing" :status="gitStatus" :checking="checkingGit" @recheck="checkGit" />
  <Workspace v-else :ready="gitChecked" :agent-states="agentStates" />

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
