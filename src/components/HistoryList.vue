<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, History, Search } from "lucide-vue-next";
import Avatar from "./Avatar.vue";
import RefName from "./RefName.vue";
import { formatWhen } from "../lib/format.js";
import { REF_ICONS, refBadges } from "../lib/refBadges.js";
import { settings } from "../lib/settings.js";
import CommitGraph from "./CommitGraph.vue";
import { graphLayout, lanesOf } from "../lib/graphLayout.js";
import { setDragImage } from "../lib/dragImage.js";
import { COMMIT_TYPE, draggedCommits } from "../lib/commitDrag.js";

const props = defineProps({
  path: { type: String, required: true },
  rev: { type: String, default: null },
  // Leaves out the commits this revision has, to list only what `rev` adds to it.
  hide: { type: String, default: null },
  // Only commits that changed this file.
  file: { type: String, default: null },
  // Only commits matching this search.
  search: { type: String, default: "" },
  // Only the commits along first parents, each merge standing for what it brought in.
  firstParent: { type: Boolean, default: false },
  refreshKey: { type: Number, default: 0 },
  selectedId: { type: String, default: null },
  // Whether commits can be dragged to reorder them: only in the current branch's own
  // history.
  editable: { type: Boolean, default: false },
  // Whether commits can be dragged to the sidebar's current branch, to cherry-pick them
  // there: in another branch's history, a tag's or a remote branch's.
  pickable: { type: Boolean, default: false },
});
// "menu-many" is the context menu for several selected commits; "move" asks to move a
// dragged commit above or below another; "count" reports how many commits are listed.
const emit = defineEmits(["select", "menu", "menu-many", "move", "count"]);

const ROW_HEIGHT = 52;
const HEADER_HEIGHT = 34;
const PAGE_SIZE = 100;
const OVERSCAN = 400;

const summary = shallowRef(null);
const pages = shallowReactive(new Map());
const error = ref("");
const viewport = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
// The card of a commit's branches and tags, while its badges are pointed at: { badges,
// style }, or null (see "Branches and tags" below).
const refsCard = shallowRef(null);

// Index of the selected commit in the list, used for keyboard navigation.
let selectedIndex = -1;

// --- Loading ---------------------------------------------------------------

let loadSeq = 0;
const inflight = new Set();
// How many times the selection has changed from outside (see "reveal" below).
let selectionChanges = 0;

async function load({ resetScroll }) {
  // The commits are read again, and the badges pointed at may go without the pointer
  // leaving them, which would close their card.
  refsCard.value = null;
  const seq = ++loadSeq;
  const selections = selectionChanges;
  try {
    const next = await invoke("load_history", {
      path: props.path,
      rev: props.rev,
      hide: props.hide,
      file: props.file,
      search: props.search || null,
      firstParent: props.firstParent,
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
      // Showing another branch's history keeps the selected commit in view if it's
      // there, and otherwise selects the newest commit, so the details match the list.
      pendingReveal = props.selectedId;
      // Not when the commit was chosen along with the history, as when a search or a
      // blame jumps to one.
      orNewest = selectionChanges === selections;
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
  () => [props.path, props.rev, props.hide, props.file, props.search, props.firstParent],
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
    const commit = commitAt(item.header ? item.next : item.index);
    // Its branches and tags as badges, worked out once for the row (see refBadges.js).
    const marks = commit?.refs.length ? refBadges(commit.refs) : null;
    result.push({ ...item, key: i, top: offsets[i], commit, marks });
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

// --- Dragging to reorder, or to cherry-pick ----------------------------------------
// In the current branch's own history, a commit's dragged to another place in it, to
// move it there. In another's, to the sidebar's current branch, to cherry-pick it there
// (see commitDrag.js), which the list itself doesn't take.

const DRAG_EDGE = 40;
// The commit being moved: { commit, index }.
let dragged = null;
let dragImage = null;
// Where a dropped commit would go: { index, above }.
const dropAt = ref(null);

// Reordering is only of the branch's own commits, not those its upstream has that it
// hasn't pulled (`incoming`); any shown can be cherry-picked.
const canDrag = (commit) => props.editable && commit && !commit.incoming;
const canPick = (commit) => props.pickable && !!commit;

function onDragStart(index, event) {
  // A drag holds back the pointer leaving the badges, which would close their card.
  refsCard.value = null;
  const commit = commitAt(index);
  const moving = canDrag(commit);
  if (!moving && !canPick(commit)) {
    event.preventDefault();
    return;
  }
  // To cherry-pick: the commit, or the several chosen with it, oldest first, as they're
  // picked. The list is newest first.
  const picking = moving ? [] : chosen.size > 1 && chosen.has(commit.id) ? [...chosen.values()].sort((a, b) => b.index - a.index).map((c) => c.commit) : [commit];
  if (moving) dragged = { commit, index };
  else draggedCommits.value = picking;
  event.dataTransfer.effectAllowed = moving ? "move" : "copy";
  event.dataTransfer.setData("text/plain", picking.length > 1 ? picking.map((c) => c.short_id).join(" ") : commit.short_id);
  if (!moving) event.dataTransfer.setData(COMMIT_TYPE, picking.map((c) => c.id).join(" "));
  // A compact image of what's being dragged, like a branch dragged in the sidebar.
  dragImage = document.createElement("div");
  dragImage.className = "drag-image";
  dragImage.textContent = picking.length > 1 ? `${picking.length} commits` : `${commit.short_id}  ${commit.summary}`;
  document.body.append(dragImage);
  setDragImage(event, dragImage);
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

// Gone mid-drag, its end isn't heard: what it was dragging is let go of now.
onBeforeUnmount(() => onDragEnd());

// Dropped anywhere, or let go of.
function onDragEnd() {
  dragImage?.remove();
  dragImage = null;
  dragged = null;
  draggedCommits.value = null;
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
// Whether a commit that isn't in the history gives way to the newest one.
let orNewest = false;

watch(
  () => props.selectedId,
  (id) => {
    pendingReveal = id && id !== pickedHere ? id : null;
    orNewest = false;
    selectionChanges++;
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
  const newest = orNewest;
  orNewest = false;
  const index = await invoke("history_position", { generation, id }).catch(() => null);
  if (summary.value?.generation !== generation || props.selectedId !== id) return;
  if (index == null) {
    if (newest && summary.value.total) {
      await loadPage(0);
      select(0);
    }
    return;
  }
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
  refsCard.value = null;
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

// The graph is as wide as the rows on screen need, not the whole history: the newest
// commits may be one straight line where older ones had dozens of branches. It widens
// at once, and narrows only once scrolling has paused, so it doesn't jitter.
const needed = computed(() => {
  let lanes = 0;
  for (const item of visible.value) {
    if (item.commit) lanes = Math.max(lanes, lanesOf(item.commit.graph));
  }
  return lanes;
});
const lanes = ref(1);
let narrowing = null;
watch(needed, (need) => {
  clearTimeout(narrowing);
  if (!need) return;
  if (need >= lanes.value) lanes.value = need;
  else narrowing = setTimeout(() => (lanes.value = need), 600);
});
watch(
  () => summary.value?.generation,
  () => {
    clearTimeout(narrowing);
    lanes.value = Math.max(1, needed.value);
  },
);
onBeforeUnmount(() => clearTimeout(narrowing));
const graphWidth = computed(() => graphLayout(lanes.value).width);

// When each commit was made: "2 hours ago", or for one older than a week its date, with
// the date and time in full on hover.
const when = (seconds) => formatWhen(seconds * 1000);
const fullDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });

// --- Branches and tags ---------------------------------------------------------
// A commit's branches and tags show as badges beside its message (see refBadges.js),
// and pointing at them shows a card with every name in full.

function showRefs(badges, event) {
  const rect = event.currentTarget.getBoundingClientRect();
  // Below the badges, or above them where there's more room, no taller than that room.
  const roomBelow = window.innerHeight - rect.bottom - 14;
  const roomAbove = rect.top - 14;
  const below = roomBelow >= 240 || roomBelow >= roomAbove;
  const style = {
    right: `${Math.max(8, window.innerWidth - rect.right)}px`,
    maxHeight: `${below ? roomBelow : roomAbove}px`,
    ...(below ? { top: `${rect.bottom + 6}px` } : { bottom: `${window.innerHeight - rect.top + 6}px` }),
  };
  refsCard.value = { badges, style };
}
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
            :lanes="lanes"
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
          :draggable="canDrag(item.commit) || canPick(item.commit)"
          @click="onClick(item.index, $event)"
          @contextmenu.prevent="onContextMenu(item.index, $event)"
          @dragstart="onDragStart(item.index, $event)"
          @dragover="onDragOver(item.index, $event)"
          @drop="onDrop(item.index, $event)"
          @dragend="onDragEnd"
        >
          <template v-if="item.commit">
            <CommitGraph class="graph" :graph="item.commit.graph" :lanes="lanes" :height="ROW_HEIGHT" />
            <Avatar class="avatar" :name="item.commit.author_name" :email="item.commit.author_email" />
            <div class="body">
              <div class="line" :class="{ named: item.marks && settings.historyRefNames }">
                <span class="summary" :title="item.commit.incoming ? `${item.commit.summary}\n\nFetched, not pulled yet` : item.commit.summary">{{ item.commit.summary }}</span>
                <span v-if="item.marks" class="ref-marks">
                  <!-- Where it's checked out, said outright; its branches and tags as badges. -->
                  <RefName v-if="item.marks.head" kind="head" name="HEAD" />
                  <!-- Spelled out, as Settings can choose, the rest listed on hover. -->
                  <template v-if="settings.historyRefNames">
                    <RefName v-for="label in item.marks.named.shown" :key="label.kind + label.name" :kind="label.kind" :name="label.name" fit plain />
                    <span
                      v-if="item.marks.named.more"
                      class="badge more"
                      role="img"
                      :aria-label="`and ${item.marks.named.rest.join(', ')}`"
                      @mouseenter="showRefs(item.marks.badges, $event)"
                      @mouseleave="refsCard = null"
                    >+{{ item.marks.named.more }}</span>
                  </template>
                  <span
                    v-else-if="item.marks.badges.length"
                    class="badges"
                    role="img"
                    :aria-label="item.commit.refs.filter((r) => r.kind !== 'head').map((r) => r.name).join(', ')"
                    @mouseenter="showRefs(item.marks.badges, $event)"
                    @mouseleave="refsCard = null"
                  >
                    <span v-for="badge in item.marks.badges" :key="badge.kind" class="badge" :class="badge.kind">
                      <component :is="REF_ICONS[badge.kind]" :size="12" :stroke-width="2.25" />
                      <span v-if="badge.count > 1">{{ badge.count }}</span>
                    </span>
                  </span>
                </span>
              </div>
              <div class="line meta">
                <span class="author">{{ item.commit.author_name }}</span>
                <span>·</span>
                <span class="date" :title="fullDateFormat.format(item.commit.time * 1000)">{{ when(item.commit.time) }}</span>
                <span>·</span>
                <span class="hash mono">{{ item.commit.short_id }}</span>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="graph" :style="{ width: `${graphWidth}px` }" />
            <div class="avatar placeholder" />
            <div class="body">
              <div class="skeleton" style="width: 70%" />
              <div class="skeleton" style="width: 30%" />
            </div>
          </template>
        </div>
      </template>
    </div>
  </div>

  <Teleport to="body">
    <Transition name="refs-card">
      <div v-if="refsCard" class="refs-card" :style="refsCard.style">
        <section v-for="badge in refsCard.badges" :key="badge.kind">
          <h4>{{ badge.title }}</h4>
          <p v-for="name in badge.shown" :key="name"><RefName :kind="badge.kind" :name="name" /></p>
          <p v-if="badge.more" class="more">and {{ badge.more }} more</p>
        </section>
      </div>
    </Transition>
  </Teleport>
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
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.commit {
  border-radius: var(--radius-lg);
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
  border-radius: var(--radius-xs);
  background: var(--accent);
  pointer-events: none;
}

/* Fetched from the remote but not pulled into the branch yet. */
.commit.incoming .avatar,
.commit.incoming .summary,
.commit.incoming .badges,
.commit.incoming .meta {
  opacity: 0.55;
}

.graph {
  flex-shrink: 0;
  align-self: stretch;
}

/* The message first, what's scanned for; who, when and which commit quietly below. */
.body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  flex: 1;
  min-width: 0;
  align-self: stretch;
  padding-right: 10px;
  border-bottom: 1px solid var(--border);
}

.commit.selected .body {
  border-bottom-color: transparent;
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

.line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  line-height: 18px;
}

/* The message gives way to the badges beside it, which keep their size; only a pane too
   narrow even for a short message cuts them off at its edge. */
.summary {
  overflow: hidden;
  flex-shrink: 1;
  min-width: 0;
  font-weight: 500;
  text-overflow: ellipsis;
}

.meta {
  gap: 5px;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.author {
  overflow: hidden;
  flex-shrink: 1;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}

/* Beside the message: HEAD where the commit is checked out, and a badge for each kind
   of branch or tag at it, tinted in its color. */
.ref-marks {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding-left: 6px;
}

/* Names spelled out are wider, so they give way too, each cut shorter, though the
   message gives way first, faster, down to a share of the line it keeps: both stay
   readable in a narrow pane. */
.named .ref-marks {
  flex-shrink: 1;
  min-width: 0;
}

.named .summary {
  flex-shrink: 3;
  min-width: min(30%, 140px);
}

.badges {
  display: flex;
  gap: 4px;
}

.badge {
  --tint: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 17px;
  margin-top: 1px;
  padding: 0 5px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--tint) 18%, transparent);
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--tint);
  transition: background 0.12s;
}

.badge.remote {
  --tint: var(--text-secondary);
}

.badge.tag {
  --tint: var(--ref-tag);
}

.badges:hover .badge {
  background: color-mix(in srgb, var(--tint) 30%, transparent);
}

/* How many more names than are spelled out, which lists them all on hover. */
.badge.more {
  --tint: var(--text-secondary);
  flex-shrink: 0;
}

.badge.more:hover {
  background: color-mix(in srgb, var(--tint) 30%, transparent);
}

/* Every branch and tag at the commit, in full, while the badges are pointed at. */
.refs-card {
  position: fixed;
  z-index: 30;
  min-width: 180px;
  max-width: 360px;
  padding: 8px 10px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--sunken-bg);
  box-shadow: var(--shadow-popover);
  overflow: hidden;
  pointer-events: none;
}

.refs-card .more {
  padding: 2px 0;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.refs-card p {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
}

.refs-card h4 {
  margin: 8px 0 3px;
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.refs-card section:first-of-type h4 {
  margin-top: 2px;
}

.refs-card section p {
  padding: 2px 0;
}

.refs-card-enter-active,
.refs-card-leave-active {
  transition:
    opacity 0.12s,
    transform 0.12s;
}

.refs-card-enter-from,
.refs-card-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}

.date,
.hash {
  flex-shrink: 0;
}

.skeleton {
  height: 10px;
  margin: 3px 0;
  border-radius: var(--radius-sm);
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
