<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Ellipsis, Plus, Sparkle, SquareTerminal, X } from "lucide-vue-next";
import { askConfirm, openForm, openMenu } from "../lib/overlays.js";
import { isMac } from "../lib/platform.js";
import {
  CLAUDE_INSTALL,
  CLAUDE_SETUP_URL,
  claudeCommand,
  copySelection,
  DEFAULT_CLAUDE_COMMAND,
  fitTab,
  isBusy,
  openTerminal,
  paste,
  programOf,
  removeTab,
  setClaudeCommand,
  startTab,
  tabLabel as label,
  tabsFor,
} from "../lib/terminals.js";

// The panel below the history and details: the repository's terminals, in tabs. A
// Claude tab runs Claude Code, with the command set for the repository.
const props = defineProps({
  path: { type: String, required: true },
  name: { type: String, required: true },
  // Its height in pixels, which dragging its top edge changes.
  height: { type: Number, required: true },
});
const emit = defineEmits(["update:height", "resized", "hide"]);

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
}
watch(active, show);
onMounted(show);

// Fits the terminal to the panel as it's resized, once a frame at most.
let frame = 0;
const observer = new ResizeObserver(() => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => active.value && fitTab(active.value));
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

  dragImage = document.createElement("div");
  dragImage.className = "drag-image";
  const icon = event.currentTarget.querySelector("svg")?.cloneNode(true);
  if (icon) dragImage.append(icon);
  dragImage.append(label(tab));
  document.body.append(dragImage);
  event.dataTransfer.setDragImage(dragImage, 14, dragImage.offsetHeight / 2);
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

function newTerminal() {
  openTerminal(props.path);
}

// A Claude tab running Claude Code checks it's installed first: without it, the tab
// would open to "command not found". Instead it says how to install it, and can type
// the installer into a new terminal to run. A command that starts with something else,
// such as "cd api && claude" or an alias, is the shell's to run, so it isn't checked.
async function newClaude() {
  const command = claudeCommand(props.path);
  const checked = programOf(command) === DEFAULT_CLAUDE_COMMAND;
  if (checked && !(await invoke("program_available", { program: DEFAULT_CLAUDE_COMMAND }).catch(() => true))) {
    const install = await askConfirm({
      title: "Claude Code Isn't Installed",
      message: `Claude tabs run Claude Code, which isn't installed here yet. Anthropic's installer, for macOS and Linux, is:\n\n${CLAUDE_INSTALL}\n\nPalace can type it into a terminal for you to run. Other ways to install it are at ${CLAUDE_SETUP_URL}. Once it's installed, open a Claude tab again.`,
      confirmLabel: "Install in Terminal",
    });
    if (install) openTerminal(props.path, { input: CLAUDE_INSTALL });
    return;
  }
  openTerminal(props.path, { command, kind: "claude" });
}

async function editClaudeCommand() {
  const values = await openForm({
    title: "Claude Command",
    message: `What new Claude tabs run in “${props.name}”. Leave it empty for “${DEFAULT_CLAUDE_COMMAND}”.`,
    fields: [{ key: "command", label: "Command", type: "text", value: claudeCommand(props.path), placeholder: DEFAULT_CLAUDE_COMMAND }],
    confirmLabel: "Save",
  });
  if (values) setClaudeCommand(props.path, values.command ?? "");
}

function moreMenu(event) {
  openMenu(event, [
    { label: "New Terminal", action: newTerminal },
    { label: "New Claude Tab", detail: claudeCommand(props.path), action: newClaude },
    { separator: true },
    { label: "Claude Command…", action: editClaudeCommand },
  ]);
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
  const move = (e) => {
    const max = Math.max(160, window.innerHeight - 200);
    emit("update:height", Math.min(max, Math.max(120, startHeight - (e.clientY - startY))));
  };
  const stop = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", stop);
    emit("resized");
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", stop);
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
          :title="label(tab)"
          draggable="true"
          @dragstart="onTabDragStart($event, tab)"
          @dragend="onTabDragEnd"
          @click="group.active = tab.key"
          @auxclick.middle="closeTab(tab)"
          @contextmenu.prevent="tabMenu($event, tab)"
        >
          <Sparkle v-if="tab.kind === 'claude'" :size="13" :stroke-width="1.75" />
          <SquareTerminal v-else :size="13" :stroke-width="1.75" />
          <span class="tab-label">{{ label(tab) }}</span>
          <button class="tab-close" title="Close" @click.stop="closeTab(tab)"><X :size="12" /></button>
        </div>
      </div>
      <button class="icon-button small" title="New Terminal" @click="newTerminal"><Plus :size="15" /></button>
      <button class="claude-button" :title="`New Claude tab: ${claudeCommand(path)}`" @click="newClaude">
        <Sparkle :size="13" :stroke-width="1.75" /> Claude
      </button>
      <button class="icon-button small" title="More" @click="moreMenu"><Ellipsis :size="15" /></button>
      <button class="icon-button small" title="Hide" @click="emit('hide')"><ChevronDown :size="15" /></button>
    </header>
    <div ref="body" class="terminal-body" @contextmenu="terminalMenu" />
    <div v-if="!group.tabs.length" class="terminal-empty">
      <button class="secondary-button" @click="newTerminal"><SquareTerminal :size="14" /> New Terminal</button>
      <button class="secondary-button" @click="newClaude"><Sparkle :size="14" /> Claude</button>
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

.claude-button {
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

.claude-button:hover {
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
