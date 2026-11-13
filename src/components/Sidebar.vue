<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  FolderGit2,
  FolderOpen,
  ListFilter,
  Lock,
  Plus,
  Github,
  Settings,
  X,
} from "lucide-vue-next";
import { OLDER_TAGS, sidebarSections } from "../lib/sidebarRows.js";
import Spinner from "./Spinner.vue";
import { commandKey, isMac, shortcut } from "../lib/platform.js";
import { githubAccount } from "../lib/github.js";
import { branchOrder, dividerRows, moveKey } from "../lib/branchOrder.js";
import { repositoryFolder } from "../lib/recents.js";
import { splitKey } from "../lib/sidebarKeys.js";
import { draggedCommits, isCommitDrag } from "../lib/commitDrag.js";

const props = defineProps({
  overview: { type: Object, required: true },
  selected: { type: String, default: null },
  // Rows of the two revisions being compared, highlighted along with the selection.
  compared: { type: Array, default: () => [] },
  // { count, fresh } when the repository is on GitHub, for the Issues row: how many
  // are open, and how many of those are new since they were last looked at. Null
  // hides the row.
  issues: { type: Object, default: null },
  // { count } of open pull requests, for the Pull Requests row; null hides it.
  pulls: { type: Object, default: null },
  // The row of a branch being checked out, shown as current, with a spinner, until
  // the switch is done.
  switching: { type: String, default: null },
  // What each repository's agents are doing, by path, for its worktree's row: "working",
  // "blocked", "done" or "error" (see repositoryStates in terminals.js).
  agents: { type: Object, default: () => ({}) },
});
const emit = defineEmits([
  "update:selected",
  "compare",
  "open-repository",
  "menu",
  "activate",
  "section-menu",
  "merge-into-head",
  "rebase-head-onto",
  "new-branch-from",
  "cherry-pick",
  "add-menu",
  "recent-menu",
]);

// Where to open a menu so it drops down from the button that was clicked.
function below(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom + 4, preventDefault() {} };
}

const filter = ref("");
const collapsedSections = reactive(new Set());
const collapsedFolders = reactive(new Set());

const query = computed(() => filter.value.trim().toLowerCase());
// Whether the Older tags are showing (see sidebarRows.js).
const olderTagsOpen = ref(false);

// Where the branches' arrangement is kept: the repository's, the same from any of its
// worktrees.
const arrangedIn = computed(() => repositoryFolder(props.overview));

// The sections and their rows, built from the repository's overview as the filter,
// the folders opened and closed, and the branches' arrangement have them.
const sections = computed(() =>
  sidebarSections(props.overview, {
    query: query.value,
    collapsed: collapsedFolders,
    olderTagsOpen: olderTagsOpen.value,
    issues: props.issues,
    pulls: props.pulls,
    agents: props.agents,
    order: branchOrder(arrangedIn.value),
    dividers: dividerRows(arrangedIn.value),
  }),
);
// Branches' rows, among which a dragged one moves.
const branchRows = computed(() => sections.value.find((s) => s.id === "branches")?.rows ?? []);

function toggleSection(id) {
  collapsedSections.has(id) ? collapsedSections.delete(id) : collapsedSections.add(id);
}

// --- Dragging branches -----------------------------------------------------------------

// Dragging a branch onto the HEAD branch merges it, or with Alt (Option on a Mac) held,
// rebases the HEAD branch onto it. Dragging a branch, folder or
// divider elsewhere in Branches moves it among the rows in the same folder, except
// while filtering. On the HEAD branch, the middle of the row merges and its edges
// move. Dragging a branch, local or remote, onto the Branches header creates a branch
// starting there.
//
// It's done with pointer events rather than the web view's drag and drop: during one
// of those, the page doesn't hear keys pressed (GNOME on Wayland and macOS keep them
// while they run the drag), so it couldn't tell Alt was held.

// The name of the branch being dragged, if it can be merged; the row being dragged;
// and where it would land: { key, merge } or { key, after }.
const dragging = ref(null);
const dragRow = ref(null);
const dropAt = ref(null);

const ARRANGEABLE = /^branch(-folder|-divider)?:/;
const canMerge = (row) => !row.folder && !row.divider && (row.key.startsWith("branch:") || row.key.startsWith("remote-branch:"));
const canMove = (row) => !query.value && ARRANGEABLE.test(row.key);
const canDrag = (row) => canMerge(row) || canMove(row);

// Whether the dragged branch is over the Branches header, to create a branch from it.
const overBranches = ref(false);
// Whether Alt is held, which makes a merge a rebase. On macOS, with the mouse button
// down, the page's events say it isn't, and pressing it isn't heard, so Palace asks its
// own process (keys.rs), as the pointer moves and every so often while it's still.
const altHeld = ref(false);
let askingAlt = false;
let altPoll = 0;

function updateAlt(event) {
  if (!isMac) {
    if (event) altHeld.value = event.altKey;
    return;
  }
  if (askingAlt) return;
  askingAlt = true;
  invoke("alt_held")
    .then((held) => dragRow.value && (altHeld.value = held))
    .catch(() => {})
    .finally(() => (askingAlt = false));
}
const draggedBranch = () => (dragRow.value && canMerge(dragRow.value) ? splitKey(dragRow.value.key)[1] : null);

const rowsByKey = computed(() => new Map(sections.value.flatMap((s) => s.rows.map((row) => [row.key, row]))));
const scroller = ref(null);

// How far the pointer moves, pressed, before it's a drag rather than a click.
const DRAG_DISTANCE = 4;

// What follows the pointer: the row's icon and name. What dropping would do is told
// below where it'd land (see .drop-sentence).
let dragImage = null;
// The press that may become a drag: { row, element, x, y }.
let pressed = null;
let pointer = null;
let scrolling = 0;

function onPointerDown(row, event) {
  if (event.button !== 0 || !canDrag(row) || commandKey(event) || event.shiftKey) return;
  pressed = { row, element: event.currentTarget, x: event.clientX, y: event.clientY };
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", endDrag, true);
  window.addEventListener("keydown", onDragKey, true);
  window.addEventListener("keyup", onDragKey, true);
  window.addEventListener("blur", endDrag);
}

function startDrag() {
  const { row, element } = pressed;
  dragRow.value = row;
  dragging.value = canMerge(row) && !row.head ? splitKey(row.key)[1] : null;
  dragImage = document.createElement("div");
  dragImage.className = "drag-image following";
  const icon = element.querySelector(".row-icon")?.cloneNode(true);
  if (icon) dragImage.append(icon);
  dragImage.append(row.divider ? row.label || "Divider" : row.label);
  document.body.append(dragImage);
  document.body.classList.add("dragging-row");
  if (isMac) altPoll = setInterval(updateAlt, 100);
  window.getSelection()?.removeAllRanges();
}

function onPointerMove(event) {
  if (!pressed) return;
  if (!dragRow.value) {
    if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < DRAG_DISTANCE) return;
    startDrag();
  }
  event.preventDefault();
  updateAlt(event);
  pointer = { x: event.clientX, y: event.clientY };
  // Held 14px into its left end, at its middle. With the pointer out of the window, it
  // stays at the window's edge nearest it, as the page can't draw beyond the window.
  const { offsetWidth: width, offsetHeight: height } = dragImage;
  const x = Math.min(Math.max(pointer.x - 14, 0), innerWidth - width);
  const y = Math.min(Math.max(pointer.y - height / 2, 0), innerHeight - height);
  dragImage.style.transform = `translate(${x}px, ${y}px)`;
  dragImage.style.visibility = "visible";
  aim();
  if (!scrolling) scrolling = requestAnimationFrame(autoScroll);
}

// What's under the pointer, for where a drop would land.
function aim() {
  const target = pointer && document.elementFromPoint(pointer.x, pointer.y);
  const header = target?.closest?.(".section-header");
  overBranches.value = !!(header && header.dataset.section === "branches" && draggedBranch());
  const element = target?.closest?.("[data-row]");
  const row = element && rowsByKey.value.get(element.dataset.row);
  dropAt.value = row ? landing(row, element.getBoundingClientRect(), pointer.y) : null;
}

// Near the top or bottom of the list, it scrolls, faster the nearer the edge.
function autoScroll() {
  scrolling = 0;
  const el = scroller.value;
  if (!dragRow.value || !el || !pointer) return;
  const rect = el.getBoundingClientRect();
  const EDGE = 28;
  const step = pointer.y < rect.top + EDGE ? -(rect.top + EDGE - pointer.y) : pointer.y > rect.bottom - EDGE ? pointer.y - (rect.bottom - EDGE) : 0;
  if (!step || pointer.x < rect.left || pointer.x > rect.right) return;
  const before = el.scrollTop;
  el.scrollTop += Math.sign(step) * Math.min(EDGE, Math.abs(step)) / 2;
  if (el.scrollTop === before) return;
  aim();
  scrolling = requestAnimationFrame(autoScroll);
}

function onDragKey(event) {
  if (!dragRow.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    endDrag();
  } else if (event.key === "Alt") {
    event.preventDefault();
    event.stopPropagation();
    altHeld.value = event.type === "keydown";
  }
}

function onPointerUp(event) {
  const row = dragRow.value;
  const at = dropAt.value;
  const creates = overBranches.value;
  const name = dragging.value;
  const branch = draggedBranch();
  const rebase = altHeld.value || (!isMac && event.altKey);
  endDrag();
  if (!row) return;
  // The click that follows the release isn't one.
  window.addEventListener("click", swallowClick, true);
  setTimeout(() => window.removeEventListener("click", swallowClick, true));
  if (creates) {
    emit("new-branch-from", branch);
  } else if (at?.merge) {
    emit(rebase ? "rebase-head-onto" : "merge-into-head", name);
  } else if (at) {
    const siblings = branchRows.value.filter((r) => r.parent === row.parent).map((r) => r.key);
    moveKey(arrangedIn.value, row.key, at.key, at.after, siblings);
  }
}

function swallowClick(event) {
  event.stopPropagation();
  window.removeEventListener("click", swallowClick, true);
}

function endDrag() {
  pressed = null;
  pointer = null;
  cancelAnimationFrame(scrolling);
  scrolling = 0;
  dragging.value = null;
  dragRow.value = null;
  dropAt.value = null;
  overBranches.value = false;
  altHeld.value = false;
  clearInterval(altPoll);
  altPoll = 0;
  window.removeEventListener("pointermove", onPointerMove, true);
  window.removeEventListener("pointerup", onPointerUp, true);
  window.removeEventListener("pointercancel", endDrag, true);
  window.removeEventListener("keydown", onDragKey, true);
  window.removeEventListener("keyup", onDragKey, true);
  window.removeEventListener("blur", endDrag);
  document.body.classList.remove("dragging-row");
  dragImage?.remove();
  dragImage = null;
}

onBeforeUnmount(endDrag);

// Whether what dropping would do is told above where it'd land, rather than below,
// for lack of room at the bottom of the sidebar. Asked again as the sidebar scrolls
// under the pointer, which can bring where it'd land nearer the bottom.
const sentenceAbove = ref(false);
function placeSentence() {
  const sentence = scroller.value?.querySelector(".drop-sentence");
  if (!sentence) return;
  const below = sentence.parentElement.getBoundingClientRect().bottom + 4 + sentence.offsetHeight;
  sentenceAbove.value = below > scroller.value.getBoundingClientRect().bottom;
}

// Where a drop on `row` would land, from how far down the row the pointer is.
function landing(row, rect, pointerY) {
  const dragged = dragRow.value;
  if (!dragged) return null;
  const y = (pointerY - rect.top) / rect.height;
  // Not while a merge or rebase is waiting.
  const merges = row.head && dragging.value && !props.overview.operation;
  const moves =
    canMove(dragged) && ARRANGEABLE.test(row.key) && row.key !== dragged.key && row.parent === dragged.parent;
  if (merges && (!moves || (y > 0.25 && y < 0.75))) return { key: row.key, merge: true };
  // Below an open folder's row are its own rows, so a row can't land straight after it.
  if (moves) return { key: row.key, after: y >= 0.5 && !(row.folder && row.open) };
  return null;
}

const dropClass = (row) => {
  if (commitOver.value === row.key) return "drop-target";
  const at = dropAt.value;
  if (at?.key !== row.key) return null;
  return at.merge ? "drop-target" : at.after ? "drop-after" : "drop-before";
};

// --- Commits dropped on the current branch --------------------------------------------
// Commits dragged from another branch's history (see commitDrag.js) are cherry-picked
// onto the current branch when they're dropped on its row. That drag is the web view's own,
// and its events are apart from the pointer events branches are dragged with above, so
// the two don't meet. Not while a merge or rebase waits on the user, as the menu has it.

// The row commits are dragged over, ready to drop.
const commitOver = ref(null);
const takesCommit = (row, event) => !!(row.head && isCommitDrag(event) && !props.overview.operation);
// Let go of, the row's let go of too.
watch(draggedCommits, (commits) => commits || (commitOver.value = null));

function onCommitDragOver(row, event) {
  if (!takesCommit(row, event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  commitOver.value = row.key;
}

function onCommitDragLeave(row, event) {
  if (commitOver.value === row.key && !event.currentTarget.contains(event.relatedTarget)) commitOver.value = null;
}

function onCommitDrop(row, event) {
  if (!takesCommit(row, event)) return;
  event.preventDefault();
  const commits = draggedCommits.value;
  commitOver.value = null;
  emit("cherry-pick", commits);
}

// Where what dropping would do is told, as the drop target or Alt changes (see
// placeSentence): after the drop targets above, branches' and commits', are set up.
watch([dropAt, overBranches, altHeld, commitOver], placeSentence, { flush: "post" });

const COMPARABLE = ["branch", "remote-branch", "tag"];

function onRowClick(row, event) {
  if (row.divider) return;
  if (row.key === OLDER_TAGS) {
    olderTagsOpen.value = !olderTagsOpen.value;
    return;
  }
  // Ctrl- (Cmd- on a Mac) or Shift-clicking a second branch or tag compares it with
  // the first.
  if ((commandKey(event) || event.shiftKey) && !row.folder && COMPARABLE.includes(row.key.split(":")[0])) {
    emit("compare", row.key);
    return;
  }
  if (row.folder && !query.value) {
    collapsedFolders.has(row.key) ? collapsedFolders.delete(row.key) : collapsedFolders.add(row.key);
  }
  emit("update:selected", row.key);
}
</script>

<template>
  <aside class="sidebar">
    <header class="sidebar-toolbar">
      <button class="repo-name" :title="`${overview.path}\nSwitch to another repository`" @click="emit('recent-menu', below($event))">
        <span class="repo-name-text">{{ overview.name }}</span>
        <ChevronsUpDown :size="14" :stroke-width="1.75" class="repo-name-chevron" />
      </button>
      <button class="icon-button" title="Open Repository…" @click="emit('open-repository')">
        <FolderOpen :size="18" :stroke-width="1.5" />
      </button>
      <!-- Your GitHub account and repositories, to clone from: the app's, not the open
           repository's, so not in the Workspace list. -->
      <button
        class="icon-button app-button"
        :class="{ active: selected === 'workspace:github' }"
        :title="githubAccount ? `GitHub: ${githubAccount.login}` : 'GitHub'"
        @click="emit('update:selected', 'workspace:github')"
      >
        <img v-if="githubAccount?.avatar_url" :src="githubAccount.avatar_url" alt="" class="account-avatar" />
        <Github v-else :size="18" :stroke-width="1.5" />
      </button>
    </header>

    <nav ref="scroller" class="sidebar-scroll" @scroll.passive="dragRow && placeSentence()">
      <section v-for="section in sections" :key="section.id" class="section">
        <button
          class="section-header"
          :class="{ 'drop-target': section.id === 'branches' && overBranches }"
          @click="toggleSection(section.id)"
          @contextmenu.prevent="emit('section-menu', section.id, $event)"
          :data-section="section.id"
        >
          <span>{{ section.title }}</span>
          <span class="section-toggle">{{ collapsedSections.has(section.id) ? "Show" : "Hide" }}</span>
          <Transition name="drop-sentence">
            <span v-if="section.id === 'branches' && overBranches" class="drop-sentence" :class="{ above: sentenceAbove }">
              Create a branch from <b>{{ draggedBranch() }}</b>
            </span>
          </Transition>
        </button>

        <template v-if="!collapsedSections.has(section.id)">
          <div
            v-for="row in section.rows"
            :key="row.key"
            class="row"
            :class="[dropClass(row), {
              selected: row.key === selected || compared.includes(row.key),
              current: switching ? row.key === switching : row.current,
              gone: row.gone,
              divider: row.divider,
              older: row.older,
            }]"
            :style="{ paddingLeft: `${(row.divider ? 28 : 8) + row.depth * 18}px` }"
            :title="dragRow ? undefined : row.title"
            :data-row="row.key"
            @pointerdown="onPointerDown(row, $event)"
            @dragover="onCommitDragOver(row, $event)"
            @dragleave="onCommitDragLeave(row, $event)"
            @drop="onCommitDrop(row, $event)"
            @click="onRowClick(row, $event)"
            @dblclick="row.older || emit('activate', row)"
            @contextmenu.prevent="
              if (!row.older) {
                row.divider || emit('update:selected', row.key);
                emit('menu', row, $event);
              }
            "
          >
            <template v-if="row.divider">
              <span v-if="row.label" class="divider-label">{{ row.label }}</span>
              <span class="divider-line" />
            </template>
            <template v-else>
              <span class="chevron">
                <ChevronRight v-if="row.folder" :size="14" :class="{ open: row.open }" />
              </span>
              <component :is="row.icon ?? Folder" class="row-icon" :size="17" :stroke-width="1.5" />
              <span class="row-label">{{ row.label }}</span>
              <span v-if="row.detail" class="row-detail">{{ row.detail }}</span>
              <Lock v-if="row.locked" :size="12" class="row-mark" />
              <FolderGit2 v-if="row.elsewhere" :size="13" class="row-mark" />
              <!-- A worktree's agent, in whichever window: as its terminal tab shows it. -->
              <Spinner v-if="row.agent === 'working'" :size="12" class="agent-mark" />
              <span v-else-if="row.agent" class="agent-mark agent-dot" :class="row.agent" />

              <Spinner v-if="row.key === switching" :size="13" class="switching" />
              <!-- HEAD detached at a commit shows HEAD too, though it isn't a branch to
                   merge into or drop commits on, as `head` would make it. -->
              <span v-else-if="row.head || row.detached || row.ahead || row.behind" class="pill">
                <span v-if="row.head || row.detached">HEAD</span>
                <span v-if="row.head && (row.ahead || row.behind)" class="pill-divider" />
                <span v-if="row.ahead" class="pill-count" :title="`${row.ahead} ahead of upstream`">
                  <ArrowUp :size="12" :stroke-width="2.25" />{{ row.ahead }}
                </span>
                <span v-if="row.behind" class="pill-count" :title="`${row.behind} behind upstream`">
                  <ArrowDown :size="12" :stroke-width="2.25" />{{ row.behind }}
                </span>
              </span>
              <span v-else-if="row.count" class="count" :class="{ fresh: row.fresh }">{{ row.count }}</span>

              <!-- Over the HEAD branch, what dropping does, in full: which branch moves where. -->
              <Transition name="drop-sentence">
                <span v-if="dropAt?.merge && dropAt.key === row.key" class="drop-sentence" :class="{ above: sentenceAbove }">
                  <template v-if="altHeld">Rebase <b>{{ row.label }}</b> onto <b>{{ dragging }}</b></template>
                  <template v-else>Merge <b>{{ dragging }}</b> into <b>{{ row.label }}</b></template>
                </span>
                <span v-else-if="commitOver === row.key && draggedCommits" class="drop-sentence" :class="{ above: sentenceAbove }">
                  Cherry-pick
                  <b>{{ draggedCommits.length > 1 ? `${draggedCommits.length} commits` : draggedCommits[0].summary }}</b>
                  into <b>{{ row.label }}</b>
                </span>
              </Transition>
            </template>
          </div>
        </template>
      </section>
    </nav>

    <footer class="sidebar-footer">
      <label class="filter">
        <ListFilter :size="15" :stroke-width="1.5" />
        <input v-model="filter" placeholder="Filter" spellcheck="false" @keydown.esc="filter = ''" />
        <button v-if="filter" class="filter-clear" title="Clear filter" @click="filter = ''">
          <X :size="13" />
        </button>
      </label>
      <button class="icon-button" title="Create a branch or tag, or add a remote" @click="emit('add-menu', $event)">
        <Plus :size="17" :stroke-width="1.5" />
      </button>
      <!-- Settings is the app's, not the open repository's, so it's here rather than in
           the Workspace list. -->
      <button
        class="icon-button app-button"
        :class="{ active: selected === 'workspace:settings' }"
        :title="`Settings (${shortcut('Ctrl+,')})`"
        @click="emit('update:selected', 'workspace:settings')"
      >
        <Settings :size="17" :stroke-width="1.5" />
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--sidebar-bg);
}

/* The open repository's name; clicking it lists the recent ones to switch to. */
.repo-name {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  margin-right: 6px;
  padding: 4px 8px;
  overflow: hidden;
  border: 0;
  border-radius: var(--radius-md);
  background: none;
  font: inherit;
  font-size: var(--font-xl);
  font-weight: 600;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.repo-name:hover {
  background: var(--button-hover);
}

.repo-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Says the name opens a menu, of other repositories to switch to. */
.repo-name-chevron {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.repo-name:hover .repo-name-chevron {
  color: var(--text-secondary);
}

.sidebar-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: var(--toolbar-height);
  padding: 0 12px;
  flex-shrink: 0;
}

/* The macOS window buttons get a row of their own above the name, which then lines
   up with the section labels below. */
:root[data-title-bar="overlay"] .sidebar-toolbar {
  height: auto;
  padding-top: 30px;
  padding-bottom: 6px;
}

.sidebar-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 12px;
}

.section + .section {
  margin-top: 14px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 4px 10px;
  border: 0;
  background: none;
  font: inherit;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-tertiary);
  cursor: default;
}

.section-toggle {
  font-weight: 500;
  visibility: hidden;
}

.section-header:hover .section-toggle {
  visibility: visible;
}

/* A branch dragged onto Branches, to create a branch from it. */
.section-header.drop-target {
  position: relative;
  border-radius: var(--radius-md);
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--text-primary);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-right: 8px;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  white-space: nowrap;
  cursor: default;
}

.row[draggable="true"] {
  -webkit-user-drag: element;
}

.row {
  position: relative;
}

/* Where a dragged row would land. */
.row.drop-before::before,
.row.drop-after::before {
  content: "";
  position: absolute;
  right: 4px;
  left: 4px;
  height: 2px;
  border-radius: var(--radius-xs);
  background: var(--accent-fill);
  pointer-events: none;
}

.row.drop-before::before {
  top: -1px;
}

.row.drop-after::before {
  bottom: -1px;
}

/* A line between groups of branches, after an optional label, both lined up with
   the branches' icons (see the row's padding). */
.row.divider {
  gap: 8px;
  height: 22px;
  padding-right: 8px;
}

.row.divider:hover,
.row.divider.selected {
  background: none;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: var(--border);
}

.divider-label {
  max-width: 75%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-tertiary);
}

/* The HEAD branch while a branch is dragged over it, ready to merge. */
.row.drop-target {
  position: relative;
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

/* Hung below the row, over those after it, so nothing under the pointer moves. */
.drop-sentence {
  position: absolute;
  top: calc(100% + 4px);
  left: 8px;
  z-index: 5;
  width: max-content;
  max-width: calc(100% - 16px);
  padding: 4px 9px;
  border-radius: var(--radius-md);
  background: var(--accent-fill);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
  font-size: var(--font-sm);
  font-weight: 500;
  line-height: 1.35;
  text-align: left;
  /* A long branch name wraps rather than being cut short: it's the point. */
  white-space: normal;
  overflow-wrap: anywhere;
  color: white;
  pointer-events: none;
}

.drop-sentence.above {
  top: auto;
  bottom: calc(100% + 4px);
}

.drop-sentence b {
  font-weight: 700;
}

.drop-sentence-enter-active {
  transition:
    opacity 120ms ease-out,
    transform 120ms ease-out;
}

.drop-sentence-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .drop-sentence-enter-active {
    transition: none;
  }
}

.row:hover {
  background: var(--row-hover);
}

.row.selected {
  background: var(--row-selected);
}

.row.current {
  color: var(--accent);
}

.chevron {
  display: flex;
  justify-content: center;
  width: 14px;
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.chevron svg {
  transition: transform 0.12s ease;
}

.chevron svg.open {
  transform: rotate(90deg);
}

.row-icon {
  flex-shrink: 0;
  color: var(--icon);
}

/* "Older", the folder of all but the newest tags: quieter than the tags above it. */
.row.older {
  color: var(--text-secondary);
}

.row.older .row-icon {
  color: var(--text-tertiary);
}

.switching {
  margin-right: 4px;
  color: var(--accent);
}

.row.current .row-icon {
  color: var(--accent);
}

.row-detail {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.row-mark {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.agent-mark {
  flex-shrink: 0;
  color: var(--accent);
}

/* As a terminal tab's mark: finished, or needs you, and red for an error. */
.agent-dot {
  width: 7px;
  height: 7px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--accent-fill);
}

.agent-dot.error {
  background: var(--danger);
}

.row.gone .row-label {
  color: var(--text-tertiary);
  text-decoration: line-through;
}

.row-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 1px 7px;
  border-radius: var(--radius-md);
  background: var(--pill-bg);
  color: var(--text-primary);
  font-size: var(--font-sm);
  font-weight: 600;
}

.pill-count {
  display: flex;
  align-items: center;
}

.pill-divider {
  width: 1px;
  height: 11px;
  background: var(--text-tertiary);
}

.count {
  color: var(--text-tertiary);
  font-size: var(--font-sm);
}

/* New issues are waiting. */
.count.fresh {
  padding: 0 6px;
  border-radius: var(--radius-lg);
  background: var(--accent-fill);
  font-weight: 600;
  color: #fff;
}

.app-button.active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}

.account-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
}

.sidebar-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 44px;
  padding: 0 10px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.filter {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
}

.filter:focus-within {
  background: var(--input-bg);
  box-shadow: 0 0 0 1px var(--border);
}

.filter input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  font: inherit;
  color: var(--text-primary);
}

.filter-clear {
  display: flex;
  padding: 2px;
  border: 0;
  border-radius: 50%;
  background: var(--pill-bg);
  color: var(--text-secondary);
}
</style>
