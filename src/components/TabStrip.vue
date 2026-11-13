<script setup>
import { onBeforeUnmount, ref } from "vue";
import { Plus, X } from "lucide-vue-next";
import Spinner from "./Spinner.vue";
import { shortcut } from "../lib/platform.js";
import { dropPlace } from "../lib/tabs.js";

// The window's tabs, down its left side (see tabs.js): each named for its repository,
// with the branch checked out there, and what its agents are doing, as Worktrees shows
// it. Clicking one shows it; its × closes it; dragging it moves it among the others;
// + Open opens a tab to choose a repository in. Where it's empty, it's the title bar
// (see titleBar.js).
const props = defineProps({
  tabs: { type: Array, required: true },
  active: { type: Number, default: null },
  // What each repository's agents are doing, by path (see agentStates.js).
  agents: { type: Object, default: () => ({}) },
});
const emit = defineEmits(["select", "close", "new", "move"]);

const SAYS = { working: "Its agent is working", blocked: "Its agent needs you", done: "Its agent has finished", error: "Its agent stopped with an error" };
const agentOf = (tab) => (tab.path ? props.agents[tab.path] : null);
const titleOf = (tab) => [tab.path ?? "Choose a repository to open", agentOf(tab) && SAYS[agentOf(tab)]].filter(Boolean).join("\n");

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
  const at = { id: Number(element.dataset.id), after: event.clientY >= rect.top + rect.height / 2 };
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
    <div ref="list" class="tabs" role="tablist" aria-orientation="vertical">
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
        <span class="mark">
          <Spinner v-if="agentOf(tab) === 'working'" :size="12" />
          <span v-else-if="agentOf(tab)" class="dot" :class="agentOf(tab)" />
        </span>
        <span class="text">
          <span class="name">{{ tab.name ?? "New Tab" }}</span>
          <span v-if="tab.branch" class="branch">{{ tab.branch }}</span>
        </span>
        <button class="close icon-button small" :title="`Close Tab (${shortcut('Ctrl+W')})`" aria-label="Close Tab" @click.stop="emit('close', tab.id)">
          <X :size="13" />
        </button>
      </div>
    </div>
    <button class="open" :title="`New Tab (${shortcut('Ctrl+N')})`" @click="emit('new')">
      <Plus :size="15" :stroke-width="1.75" />
      Open
    </button>
  </nav>
</template>

<style scoped>
.tab-strip {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 180px;
  height: 100vh;
  box-sizing: border-box;
  padding: 8px 6px;
  border-right: 1px solid var(--border);
  background: var(--sidebar-bg);
  user-select: none;
}

/* Below the macOS window buttons, which sit at the top of the strip. */
:root[data-title-bar="overlay"] .tab-strip {
  padding-top: 38px;
}

.tabs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 4px 6px 6px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: default;
}

.tab:hover {
  background: var(--row-hover);
}

.tab.active {
  background: var(--row-selected);
  color: var(--text-primary);
}

.tab {
  position: relative;
}

.tab.dragging {
  opacity: 0.5;
}

/* Where a dragged tab would land, as in the sidebar. */
.tab.drop-before::before,
.tab.drop-after::before {
  content: "";
  position: absolute;
  right: 4px;
  left: 4px;
  height: 2px;
  border-radius: var(--radius-xs);
  background: var(--accent-fill);
  pointer-events: none;
}

.tab.drop-before::before {
  top: -2px;
}

.tab.drop-after::before {
  bottom: -2px;
}

.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.mark {
  display: flex;
  flex-shrink: 0;
  justify-content: center;
  width: 12px;
  color: var(--accent);
}

/* Finished, or needs you, and red for an error, as a terminal tab's mark. */
.dot {
  width: 7px;
  height: 7px;
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
.branch {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.name {
  font-size: var(--font-ui);
  font-weight: 500;
}

.branch {
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
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 6px;
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-ui);
  cursor: default;
}

.open:hover {
  background: var(--row-hover);
  color: var(--text-primary);
}
</style>
