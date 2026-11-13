<script setup>
import { onBeforeUnmount, ref } from "vue";
import { Plus, X } from "lucide-vue-next";
import Spinner from "./Spinner.vue";
import { shortcut } from "../lib/platform.js";
import { dropPlace } from "../lib/tabs.js";

// The window's tabs, across its top (see tabs.js): each a card naming its repository,
// with the branch checked out there and what its agents are doing below, as Worktrees
// shows it. Clicking one shows it; its × closes it; dragging it moves it among the
// others; + opens a tab to choose a repository in. Where it's empty, it's the title bar
// (see titleBar.js), with the macOS window buttons at its left.
const props = defineProps({
  tabs: { type: Array, required: true },
  active: { type: Number, default: null },
  // What each repository's agents are doing, by path (see agentStates.js).
  agents: { type: Object, default: () => ({}) },
});
const emit = defineEmits(["select", "close", "new", "move"]);

// What its agents doing says, below its name, and in full in its tooltip.
const STATUS = { working: "agent working", blocked: "needs you", done: "finished", error: "stopped with an error" };
const SAYS = { working: "Its agent is working", blocked: "Its agent needs you", done: "Its agent has finished", error: "Its agent stopped with an error" };
const agentOf = (tab) => (tab.path ? props.agents[tab.path] : null);
const titleOf = (tab) => [tab.path ?? "Choose a repository to open", agentOf(tab) && SAYS[agentOf(tab)]].filter(Boolean).join("\n");
const detailOf = (tab) => [tab.branch, STATUS[agentOf(tab)]].filter(Boolean).join(" · ");

// --- Dragging a tab to move it ------------------------------------------------------
// As a branch is dragged in the sidebar (see Sidebar.vue): its name follows the pointer,
// and a line shows where it would land; Escape, or dropping it anywhere else, leaves it.

// How far the pointer moves, pressed, before it's a drag rather than a click.
const DRAG_DISTANCE = 4;

// The tabs' list, which a tab can be dropped in.
const list = ref(null);

// The tab being dragged, and where it would land: { id, after }, before or after the
// tab `id`, or null for nowhere.
const dragging = ref(null);
const dropAt = ref(null);
// The press that may become a drag, the pointer, and what follows it.
let pressed = null;
let dragImage = null;

function onPointerDown(event, tab) {
  if (event.button !== 0 || event.target.closest(".close")) return;
  pressed = { tab, x: event.clientX, y: event.clientY };
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", endDrag, true);
  window.addEventListener("keydown", onDragKey, true);
  window.addEventListener("blur", endDrag);
}

function startDrag() {
  dragging.value = pressed.tab.id;
  dragImage = document.createElement("div");
  dragImage.className = "drag-image following";
  dragImage.textContent = pressed.tab.name ?? "New Tab";
  document.body.append(dragImage);
  document.body.classList.add("dragging-row");
  window.getSelection()?.removeAllRanges();
}

function onPointerMove(event) {
  if (!pressed) return;
  if (!dragging.value) {
    if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < DRAG_DISTANCE) return;
    startDrag();
  }
  event.preventDefault();
  // Held 14px into its left end, at its middle, and kept in the window.
  const { offsetWidth: width, offsetHeight: height } = dragImage;
  const x = Math.min(Math.max(event.clientX - 14, 0), innerWidth - width);
  const y = Math.min(Math.max(event.clientY - height / 2, 0), innerHeight - height);
  dragImage.style.transform = `translate(${x}px, ${y}px)`;
  dragImage.style.visibility = "visible";
  dropAt.value = landing(event);
}

// Where it would land: before or after the tab under the pointer, by which half it's
// over, unless that leaves it where it is.
function landing(event) {
  const element = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".tab");
  if (!element || !list.value?.contains(element)) return null;
  const rect = element.getBoundingClientRect();
  const at = { id: Number(element.dataset.id), after: event.clientX >= rect.left + rect.width / 2 };
  return dropPlace({ list: props.tabs }, dragging.value, at.id, at.after) == null ? null : at;
}

function onDragKey(event) {
  if (!dragging.value || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  endDrag();
}

function onPointerUp() {
  const id = dragging.value;
  const at = dropAt.value;
  endDrag();
  if (!id) return;
  // The click that follows the release isn't one.
  window.addEventListener("click", swallowClick, true);
  setTimeout(() => window.removeEventListener("click", swallowClick, true));
  const to = at && dropPlace({ list: props.tabs }, id, at.id, at.after);
  if (to != null) emit("move", id, to);
}

function swallowClick(event) {
  event.stopPropagation();
  window.removeEventListener("click", swallowClick, true);
}

function endDrag() {
  pressed = null;
  dragging.value = null;
  dropAt.value = null;
  window.removeEventListener("pointermove", onPointerMove, true);
  window.removeEventListener("pointerup", onPointerUp, true);
  window.removeEventListener("pointercancel", endDrag, true);
  window.removeEventListener("keydown", onDragKey, true);
  window.removeEventListener("blur", endDrag);
  document.body.classList.remove("dragging-row");
  dragImage?.remove();
  dragImage = null;
}

onBeforeUnmount(endDrag);

// The line where it would land, on the tab it's next to.
const dropClass = (tab) => (dropAt.value?.id === tab.id ? (dropAt.value.after ? "drop-after" : "drop-before") : null);
</script>

<template>
  <nav class="tab-strip" aria-label="Tabs">
    <div ref="list" class="tabs" role="tablist">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="[{ active: tab.id === active, dragging: tab.id === dragging }, dropClass(tab)]"
        :data-id="tab.id"
        role="tab"
        :aria-selected="tab.id === active"
        tabindex="0"
        :title="titleOf(tab)"
        @pointerdown="onPointerDown($event, tab)"
        @click="emit('select', tab.id)"
        @keydown.enter.space.prevent="emit('select', tab.id)"
        @auxclick.middle="emit('close', tab.id)"
      >
        <span v-if="agentOf(tab)" class="mark">
          <Spinner v-if="agentOf(tab) === 'working'" :size="14" />
          <span v-else class="dot" :class="agentOf(tab)" />
        </span>
        <span class="text">
          <span class="name">{{ tab.name ?? "New Tab" }}</span>
          <span v-if="detailOf(tab)" class="detail">{{ detailOf(tab) }}</span>
        </span>
        <button class="close icon-button small" :title="`Close Tab (${shortcut('Ctrl+W')})`" aria-label="Close Tab" @click.stop="emit('close', tab.id)">
          <X :size="13" />
        </button>
      </div>
    </div>
    <button class="open icon-button" :title="`New Tab (${shortcut('Ctrl+T')})`" aria-label="New Tab" @click="emit('new')">
      <Plus :size="16" :stroke-width="1.75" />
    </button>
  </nav>
</template>

<style scoped>
.tab-strip {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 48px;
  box-sizing: border-box;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--sunken-bg);
  user-select: none;
}

/* Beside the macOS window buttons, which sit at the row's left, in its middle (see
   tauri.macos.conf.json), where they are with no tabs too: the window can't move them. */
:root[data-title-bar="overlay"] .tab-strip {
  padding-left: 86px;
}

.tabs {
  display: flex;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

/* A width of its own, which the row makes room for, rather than one from its name,
   which would have the row too narrow for its tabs: then they shrink, as there are
   more, to their least, and the row scrolls. */
.tab {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 9px;
  width: 240px;
  min-width: 140px;
  height: 38px;
  box-sizing: border-box;
  padding: 0 6px 0 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  /* Those not showing sit on the toolbars' groups' fill, rather than float. */
  background: var(--toolbar-group-bg);
  color: var(--text-secondary);
  cursor: default;
}

.tab:hover {
  background: var(--button-hover);
}

.tab.active {
  border-color: color-mix(in srgb, var(--border) 65%, var(--text-tertiary));
  background: var(--sidebar-bg);
  color: var(--text-primary);
}

.tab.dragging {
  opacity: 0.5;
}

.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

/* Where a dragged tab would land, as in the sidebar, standing between tabs. */
.tab.drop-before::before,
.tab.drop-after::before {
  content: "";
  position: absolute;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: var(--radius-xs);
  background: var(--accent-fill);
  pointer-events: none;
}

.tab.drop-before::before {
  left: -5px;
}

.tab.drop-after::before {
  right: -5px;
}

.mark {
  display: flex;
  flex-shrink: 0;
  justify-content: center;
  width: 14px;
  color: var(--accent);
}

/* Finished, or needs you, and red for an error, as a terminal tab's mark. */
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-fill);
}

.dot.error {
  background: var(--danger);
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.name,
.detail {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.name {
  font-size: var(--font-ui);
  font-weight: 500;
}

.tab.active .name {
  font-weight: 600;
}

.detail {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

/* Only on the tab under the pointer, or the one showing. */
.close {
  flex-shrink: 0;
  visibility: hidden;
}

.tab:hover .close,
.tab.active .close,
.tab:focus-within .close {
  visibility: visible;
}

.open {
  flex-shrink: 0;
}
</style>
