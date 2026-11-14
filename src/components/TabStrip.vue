<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { Check, GitBranch, Plus, X } from "lucide-vue-next";
import Spinner from "./Spinner.vue";
import { shortcut } from "../lib/platform.js";
import { useTabRowDrag } from "../lib/tabRowDrag.js";
import { isWorktree, tabColor, tabDetails, tabInitial, tabNames } from "../lib/tabs.js";

// The window's tabs, across its top (see tabs.js): each a card naming its repository,
// known by a tile in its color, with its initial, or for a worktree, the branch mark in
// its repository's; and below its name, the branch checked out there, what its agents
// are doing, and what it has to push, pull and commit. Its agents' state is on its tile
// too, at its corner: the spinner while one works, a dot when one's finished, needs the
// user, or has stopped. Clicking one shows it; its × closes it; dragging it moves it
// among the others; + opens a tab to choose a repository in. Where it's empty, it's the
// title bar (see titleBar.js), with the macOS window buttons at its left.
const props = defineProps({
  tabs: { type: Array, required: true },
  active: { type: Number, default: null },
  // What each repository's agents are doing, by path (see agentStates.js).
  agents: { type: Object, default: () => ({}) },
});
const emit = defineEmits(["select", "close", "new", "move"]);

// What its agents doing says in full in its tooltip.
const SAYS = { working: "Its agent is working", blocked: "Its agent needs you", done: "Its agent has finished", error: "Its agent stopped with an error" };
const agentOf = (tab) => (tab.path ? props.agents[tab.path] : null);
// Each tab's name, with the folder it's in where two share one (see tabNames).
const names = computed(() => tabNames(props.tabs));
// The folder before its name, where another tab's has the same, shown fainter.
const parentOf = (tab) => {
  const name = names.value.get(tab.id);
  return tab.name && name !== tab.name ? name.slice(0, -tab.name.length) : "";
};
const titleOf = (tab) => [tab.path ?? "Choose a repository to open", agentOf(tab) && SAYS[agentOf(tab)]].filter(Boolean).join("\n");
// Its color, as --tab-color, for its tile and the line under it showing (see tabColor):
// the graph's, so it's muted with the graph while the window's in the background.
const colorOf = (tab) => (tabColor(tab) ? { "--tab-color": `var(--graph-${tabColor(tab)})` } : null);

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
        :style="colorOf(tab)"
        role="tab"
        :aria-selected="tab.id === active"
        tabindex="0"
        :title="titleOf(tab)"
        @pointerdown="onPointerDown($event, tab)"
        @click="emit('select', tab.id)"
        @keydown.enter.space.prevent="emit('select', tab.id)"
        @auxclick.middle="emit('close', tab.id)"
      >
        <span v-if="tab.path" class="tile" :class="agentOf(tab)" aria-hidden="true">
          <GitBranch v-if="isWorktree(tab)" :size="13" :stroke-width="2.25" />
          <template v-else>{{ tabInitial(tab.name) }}</template>
          <span v-if="agentOf(tab) === 'working'" class="spinning"><Spinner :size="11" /></span>
          <span v-else-if="agentOf(tab)" class="badge">
            <Check v-if="agentOf(tab) === 'done'" :size="7" :stroke-width="4" />
          </span>
        </span>
        <span class="text">
          <span class="name"><span v-if="parentOf(tab)" class="parent">{{ parentOf(tab) }}</span>{{ tab.name ?? names.get(tab.id) }}</span>
          <span v-if="tabDetails(tab, agentOf(tab)).length" class="detail">
            <span v-for="part in tabDetails(tab, agentOf(tab))" :key="part.kind" :class="part.kind">{{ part.text }}</span>
          </span>
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
  /* 2px less at its left than its right, which the tabs' list has inside it. */
  padding: 0 10px 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--sunken-bg);
  user-select: none;
}

/* Beside the macOS window buttons, which sit at the row's left, in its middle (see
   tauri.macos.conf.json), where they are with no tabs too: the window can't move them. */
:root[data-title-bar="overlay"] .tab-strip {
  padding-left: 84px;
}

/* See .tab-row in styles.css, for dragging a tab along it. Room around the tabs, inside
   it, for the showing one's edge and shadow: scrolling, it cuts off what's outside it. */
.tabs {
  --tab-gap: 6px;
  display: flex;
  min-width: 0;
  padding: 4px 2px;
  overflow-x: auto;
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

/* A width of its own, which the row makes room for, rather than one from its name,
   which would have the row too narrow for its tabs: then they shrink, as there are
   more, to their least, and the row scrolls. Those not showing are each a shade off the
   row, so they read as tabs rather than words floating on it, and solid rather than a
   see-through tint, so the ring around a tile's badge (--tab-bg) matches them; the one
   showing is lifted off it, with a line in its color along its foot. */
.tab {
  --tab-bg: color-mix(in srgb, var(--text-primary) 5%, var(--sunken-bg));
  position: relative;
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 9px;
  width: 240px;
  min-width: 140px;
  height: 38px;
  box-sizing: border-box;
  padding: 0 6px 0 7px;
  border-radius: var(--radius-xl);
  background: var(--tab-bg);
  color: var(--text-secondary);
  cursor: default;
}

.tab:hover {
  --tab-bg: color-mix(in srgb, var(--text-primary) 9%, var(--sunken-bg));
}

.tab.active,
.tab.following {
  --tab-bg: var(--tab-active-bg);
  background: var(--tab-active-bg);
  color: var(--text-primary);
  box-shadow:
    0 0 0 1px var(--border),
    0 1px 2px rgb(0 0 0 / 6%),
    0 3px 10px rgb(0 0 0 / 5%);
}

.tab.active::after {
  content: "";
  position: absolute;
  right: 14px;
  bottom: 0;
  left: 14px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--tab-color, var(--accent));
}

/* Its copy following the pointer as it's dragged, picked up off the row: tilted a
   little, with a deeper shadow. Turned and scaled apart from the transform that places
   it (see rowDrag.js). */
.tab.following {
  rotate: -1.5deg;
  scale: 1.03;
  box-shadow:
    0 0 0 1px var(--border),
    0 12px 28px rgb(0 0 0 / 18%),
    0 2px 6px rgb(0 0 0 / 8%);
}

.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

/* Its repository's initial, or a worktree's branch mark, on a tint of its color. */
.tile {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--tab-color) 14%, transparent);
  color: color-mix(in srgb, var(--tab-color) 78%, var(--text-primary));
  font-size: var(--font-sm);
  font-weight: 700;
}

/* An agent working: the spinner at the tile's corner, where its dot would be, on the
   tab's color, to stand off the tile. Not .working, which the tile is, as it's
   classed by its agent's state. */
.spinning {
  position: absolute;
  top: -6px;
  right: -6px;
  display: flex;
  padding: 1px;
  border-radius: 50%;
  background: var(--tab-bg);
  color: var(--accent);
}

/* An agent finished, with a check; needing the user; or stopped with an error. Ringed
   in the tab's own color, to stand off the tile. */
.badge {
  position: absolute;
  top: -3px;
  right: -3px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--tab-bg);
  color: #fff;
}

.done .badge {
  top: -4px;
  right: -4px;
  width: 11px;
  height: 11px;
  background: var(--graph-4);
}

.blocked .badge {
  background: var(--graph-5);
}

.error .badge {
  background: var(--danger);
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
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

.parent {
  font-weight: 400;
  color: var(--text-tertiary);
}

.detail {
  display: flex;
  gap: 6px;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.detail > span {
  flex-shrink: 0;
}

.detail > .branch {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* What needs the user stands out from the rest, as its tile's dot does. */
.detail > .attention {
  font-weight: 500;
  color: var(--text-primary);
}

/* Changes not committed, with a dot of the color modified files have. */
.detail > .changes {
  display: flex;
  align-items: center;
  gap: 3px;
}

.detail > .changes::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-steady);
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
