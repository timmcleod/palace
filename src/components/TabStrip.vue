<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { Plus, X } from "lucide-vue-next";
import Spinner from "./Spinner.vue";
import { shortcut } from "../lib/platform.js";
import { useTabRowDrag } from "../lib/tabRowDrag.js";
import { tabNames } from "../lib/tabs.js";

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
// Each tab's name, with the folder it's in where two share one (see tabNames).
const names = computed(() => tabNames(props.tabs));
const titleOf = (tab) => [tab.path ?? "Choose a repository to open", agentOf(tab) && SAYS[agentOf(tab)]].filter(Boolean).join("\n");
const detailOf = (tab) => [tab.branch, STATUS[agentOf(tab)]].filter(Boolean).join(" · ");

// --- Dragging a tab to move it ------------------------------------------------------
// Along the row, as a terminal's tab is along its (see tabRowDrag.js).

// The tabs' row, across the window, which a tab can be dropped on, and their list in it.
const strip = ref(null);
const list = ref(null);

const { press, dragging, classOf } = useTabRowDrag({
  row: strip,
  list,
  keys: () => props.tabs.map((tab) => tab.id),
  move: (id, to) => emit("move", id, to),
});

function onPointerDown(event, tab) {
  if (event.button !== 0 || event.target.closest(".close")) return;
  press(event, tab.id);
}

// --- The row scrolling -----------------------------------------------------------------
// With more tabs than fit, the row scrolls sideways, its scrollbar hidden.

// The tab that comes to show is scrolled into the row, however it was chosen, as by
// Cmd+9, or opened at the end.
watch(
  () => props.active,
  async () => {
    await nextTick();
    list.value?.querySelector(".tab.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  },
);

// A mouse's wheel scrolls it too, as one without a trackpad has no other way.
function onWheel(event) {
  if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  list.value.scrollLeft += event.deltaY;
}

</script>

<template>
  <nav ref="strip" class="tab-strip" aria-label="Tabs">
    <div ref="list" class="tabs tab-row" :class="{ sorting: dragging != null }" role="tablist" @wheel="onWheel">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="[{ active: tab.id === active }, classOf(tab.id)]"
        :data-key="tab.id"
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
          <span class="name">{{ names.get(tab.id) }}</span>
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
  /* See styles.css, where what's below it makes room for it. */
  height: var(--tab-row-height);
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

/* See .tab-row in styles.css, for dragging a tab along it. */
.tabs {
  --tab-gap: 6px;
  display: flex;
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
  background: var(--tab-active-bg);
  color: var(--text-primary);
}

.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
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
  color: var(--text-secondary);
}

/* Only on the tab under the pointer, or the one showing. */
.close {
  flex-shrink: 0;
  visibility: hidden;
}

.tab:hover .close,
.tab.active .close,
.tab:focus-visible .close,
.close:focus-visible {
  visibility: visible;
}

.open {
  flex-shrink: 0;
}
</style>
