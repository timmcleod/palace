<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Ellipsis, Plus, Sparkle, SquareTerminal, X } from "lucide-vue-next";
import { askConfirm, openForm, openMenu } from "../lib/overlays.js";
import { isMac, shortcut } from "../lib/platform.js";
import { settings } from "../lib/settings.js";
import {
  AGENTS,
  agentCommand,
  agentName,
  copySelection,
  DEFAULT_AGENT_COMMAND,
  fitTab,
  isBusy,
  markSeen,
  openTerminal,
  dropFiles,
  paste,
  programOf,
  removeTab,
  setAgentCommand,
  startTab,
  tabLabel as label,
  tabsFor,
} from "../lib/terminals.js";
import { setDragImage } from "../lib/dragImage.js";
import Spinner from "./Spinner.vue";

// The panel below the history and details: the repository's terminals, in tabs. An
// agent tab runs the command set for the repository: Claude Code unless it says
// another, such as Codex or Gemini, and is called after it.
const props = defineProps({
  path: { type: String, required: true },
  name: { type: String, required: true },
  // Its height in pixels, which dragging its top edge changes.
  height: { type: Number, required: true },
});
const emit = defineEmits(["update:height", "resized", "hide", "unseen"]);

const group = computed(() => tabsFor(props.path));
const active = computed(() => group.value.tabs.find((tab) => tab.key === group.value.active) ?? null);
const body = ref(null);
const tabList = ref(null);

// The shown tab's terminal is the only one on the page; the others wait, still running.
async function show() {
  await nextTick();
  if (!body.value) return;
  const tab = active.value;
  if (!tab) {
    body.value.replaceChildren();
    return;
  }
  if (tab.session.el.parentElement !== body.value) body.value.replaceChildren(tab.session.el);
  await startTab(props.path, tab);
  fitTab(tab);
  tab.session.term.focus();
  markSeen();
}
watch(active, show);
onMounted(show);

// What a tab's program last said it's doing, as its tooltip says, after its name.
function statusText(status) {
  if (!status) return "";
  if (status.state === "blocked") {
    const why = { permission: "Needs your permission", question: "Has a question", auth: "Needs you to sign in" };
    return why[status.kind] ?? "Waiting on you";
  }
  return { working: "Working", done: "Finished", error: "Stopped with an error" }[status.state] ?? "";
}

// Whether a tab here has finished or needs you, unseen, for the button that shows the panel.
watch(
  () => group.value.tabs.some((tab) => tab.unseen),
  (unseen) => emit("unseen", unseen),
  { immediate: true },
);

// Fits the terminal to the panel as it's resized, once a frame at most.
let frame = 0;
const observer = new ResizeObserver(() => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (!active.value) return;
    fitTab(active.value);
    // Shown again, after the panel was hidden, say.
    markSeen();
  });
});
onMounted(() => observer.observe(body.value));
onBeforeUnmount(() => observer.disconnect());

// Dragging a tab moves it along the row: a line shows where it would land, between
// the tabs, as when arranging branches in the sidebar.
const TAB_TYPE = "application/x-palace-terminal-tab";
const draggedTab = ref(null);
// The index in the row the tab would be put at, or null.
const dropAt = ref(null);
let dragImage = null;

function onTabDragStart(event, tab) {
  draggedTab.value = tab;
  event.dataTransfer.setData(TAB_TYPE, tab.key);
  event.dataTransfer.effectAllowed = "move";

  // A copy of the tab itself, as the shown one looks, held where it was grabbed.
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  dragImage = el.cloneNode(true);
  dragImage.classList.remove("drop-before", "drop-after");
  dragImage.classList.add("active", "dragged");
  dragImage.style.width = `${rect.width}px`;
  document.body.append(dragImage);
  setDragImage(event, dragImage, { x: event.clientX - rect.left, y: event.clientY - rect.top });
}

function onTabDragEnd() {
  draggedTab.value = null;
  dropAt.value = null;
  dragImage?.remove();
  dragImage = null;
}

// Before or after the tab under the pointer, by which half it's over; past the last
// tab, at the end. Nowhere, where the tab already is.
function onTabListDragOver(event) {
  const tab = draggedTab.value;
  if (!tab) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const tabs = group.value.tabs;
  const elements = [...tabList.value.children];
  let at = elements.findIndex((el) => {
    const rect = el.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2;
  });
  if (at === -1) at = tabs.length;
  const from = tabs.indexOf(tab);
  dropAt.value = at === from || at === from + 1 ? null : at;
}

function onTabListDragLeave(event) {
  if (!tabList.value.contains(event.relatedTarget)) dropAt.value = null;
}

// Files dragged in from the desktop and dropped on the terminal: their paths are typed
// in the tab showing (see dropFiles).
function onFileDragOver(event) {
  if (!active.value || !event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}

function onFileDrop(event) {
  if (!active.value || !event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dropFiles(active.value, event.dataTransfer);
}

function onTabListDrop(event) {
  const tab = draggedTab.value;
  const at = dropAt.value;
  if (!tab || at == null) return;
  event.preventDefault();
  const tabs = group.value.tabs;
  const from = tabs.indexOf(tab);
  if (from === -1) return;
  tabs.splice(from, 1);
  tabs.splice(at > from ? at - 1 : at, 0, tab);
  onTabDragEnd();
}

// The line's place: before a tab, or after the last one.
function dropClass(index) {
  if (dropAt.value === index) return "drop-before";
  if (dropAt.value === group.value.tabs.length && index === group.value.tabs.length - 1) return "drop-after";
  return null;
}
onBeforeUnmount(onTabDragEnd);

/** Focuses the shown terminal, as when the panel is shown again. */
function focus() {
  show();
}
defineExpose({ focus });

// Cmd+T, or Ctrl+Shift+T on Linux, where Ctrl+T is the shell's (see App.vue).
const NEW_TAB_KEYS = isMac ? shortcut("Ctrl+T") : "Ctrl+Shift+T";

function newTerminal() {
  openTerminal(props.path);
}

// The repository's agent: what its agent tabs run, and are called.
const command = computed(() => agentCommand(props.path));
const agent = computed(() => agentName(command.value));

// An agent tab running an agent Palace knows checks it's installed first: without it,
// the tab would open to "command not found". Instead it says how to install it, and can
// type the installer into a new terminal to run. A command that starts with something
// else, such as "cd api && claude" or an alias, is the shell's to run, so it isn't
// checked. `run` is the repository's agent command, unless another agent is picked
// from the menu for this one tab.
async function newAgent(run = command.value) {
  const known = AGENTS.find((a) => a.program === programOf(run));
  if (known && !(await invoke("program_available", { program: known.program }).catch(() => true))) {
    const isDefault = run === command.value;
    const install = await askConfirm({
      title: `${known.title} Isn't Installed`,
      message: [
        `${known.name} tabs run ${known.title}, which isn't installed here yet. Its installer, for macOS and Linux, is:`,
        known.install,
        `Palace can type it into a terminal for you to run. Other ways to install it are at ${known.setup}. Once it's installed, open a ${known.name} tab again.`,
        isDefault && "To use another agent instead, change the agent command in the terminal panel's ⋯ menu.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      confirmLabel: "Install in Terminal",
    });
    if (install) openTerminal(props.path, { input: known.install });
    return;
  }
  openTerminal(props.path, { command: run, kind: "agent" });
}

// Which of the agents Palace offers are installed, by program, as last checked: when
// the panel opens, and again each time the ⋯ menu does.
const installed = ref({});
async function checkInstalled() {
  const programs = AGENTS.map((a) => a.program);
  const found = await invoke("programs_available", { programs }).catch(() => null);
  if (found) installed.value = Object.fromEntries(programs.map((program, i) => [program, found[i]]));
}
onMounted(checkInstalled);

async function editAgentCommand() {
  const values = await openForm({
    title: "Agent Command",
    message: `What the ${agent.value} button runs in “${props.name}”: “claude” for Claude Code, or another agent that runs in a terminal, such as “codex” or “gemini”. Shift+Enter starts a new line in the prompts of Claude Code, Codex and Gemini CLI. Leave it empty for “${DEFAULT_AGENT_COMMAND}”.`,
    fields: [{ key: "command", label: "Command", type: "text", value: command.value, placeholder: DEFAULT_AGENT_COMMAND }],
    confirmLabel: "Save",
  });
  if (values) setAgentCommand(props.path, values.command ?? "");
}

// The ⋯ menu: a new tab of the repository's agent, then of each other agent Palace
// offers, for one tab, without changing the repository's. Opening it checks again
// which are installed, and an agent installed since shows so as soon as that's known,
// with the menu still open.
function moreMenu(event) {
  const missing = (program) => (installed.value[program] === false ? "Not installed" : "");
  // By name, as the tab's called: "npx @openai/codex" is Codex, though it runs npx.
  const others = AGENTS.filter((a) => a.name !== agent.value).map((a) => ({
    label: `New ${a.name} Tab`,
    get detail() {
      return missing(a.program);
    },
    action: () => newAgent(a.program),
  }));
  openMenu(event, [
    { label: "New Terminal", action: newTerminal },
    {
      label: `New ${agent.value} Tab`,
      get detail() {
        return missing(programOf(command.value));
      },
      action: () => newAgent(),
    },
    { separator: true },
    ...others,
    { separator: true },
    { label: "Agent Command…", action: editAgentCommand },
    {
      label: `Start ${agent.value} When the Terminal Opens`,
      checked: settings.terminalStartsAgent,
      action: () => (settings.terminalStartsAgent = !settings.terminalStartsAgent),
    },
  ]);
  checkInstalled();
}

// Closing a tab with something still running in it, such as a dev server or Claude
// Code, asks first.
async function closeTab(tab) {
  if (await isBusy(tab)) {
    const ok = await askConfirm({
      title: "Close Terminal",
      message: `Something is still running in “${label(tab)}”. Closing it stops it.`,
      confirmLabel: "Close",
      danger: true,
    });
    if (!ok) return;
  }
  removeTab(props.path, tab);
}

// Closing the last tab, or its shell exiting, hides the panel.
watch(
  () => group.value.tabs.length,
  (count, before) => count === 0 && before > 0 && emit("hide"),
);

function tabMenu(event, tab) {
  openMenu(event, [
    { label: "Close", action: () => closeTab(tab) },
    {
      label: "Close Others",
      disabled: group.value.tabs.length < 2,
      action: async () => {
        for (const other of group.value.tabs.filter((t) => t !== tab)) await closeTab(other);
      },
    },
  ]);
}

function terminalMenu(event) {
  const tab = active.value;
  if (!tab) return;
  event.preventDefault();
  const term = tab.session.term;
  openMenu(event, [
    { label: "Copy", detail: isMac ? "⌘C" : "Ctrl+Shift+C", disabled: !term.hasSelection(), action: () => copySelection(tab) },
    { label: "Paste", detail: isMac ? "⌘V" : "Ctrl+Shift+V", action: () => paste(tab) },
    { label: "Select All", action: () => term.selectAll() },
    { separator: true },
    { label: "Clear", action: () => term.clear() },
  ]);
}

function startResize(event) {
  const startY = event.clientY;
  const startHeight = props.height;
  const target = event.currentTarget;
  target.setPointerCapture(event.pointerId);
  // Not starting a selection in the text the drag begins beside, nor any it crosses.
  event.preventDefault();
  document.body.classList.add("resizing", "resizing-rows");
  const move = (e) => {
    const max = Math.max(160, window.innerHeight - 200);
    emit("update:height", Math.min(max, Math.max(120, startHeight - (e.clientY - startY))));
  };
  // Released, or taken away, as when the window loses the pointer.
  const stop = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("lostpointercapture", stop);
    document.body.classList.remove("resizing", "resizing-rows");
    emit("resized");
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("lostpointercapture", stop);
}
</script>

<template>
  <section class="terminal-panel" :style="{ height: `${height}px` }">
    <div class="resize-edge" @pointerdown="startResize" />
    <header class="terminal-tabs">
      <div
        ref="tabList"
        class="tab-list"
        @dragover="onTabListDragOver"
        @dragleave="onTabListDragLeave"
        @drop="onTabListDrop"
      >
        <div
          v-for="(tab, index) in group.tabs"
          :key="tab.key"
          class="tab"
          :class="[{ active: tab.key === group.active }, dropClass(index)]"
          :title="[label(tab), statusText(tab.status)].filter(Boolean).join(': ')"
          draggable="true"
          @dragstart="onTabDragStart($event, tab)"
          @dragend="onTabDragEnd"
          @click="group.active = tab.key"
          @auxclick.middle="closeTab(tab)"
          @contextmenu.prevent="tabMenu($event, tab)"
        >
          <Spinner v-if="tab.status?.state === 'working'" :size="13" />
          <Sparkle v-else-if="tab.kind === 'agent'" :size="13" :stroke-width="1.75" />
          <SquareTerminal v-else :size="13" :stroke-width="1.75" />
          <span class="tab-label">{{ label(tab) }}</span>
          <span v-if="tab.unseen" class="tab-mark" :class="tab.status?.state" />
          <button class="tab-close" title="Close" @click.stop="closeTab(tab)"><X :size="12" /></button>
        </div>
      </div>
      <button class="icon-button small" :title="`New Terminal (${NEW_TAB_KEYS})`" @click="newTerminal"><Plus :size="15" /></button>
      <button class="agent-button" :title="`New ${agent} tab: ${command}`" @click="newAgent()">
        <Sparkle :size="13" :stroke-width="1.75" /> {{ agent }}
      </button>
      <button class="icon-button small" title="More" @click="moreMenu"><Ellipsis :size="15" /></button>
      <button class="icon-button small" :title="`Hide (${shortcut('Ctrl+\'')})`" @click="emit('hide')"><ChevronDown :size="15" /></button>
    </header>
    <div ref="body" class="terminal-body" @contextmenu="terminalMenu" @dragover="onFileDragOver" @drop="onFileDrop" />
    <div v-if="!group.tabs.length" class="terminal-empty">
      <button class="secondary-button" @click="newTerminal"><SquareTerminal :size="14" /> New Terminal</button>
      <button class="secondary-button" @click="newAgent()"><Sparkle :size="14" /> {{ agent }}</button>
    </div>
  </section>
</template>

<style scoped>
.terminal-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--border);
  border-left: 1px solid var(--border);
  background: var(--content-bg);
}

.resize-edge {
  position: absolute;
  top: -3px;
  right: 0;
  left: 0;
  z-index: 2;
  height: 6px;
  cursor: row-resize;
}

.terminal-tabs {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 34px;
  padding: 0 8px 0 6px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar-bg);
}

.tab-list {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 70px;
  max-width: 220px;
  height: 26px;
  padding: 0 4px 0 9px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--text-secondary);
  cursor: default;
  user-select: none;
}

.tab:hover {
  background: var(--button-hover);
}

/* Where a dragged tab would land: a line in the gap before or after a tab. */
.tab.drop-before::before,
.tab.drop-after::before {
  content: "";
  position: absolute;
  top: 3px;
  bottom: 3px;
  width: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}

.tab.drop-before::before {
  left: -2px;
}

.tab.drop-after::before {
  right: -2px;
}

/* The row scrolls, so clips anything outside it: at the start, the line goes inside. */
.tab:first-child.drop-before::before {
  left: 0;
}

/* The copy of a tab that follows the pointer while it's dragged, kept off the page. */
.tab.dragged {
  position: fixed;
  top: -100px;
  left: 0;
}

.tab.active {
  background: var(--content-bg);
  color: var(--text-primary);
  box-shadow: 0 0 0 1px var(--border);
}

.tab svg {
  flex-shrink: 0;
}

.tab-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* A tab whose program finished or needs you since you last looked at it. */
.tab-mark {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.tab-mark.error {
  background: var(--danger);
}

.tab-close {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--icon);
  opacity: 0;
}

.tab:hover .tab-close,
.tab.active .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: var(--button-hover);
}

.agent-button {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--content-bg);
  font: inherit;
  font-size: 12.5px;
  color: var(--text-primary);
}

.agent-button:hover {
  background: var(--button-hover);
}

.terminal-body {
  flex: 1;
  min-height: 0;
  padding: 6px 0 4px 10px;
  overflow: hidden;
}

.terminal-body :deep(.terminal-host) {
  width: 100%;
  height: 100%;
}

/* xterm cuts each row off at its columns' width, but WebKit rounds the width of every
   letter a little, and across a long row that adds up to a few pixels: enough to cut
   off part of the last letter. The row's letters may run past it into the room kept
   for the scrollbar, still cut off above and below so they don't spill onto the next
   row. */
.terminal-body :deep(.xterm-rows > div) {
  overflow: visible !important;
  clip-path: inset(0 -2ch 0 0);
}

/* xterm draws the selection as solid blocks over the rows, which would hide the
   selected text; the rows paint their selected letters in the selection's color
   themselves, so they go on top, and the blocks fill in past the ends of the lines. */
.terminal-body :deep(.xterm-rows) {
  position: relative;
  z-index: 2;
}

.terminal-empty {
  position: absolute;
  inset: 34px 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.terminal-empty button {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
