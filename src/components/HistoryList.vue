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
import { dragCopy, grabPoint } from "../lib/dragImage.js";
import { DROP_REACH, edgeScroller, pointerDrag } from "../lib/rowDrag.js";
import { itemAt } from "../lib/listOffsets.js";
import { commandKey } from "../lib/platform.js";
import { commitLanding, commitPointer, draggedCommits, dropCommits, gapBefore } from "../lib/commitDrag.js";
import { newestInView, slideDistance } from "../lib/historySlide.js";

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
// "menu-many" is the context menu for several selected commits; "move" asks to move
// dragged commits, one or several, above or below another (see moveCommits); "count"
// reports how many commits are listed.
const emit = defineEmits(["select", "menu", "menu-many", "move", "count"]);

const ROW_HEIGHT = 52;
const HEADER_HEIGHT = 34;
const PAGE_SIZE = 100;
const OVERSCAN = 400;

const summary = shallowRef(null);
const pages = shallowReactive(new Map());
const error = ref("");
const viewport = ref(null);
const spacer = ref(null);
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
  // The newest commit and where it was, while it's in view, to slide in any added above
  // it (see historySlide.js).
  const newestTop = resetScroll ? null : layout.value.offsets[layout.value.itemOfCommit[0]];
  const newest = newestTop != null && newestInView({ top: newestTop, rowHeight: ROW_HEIGHT, scrollTop: scrollTop.value }) ? commitAt(0) : null;
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
    // Where that commit is now, and the rows it would slide in with, read before they're
    // shown so none is shown blank.
    const [position, firstPage] = newest
      ? await Promise.all([
          invoke("history_position", { path: props.path, generation: next.generation, id: newest.id }).catch(() => null),
          invoke("history_page", { path: props.path, generation: next.generation, offset: 0, limit: PAGE_SIZE }).catch(() => null),
        ])
      : [];
    if (seq !== loadSeq) return;
    // A slide still under way was of the history this one replaces.
    sliding?.cancel();
    pages.clear();
    summary.value = next;
    if (!resetScroll && chosen.size) placeChosen(next.generation);
    if (firstPage) pages.set(0, firstPage);
    if (position != null && firstPage) slideIn(newestTop, position);
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

// The commits chosen stay chosen as the history's read again, at where each is now,
// found by its id: what's above them may have changed, as with a commit made in a
// terminal, and dragging or squashing them goes by where they are. One that's gone from
// it is let go of.
async function placeChosen(generation) {
  const entries = [...chosen.values()];
  const places = await Promise.all(
    entries.map(({ commit }) => invoke("history_position", { path: props.path, generation, id: commit.id }).catch(() => null)),
  );
  if (summary.value?.generation !== generation) return;
  entries.forEach(({ commit }, i) => {
    if (places[i] == null) chosen.delete(commit.id);
    else chosen.set(commit.id, { commit, index: places[i] });
  });
}

async function loadPage(page) {
  const generation = summary.value.generation;
  const key = `${generation}:${page}`;
  if (pages.has(page) || inflight.has(key)) return;

  inflight.add(key);
  try {
    const rows = await invoke("history_page", { path: props.path, generation, offset: page * PAGE_SIZE, limit: PAGE_SIZE });
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
  [() => props.path, () => props.rev, () => props.hide, () => props.file, () => props.search, () => props.firstParent],
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

// The rows slide down from where they were to make room for commits added above the
// newest one shown before, which started `before` from the top and is now at `position`.
const SLIDE_MS = 220;
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
let sliding = null;

async function slideIn(before, position) {
  const distance = slideDistance({
    before,
    after: layout.value.offsets[layout.value.itemOfCommit[position]],
    // No more than fits in the view, nor than the rows drawn beyond it (see slideDistance).
    most: Math.min(viewportHeight.value, OVERSCAN),
  });
  if (!distance || reducedMotion?.matches) return;
  // Once the new rows are drawn, before they're painted.
  await nextTick();
  sliding = spacer.value?.animate([{ transform: `translateY(${-distance}px)` }, { transform: "none" }], {
    duration: SLIDE_MS,
    easing: "cubic-bezier(0.2, 0, 0, 1)",
  });
}
onBeforeUnmount(() => sliding?.cancel());

const visible = computed(() => {
  const { items, offsets } = layout.value;
  if (!items.length) return [];

  const bottom = scrollTop.value + viewportHeight.value + OVERSCAN;
  const result = [];
  for (let i = itemAt(offsets, Math.max(0, scrollTop.value - OVERSCAN)); i < items.length && offsets[i] < bottom; i++) {
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
// By the pointer, as a branch is in the sidebar (see rowDrag.js): a copy of the row
// follows it, held where it was grabbed. In the current branch's own history, a commit's
// dragged to another place in it, to move it there, or with several chosen, pressed on
// one of them, all of them together: the rows below where they would go slide down to
// open a gap, the graph's lanes running on through it, with a line in its middle. In
// another's, to the sidebar's current branch, to cherry-pick them there (see
// commitDrag.js).

// How tall the gap opened where a commit would go is.
const DROP_GAP = 20;
// Away from the list, as over the sidebar's branches, the copy dragged is a compact card
// this wide and high, held by its middle, so it covers little around the pointer, and
// what's said about dropping there shows clear of it (see placeSentence in Sidebar.vue).
const COMPACT_WIDTH = 240;
const COMPACT_HEIGHT = 34;
const COMPACT_GRIP = { x: COMPACT_WIDTH / 2, y: COMPACT_HEIGHT / 2 };

// The commits being moved, each { commit, index }, newest first, or null.
const dragged = shallowRef(null);
// Where they would go: { index, above }, above or below that commit (see commitLanding).
const dropAt = ref(null);
// Whether a drag's under way, to move or to cherry-pick, and where the pointer is.
let dragging = false;
let pointer = null;
// How the copy dragged is held and sized over the list, to go back to from the compact
// card: { grip, width, height }; and whether it's that card now.
let fullCopy = null;
let compact = false;

// Reordering is only of the branch's own commits, not those its upstream has that it
// hasn't pulled (`incoming`); any shown can be cherry-picked.
const canDrag = (commit) => props.editable && commit && !commit.incoming;
const canPick = (commit) => props.pickable && !!commit;

const drag = pointerDrag({
  image({ element, data: { moving, picking } }) {
    const copy = dragCopy(element);
    // Several chosen, it's a stack of them, saying how many.
    const count = moving.length || picking.length;
    if (count > 1) {
      const badge = document.createElement("span");
      badge.className = "drag-count";
      badge.textContent = count;
      copy.append(badge);
      copy.classList.add(count > 2 ? "stack-3" : "stack-2");
    }
    return copy;
  },
  hold({ element, x, y }) {
    const grip = grabPoint(element, x, y);
    fullCopy = { grip };
    return grip;
  },
  // Over the list it's the row; away from it, the compact card, and back again.
  reshape(event, copy) {
    const rect = viewport.value?.getBoundingClientRect();
    const over = !!rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (over !== compact) return null;
    compact = !over;
    fullCopy.width ??= copy.style.width;
    fullCopy.height ??= copy.style.height;
    copy.classList.toggle("compact", compact);
    Object.assign(copy.style, compact ? { width: `${COMPACT_WIDTH}px`, height: `${COMPACT_HEIGHT}px` } : { width: fullCopy.width, height: fullCopy.height });
    return compact ? COMPACT_GRIP : fullCopy.grip;
  },
  start({ data: { moving, picking } }) {
    // The card of a commit's branches and tags isn't shown while a drag goes over them
    // (see showRefs), and one showing goes.
    dragging = true;
    refsCard.value = null;
    if (picking.length) draggedCommits.value = picking;
    else dragged.value = moving;
  },
  move(event) {
    pointer = { x: event.clientX, y: event.clientY };
    if (!dragged.value) {
      commitPointer.value = pointer;
      return;
    }
    dropAt.value = landing();
    edgeScrolling.follow(pointer);
  },
  drop() {
    if (!dragged.value) {
      dropCommits();
      return;
    }
    const at = dropAt.value;
    if (!at) return;
    emit("move", dragged.value, { commit: commitAt(at.index), index: at.index }, at.above ? "above" : "below");
  },
  end() {
    edgeScrolling.stop();
    dragging = false;
    fullCopy = null;
    compact = false;
    pointer = null;
    dragged.value = null;
    dropAt.value = null;
    draggedCommits.value = null;
    commitPointer.value = null;
  },
});
// Gone mid-drag, as its tab closed, what it was dragging is let go of.
onBeforeUnmount(() => drag.cancel());
// The history changed under commits being moved, as by a commit made in a terminal:
// they're known by where they were in the list, which may not be where they are now, so
// they're let go of rather than moved somewhere else than it seems.
watch(
  () => summary.value?.generation,
  () => dragged.value && drag.cancel(),
);

// A row pressed: the start of a drag, unless it's let go of as a click: of the commit,
// or the several chosen with it. To move, as they're listed, newest first, only if every
// one of them can be; to cherry-pick, oldest first, as they're picked.
function onPointerDown(index, event) {
  const commit = commitAt(index);
  // Not with Cmd (Ctrl) or Shift held, which choose commits: a click that wobbles
  // shouldn't drag them instead.
  if (event.button !== 0 || commandKey(event) || event.shiftKey || (!canDrag(commit) && !canPick(commit))) return;
  const all = chosen.size > 1 && chosen.has(commit.id) ? [...chosen.values()].sort((a, b) => a.index - b.index) : [{ commit, index }];
  const moving = canDrag(commit) ? (all.every((c) => canDrag(c.commit)) ? all : [{ commit, index }]) : [];
  const picking = moving.length ? [] : [...all].reverse().map((c) => c.commit);
  drag.press(event, { moving, picking });
}

// With the pointer over the list, or beside it, where the commit dragged would go.
function landing() {
  const rect = viewport.value?.getBoundingClientRect();
  if (!rect || !pointer || pointer.x < rect.left - DROP_REACH || pointer.x > rect.right + DROP_REACH) return null;
  const y = pointer.y - rect.top + viewport.value.scrollTop;
  const moving = dragged.value.map((c) => c.index);
  return commitLanding(layout.value, ROW_HEIGHT, y, moving, (index) => canDrag(commitAt(index)));
}

// Near the top or bottom of the list, with the pointer over it, it scrolls, faster the
// nearer the end, and where the commits would go goes with it.
const edgeScrolling = edgeScroller({
  element: () => viewport.value,
  near: (at) => {
    const rect = viewport.value?.getBoundingClientRect();
    return !!dragged.value && !!rect && at.x >= rect.left && at.x <= rect.right;
  },
  scrolled: () => (dropAt.value = landing()),
});

// The gap where the commit dragged would go: the layout item it opens before, and where
// it is down the list; null for none. At the end, past the last commit, it's after it.
const gap = computed(() => {
  if (!dropAt.value) return null;
  const { items, offsets, itemOfCommit } = layout.value;
  const before = gapBefore(dropAt.value);
  if (before < itemOfCommit.length) return { item: itemOfCommit[before], top: offsets[itemOfCommit[before]], commit: commitAt(before) };
  return { item: items.length, top: offsets[itemOfCommit[before - 1]] + ROW_HEIGHT, commit: null };
});

// How far down an item, `key` in the layout, is moved for the gap: by its height, from
// the item it opens before on.
const gapShift = (key) => (gap.value && key >= gap.value.item ? DROP_GAP : 0);

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
  const index = await invoke("history_position", { path: props.path, generation, id }).catch(() => null);
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
  // Not while a commit's dragged over them, as it passes.
  if (dragging) return;
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
  >
    <div ref="spacer" class="spacer" :class="{ sorting: dragged }" :style="{ height: `${layout.height + (gap ? DROP_GAP : 0)}px` }">
      <!-- Where a commit dragged would go: a gap, the lanes running on through it. -->
      <div v-if="gap" class="drop-gap" :style="{ top: `${gap.top}px`, height: `${DROP_GAP}px` }">
        <CommitGraph v-if="gap.commit" class="graph" :graph="gap.commit.graph" :lanes="lanes" :height="DROP_GAP" through />
      </div>
      <template v-for="item in visible" :key="item.key">
        <div v-if="item.header" class="month" :style="{ top: `${item.top + gapShift(item.key)}px`, height: `${HEADER_HEIGHT}px` }">
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
          :class="{ selected: isChosen(item.commit), incoming: item.commit?.incoming, dragging: dragged?.some((c) => c.index === item.index) }"
          :title="item.commit?.incoming ? 'Fetched, not pulled yet' : null"
          :style="{ top: `${item.top + gapShift(item.key)}px`, height: `${ROW_HEIGHT}px` }"
          @pointerdown="onPointerDown(item.index, $event)"
          @click="onClick(item.index, $event)"
          @contextmenu.prevent="onContextMenu(item.index, $event)"
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
                  <!-- Spelled out, as Settings can choose, every one in full on hover. -->
                  <span
                    v-if="settings.historyRefNames"
                    class="names"
                    @mouseenter="showRefs(item.marks.badges, $event)"
                    @mouseleave="refsCard = null"
                  >
                    <RefName v-for="label in item.marks.named.shown" :key="label.kind + label.name" :kind="label.kind" :name="label.name" fit plain />
                    <span
                      v-if="item.marks.named.more"
                      class="badge more"
                      role="img"
                      :aria-label="`and ${item.marks.named.rest.join(', ')}`"
                    >+{{ item.marks.named.more }}</span>
                  </span>
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

/* While a commit's dragged to move it: faded where it was, and where it would go, the
   rows below slide down to open a gap, with a line in its middle, as between branches
   in the sidebar. Let go of, it closes at once. */
.spacer.sorting > .month,
.spacer.sorting > .commit {
  transition: top 150ms ease;
}

.commit.dragging {
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  .spacer.sorting > .month,
  .spacer.sorting > .commit {
    transition: none;
  }
}

.drop-gap {
  position: absolute;
  left: 8px;
  right: 8px;
  display: flex;
  pointer-events: none;
}

.drop-gap::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 3px;
  margin-top: -1.5px;
  border-radius: var(--radius-xs);
  background: var(--accent-fill);
}

/* A copy of a row following the pointer as it's dragged, on the list's color, as the
   row is, its own over it where it's chosen. */
.commit.following {
  background-color: var(--content-bg);
}

.commit.following.selected {
  background: linear-gradient(var(--row-selected), var(--row-selected)) var(--content-bg);
}

/* Several dragged, the rows behind it peek out below and to its right, one for two,
   two for more: each a shadow the row's color, edged in the border's, as a row is. */
.commit.following.stack-2 {
  box-shadow:
    0 0 0 1px var(--border),
    5px 5px 0 -1px var(--content-bg),
    5px 5px 0 0 var(--border);
}

.commit.following.stack-3 {
  box-shadow:
    0 0 0 1px var(--border),
    5px 5px 0 -1px var(--content-bg),
    5px 5px 0 0 var(--border),
    10px 10px 0 -1px var(--content-bg),
    10px 10px 0 0 var(--border);
}

/* Away from the list, a compact card of it, sized as COMPACT_WIDTH and COMPACT_HEIGHT
   say: one line, its dot and its message. */
.commit.following.compact .avatar,
.commit.following.compact .ref-marks,
.commit.following.compact .meta {
  display: none;
}

.commit.following.compact .body {
  border-bottom: none;
}

.commit.following.compact .graph {
  height: 100%;
  width: auto;
}

/* Its commit's dot alone, without the lines to the commits around it: picked up off
   the graph, as the row is off the list. */
.commit.following .graph :deep(path) {
  display: none;
}

/* How many commits go with the one dragged, chosen with it, to cherry-pick: put in
   its copy as that's made, so not one of this list's own elements. */
.commit.following :deep(.drag-count) {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  box-sizing: border-box;
  border-radius: 10px;
  background: var(--accent-fill);
  color: white;
  font-size: var(--font-xs);
  font-weight: 600;
  line-height: 20px;
  text-align: center;
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

/* Names spelled out keep their size while there's room, the message giving way; only
   past most of the line are they cut shorter, so the message keeps a share of it. */
.named .ref-marks {
  max-width: 70%;
  min-width: 0;
}

.names {
  display: flex;
  gap: 4px;
  min-width: 0;
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
  padding: 0 4px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--tint) 18%, transparent);
  font-size: var(--font-xs);
  font-weight: 600;
  /* Its own color, where the tint is too light to read on itself, as a tag's is. */
  color: var(--tint-text, var(--tint));
  transition: background 0.12s;
}

.badge.remote {
  --tint: var(--text-secondary);
}

.badge.tag {
  --tint: var(--ref-tag);
  --tint-text: var(--ref-tag-text);
}

.badges:hover .badge {
  background: color-mix(in srgb, var(--tint) 30%, transparent);
}

/* How many more names than are spelled out, which lists them all on hover. */
.badge.more {
  --tint: var(--text-secondary);
  flex-shrink: 0;
}

.names:hover .badge.more {
  background: color-mix(in srgb, var(--tint) 30%, transparent);
}

/* Every branch and tag at the commit, in full, while its badges or names are pointed at. */
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
