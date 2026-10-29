<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, History, Search } from "lucide-vue-next";
import Avatar from "./Avatar.vue";
import CommitGraph from "./CommitGraph.vue";

const props = defineProps({
  path: { type: String, required: true },
  rev: { type: String, default: null },
  // Leaves out the commits this revision has, to list only what `rev` adds to it.
  hide: { type: String, default: null },
  // Only commits that changed this file.
  file: { type: String, default: null },
  // Only commits matching this search.
  search: { type: String, default: "" },
  refreshKey: { type: Number, default: 0 },
  selectedId: { type: String, default: null },
  // Whether commits can be dragged to reorder them: only in the current branch's own
  // history.
  editable: { type: Boolean, default: false },
});
// "menu-many" is the context menu for several selected commits; "move" asks to move a
// dragged commit above or below another; "count" reports how many commits are listed.
const emit = defineEmits(["select", "menu", "menu-many", "move", "count"]);

const ROW_HEIGHT = 46;
const HEADER_HEIGHT = 34;
const PAGE_SIZE = 100;
const OVERSCAN = 400;

const summary = shallowRef(null);
const pages = shallowReactive(new Map());
const error = ref("");
const viewport = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);

// Index of the selected commit in the list, used for keyboard navigation.
let selectedIndex = -1;

// --- Loading ---------------------------------------------------------------

let loadSeq = 0;
const inflight = new Set();

async function load({ resetScroll }) {
  const seq = ++loadSeq;
  try {
    const next = await invoke("load_history", {
      path: props.path,
      rev: props.rev,
      hide: props.hide,
      file: props.file,
      search: props.search || null,
    });
    if (seq !== loadSeq) return;
    error.value = "";
    // An unchanged generation means nothing moved; keep the rows already on screen.
    if (next.generation === summary.value?.generation) return;
    pages.clear();
    summary.value = next;
    emit("count", next.total);
    if (resetScroll && viewport.value) {
      viewport.value.scrollTop = 0;
      scrollTop.value = 0;
      // Showing another branch's history keeps the selected commit in view, if it's there.
      pendingReveal = props.selectedId;
      chosen.clear();
    }
    selectedIndex = -1;
  } catch (e) {
    if (seq !== loadSeq) return;
    summary.value = null;
    error.value = String(e);
  }
}

async function loadPage(page) {
  const generation = summary.value.generation;
  const key = `${generation}:${page}`;
  if (pages.has(page) || inflight.has(key)) return;

  inflight.add(key);
  try {
    const rows = await invoke("history_page", { generation, offset: page * PAGE_SIZE, limit: PAGE_SIZE });
    if (summary.value?.generation === generation) {
      pages.set(page, rows);
    }
  } catch {
    // The history was reloaded underneath us; the new load fetches its own pages.
  } finally {
    inflight.delete(key);
  }
}

function commitAt(index) {
  return pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];
}

watch(
  () => [props.path, props.rev, props.hide, props.file, props.search],
  () => load({ resetScroll: true }),
  { immediate: true },
);
watch(
  () => props.refreshKey,
  () => load({ resetScroll: false }),
);

// --- Layout ----------------------------------------------------------------
// Rows are commits with a header before each new month. Every item's offset is
// precomputed from the commit times, so the list can be virtualized before any
// commit details have loaded.

const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

const layout = computed(() => {
  const items = [];
  const offsets = [];
  const itemOfCommit = new Int32Array(summary.value?.times.length ?? 0);
  let y = 0;
  let previousMonth = null;

  summary.value?.times.forEach((time, index) => {
    const date = new Date(time * 1000);
    const month = date.getFullYear() * 12 + date.getMonth();
    if (month !== previousMonth) {
      items.push({ header: true, label: monthFormat.format(date).toUpperCase(), next: index });
      offsets.push(y);
      y += HEADER_HEIGHT;
      previousMonth = month;
    }
    itemOfCommit[index] = items.length;
    items.push({ header: false, index });
    offsets.push(y);
    y += ROW_HEIGHT;
  });

  return { items, offsets, itemOfCommit, height: y };
});

// Binary search for the last item that starts at or above `y`.
function itemAt(y) {
  const { offsets } = layout.value;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const visible = computed(() => {
  const { items, offsets } = layout.value;
  if (!items.length) return [];

  const bottom = scrollTop.value + viewportHeight.value + OVERSCAN;
  const result = [];
  for (let i = itemAt(Math.max(0, scrollTop.value - OVERSCAN)); i < items.length && offsets[i] < bottom; i++) {
    const item = items[i];
    result.push({ ...item, key: i, top: offsets[i], commit: commitAt(item.header ? item.next : item.index) });
  }
  return result;
});

watch(visible, (items) => {
  const needed = new Set(items.map((item) => Math.floor((item.header ? item.next : item.index) / PAGE_SIZE)));
  needed.forEach(loadPage);
});

// --- Interaction -----------------------------------------------------------

function select(index) {
  const commit = commitAt(index);
  if (!commit) return;
  selectedIndex = index;
  pickedHere = commit.id;
  emit("select", commit);
}

// --- Selecting several commits ---------------------------------------------------
// Ctrl+click adds or removes a commit, Shift+click selects a range. The details show
// the commit clicked last; right-clicking the selection offers what works on several.

// Selected commits beyond the one shown, by id, with their places in the list.
const chosen = shallowReactive(new Map());

function onClick(index, event) {
  const commit = commitAt(index);
  if (!commit) return;
  if (event.shiftKey && selectedIndex >= 0) {
    const [from, to] = selectedIndex < index ? [selectedIndex, index] : [index, selectedIndex];
    chosen.clear();
    for (let i = from; i <= to; i++) {
      const c = commitAt(i);
      if (c) chosen.set(c.id, { commit: c, index: i });
    }
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    // The commit shown so far joins the selection the first time.
    const shown = commitAt(selectedIndex);
    if (!chosen.size && shown && shown.id !== commit.id) chosen.set(shown.id, { commit: shown, index: selectedIndex });
    if (chosen.has(commit.id)) {
      chosen.delete(commit.id);
      return;
    }
    chosen.set(commit.id, { commit, index });
    select(index);
    return;
  }
  chosen.clear();
  select(index);
}

const isChosen = (commit) => commit && (commit.id === props.selectedId || chosen.has(commit.id));

function onContextMenu(index, event) {
  const commit = commitAt(index);
  if (!commit) return;
  if (chosen.size > 1 && chosen.has(commit.id)) {
    // Newest first, as listed.
    const many = [...chosen.values()].sort((a, b) => a.index - b.index);
    emit("menu-many", many, event);
    return;
  }
  chosen.clear();
  select(index);
  emit("menu", commit, event);
}

// --- Dragging to reorder ---------------------------------------------------------

const DRAG_EDGE = 40;
let dragged = null;
// Where a dropped commit would go: { index, above }.
const dropAt = ref(null);

const canDrag = (commit) => props.editable && commit && !commit.incoming;

function onDragStart(index, event) {
  const commit = commitAt(index);
  if (!canDrag(commit)) {
    event.preventDefault();
    return;
  }
  dragged = { commit, index };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", commit.short_id);
  // A compact image of what's being moved, like a branch dragged in the sidebar.
  const image = document.createElement("div");
  image.className = "drag-image";
  image.textContent = `${commit.short_id}  ${commit.summary}`;
  document.body.append(image);
  event.dataTransfer.setDragImage(image, 14, image.offsetHeight / 2);
  dragged.image = image;
}

function onDragOver(index, event) {
  const target = commitAt(index);
  if (!dragged || !canDrag(target)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const rect = event.currentTarget.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  // Dropping a commit right where it is changes nothing.
  const same = target.id === dragged.commit.id || (above ? index === dragged.index + 1 : index === dragged.index - 1);
  dropAt.value = same ? null : { index, above };
}

// While dragging near the top or bottom of the list, it scrolls.
function onViewportDragOver(event) {
  if (!dragged) return;
  const rect = viewport.value.getBoundingClientRect();
  if (event.clientY < rect.top + DRAG_EDGE) viewport.value.scrollTop -= 12;
  else if (event.clientY > rect.bottom - DRAG_EDGE) viewport.value.scrollTop += 12;
}

function onDrop(index, event) {
  if (!dragged || !dropAt.value) return onDragEnd();
  event.preventDefault();
  const target = { commit: commitAt(index), index };
  const move = { commit: dragged.commit, index: dragged.index };
  const above = dropAt.value.above;
  onDragEnd();
  emit("move", move, target, above ? "above" : "below");
}

function onDragEnd() {
  dragged?.image?.remove();
  dragged = null;
  dropAt.value = null;
}

// The line showing where a dragged commit would land.
const dropLine = computed(() => {
  if (!dropAt.value) return null;
  const top = layout.value.offsets[layout.value.itemOfCommit[dropAt.value.index]];
  return top + (dropAt.value.above ? 0 : ROW_HEIGHT);
});

// A commit selected from outside the list, by going back to it say, is scrolled into
// view: straight away, or once the history it's in has loaded.
let pickedHere = null;
let pendingReveal = null;

watch(
  () => props.selectedId,
  (id) => {
    pendingReveal = id && id !== pickedHere ? id : null;
    pickedHere = null;
    reveal();
  },
);
watch(() => summary.value?.generation, reveal);

async function reveal() {
  const id = pendingReveal;
  const generation = summary.value?.generation;
  if (!id || !generation) return;
  pendingReveal = null;
  const index = await invoke("history_position", { generation, id }).catch(() => null);
  if (index == null || summary.value?.generation !== generation || props.selectedId !== id) return;
  selectedIndex = index;
  await nextTick();
  scrollIntoView(index, { center: true });
}

function onKeydown(event) {
  const total = summary.value?.total ?? 0;
  if (!total || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
  event.preventDefault();

  chosen.clear();
  const current = selectedIndex >= 0 ? selectedIndex : -1;
  const next = Math.min(total - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
  scrollIntoView(next);
  // The neighbouring row may not have loaded yet if the list was scrolled far away.
  nextTick(() => select(next));
}

function scrollIntoView(index, { center = false } = {}) {
  const el = viewport.value;
  const top = layout.value.offsets[layout.value.itemOfCommit[index]];
  if (center) {
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - (el.clientHeight - ROW_HEIGHT) / 2);
    }
    return;
  }
  // Keep a commit's month header visible when moving up onto the first commit of a month.
  const headerAbove = layout.value.items[layout.value.itemOfCommit[index] - 1]?.header ? HEADER_HEIGHT : 0;
  if (top - headerAbove < el.scrollTop) {
    el.scrollTop = top - headerAbove;
  } else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
    el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }
}

function onScroll() {
  scrollTop.value = viewport.value.scrollTop;
}

let resizeObserver;
onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    viewportHeight.value = viewport.value.clientHeight;
  });
  resizeObserver.observe(viewport.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());

// --- Presentation ----------------------------------------------------------

const graphWidth = computed(() => Math.max(1, summary.value?.lanes ?? 1) * 14 + 10);

const dateFormat = new Intl.DateTimeFormat(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
const fullDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });

const MAX_REFS = 3;
</script>

<template>
  <div v-if="error" class="message">
    <CircleAlert :size="28" :stroke-width="1.25" />
    <p>{{ error }}</p>
  </div>

  <div v-else-if="summary && !summary.total" class="message">
    <template v-if="search">
      <Search :size="32" :stroke-width="1.25" />
      <p>No commits match “{{ search }}”.</p>
    </template>
    <template v-else-if="hide">
      <History :size="32" :stroke-width="1.25" />
      <p>“{{ rev }}” has no commits that “{{ hide }}” doesn't have.</p>
    </template>
    <template v-else>
      <History :size="32" :stroke-width="1.25" />
      <p>No commits yet.</p>
    </template>
  </div>

  <div
    v-show="!error && summary?.total"
    ref="viewport"
    class="viewport"
    tabindex="0"
    @scroll="onScroll"
    @keydown="onKeydown"
    @dragover="onViewportDragOver"
  >
    <div class="spacer" :style="{ height: `${layout.height}px` }">
      <div v-if="dropLine != null" class="drop-line" :style="{ top: `${dropLine - 1}px` }" />
      <template v-for="item in visible" :key="item.key">
        <div v-if="item.header" class="month" :style="{ top: `${item.top}px`, height: `${HEADER_HEIGHT}px` }">
          <CommitGraph
            class="graph"
            :graph="item.commit?.graph"
            :width="graphWidth"
            :height="HEADER_HEIGHT"
            through
          />
          <span class="month-label">{{ item.label }}</span>
        </div>

        <div
          v-else
          class="commit"
          :class="{ selected: isChosen(item.commit), incoming: item.commit?.incoming }"
          :title="item.commit?.incoming ? 'Fetched, not pulled yet' : null"
          :style="{ top: `${item.top}px`, height: `${ROW_HEIGHT}px` }"
          :draggable="canDrag(item.commit)"
          @click="onClick(item.index, $event)"
          @contextmenu.prevent="onContextMenu(item.index, $event)"
          @dragstart="onDragStart(item.index, $event)"
          @dragover="onDragOver(item.index, $event)"
          @drop="onDrop(item.index, $event)"
          @dragend="onDragEnd"
        >
          <template v-if="item.commit">
            <CommitGraph class="graph" :graph="item.commit.graph" :width="graphWidth" :height="ROW_HEIGHT" />
            <Avatar class="avatar" :name="item.commit.author_name" :email="item.commit.author_email" />
            <div class="body">
              <div class="line">
                <span class="author">{{ item.commit.author_name }}</span>
                <span
                  v-for="label in item.commit.refs.slice(0, MAX_REFS)"
                  :key="label.kind + label.name"
                  class="ref"
                  :class="label.kind"
                >{{ label.name }}</span>
                <span
                  v-if="item.commit.refs.length > MAX_REFS"
                  class="ref more"
                  :title="item.commit.refs.slice(MAX_REFS).map((r) => r.name).join('\n')"
                >+{{ item.commit.refs.length - MAX_REFS }}</span>
                <span class="date" :title="fullDateFormat.format(item.commit.time * 1000)">
                  {{ dateFormat.format(item.commit.time * 1000) }}
                </span>
              </div>
              <div class="line">
                <span class="hash mono">{{ item.commit.short_id }}</span>
                <span class="summary">{{ item.commit.summary }}</span>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="graph" :style="{ width: `${graphWidth}px` }" />
            <div class="avatar placeholder" />
            <div class="body">
              <div class="skeleton" style="width: 30%" />
              <div class="skeleton" style="width: 70%" />
            </div>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  flex: 1;
  overflow-y: auto;
  outline: none;
}

.spacer {
  position: relative;
}

.month,
.commit {
  position: absolute;
  left: 8px;
  right: 8px;
  display: flex;
  align-items: center;
}

.month-label {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.commit {
  border-radius: 7px;
}

.commit.selected {
  background: var(--row-selected);
}

.commit[draggable="true"] {
  -webkit-user-drag: element;
}

/* Where a dragged commit would land. */
.drop-line {
  position: absolute;
  z-index: 2;
  left: 8px;
  right: 8px;
  height: 3px;
  border-radius: 2px;
  background: var(--accent);
  pointer-events: none;
}

/* Fetched from the remote but not pulled into the branch yet. */
.commit.incoming .avatar,
.commit.incoming .author,
.commit.incoming .hash,
.commit.incoming .summary {
  opacity: 0.55;
}

.graph {
  flex-shrink: 0;
  align-self: stretch;
}

.avatar {
  margin-right: 10px;
}

.avatar.placeholder {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--pill-bg);
}

.body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  align-self: stretch;
  padding-right: 8px;
  border-bottom: 1px solid var(--border);
}

.commit.selected .body {
  border-bottom-color: transparent;
}

.line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
  line-height: 18px;
}

.author {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.ref {
  overflow: hidden;
  flex-shrink: 1;
  min-width: 2em;
  max-width: 14em;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 16px;
  text-overflow: ellipsis;
  color: white;
}

.ref.head,
.ref.local {
  background: var(--accent);
}

.ref.head {
  flex-shrink: 0;
}

.ref.remote,
.ref.more {
  background: var(--ref-remote);
}

.ref.more {
  flex-shrink: 0;
  min-width: 0;
}

.ref.tag {
  background: var(--ref-tag);
}

.date {
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.hash {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.summary {
  overflow: hidden;
  text-overflow: ellipsis;
}

.skeleton {
  height: 10px;
  margin: 3px 0;
  border-radius: 5px;
  background: var(--pill-bg);
}

.message {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 24px;
  color: var(--text-tertiary);
  text-align: center;
}
</style>
