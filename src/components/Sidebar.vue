<script setup>
import { computed, reactive, ref } from "vue";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  Cloud,
  Folder,
  FolderOpen,
  GitBranch,
  ListFilter,
  Package,
  Plus,
  Github,
  Settings,
  Tag,
  X,
} from "lucide-vue-next";
import { buildTree, flattenTree } from "../lib/tree.js";
import { commandKey } from "../lib/platform.js";
import { branchOrder, dividerRows, isDivider, moveKey } from "../lib/branchOrder.js";

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
});
const emit = defineEmits([
  "update:selected",
  "compare",
  "open-repository",
  "menu",
  "activate",
  "section-menu",
  "merge-into-head",
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
const matches = (name) => !query.value || name.toLowerCase().includes(query.value);
// While filtering, every folder opens so matches nested inside them stay visible.
const isOpen = (key) => query.value !== "" || !collapsedFolders.has(key);

// Issues and pull requests only for repositories on GitHub.
const workspaceRows = computed(() =>
  [
    {
      key: "workspace:working-copy",
      label: "Working Copy",
      icon: Folder,
      depth: 0,
      count: props.overview.changes || null,
    },
    {
      key: "workspace:stashes",
      label: "Stashes",
      icon: Archive,
      depth: 0,
      count: props.overview.stashes.length || null,
    },
    props.issues && {
      key: "workspace:issues",
      label: "Issues",
      icon: CircleDot,
      depth: 0,
      count: props.issues.count || null,
      fresh: props.issues.fresh > 0,
      title: props.issues.fresh > 0 ? `${props.issues.fresh} new since you last looked` : null,
    },
    props.pulls && {
      key: "workspace:pulls",
      label: "Pull Requests",
      icon: GitPullRequest,
      depth: 0,
      count: props.pulls.count || null,
    },
    { key: "workspace:github", label: "GitHub", icon: Github, depth: 0 },
    { key: "workspace:settings", label: "Settings", icon: Settings, depth: 0 },
  ].filter(Boolean),
);

// In the order they've been dragged into, with their dividers, though those stay
// hidden while filtering.
const branchRows = computed(() =>
  flattenTree(
    buildTree(
      props.overview.branches.filter((b) => matches(b.name)),
      (b) => b.name,
    ),
    {
      keyPrefix: "branch-folder:",
      isOpen,
      order: branchOrder(props.overview.path),
      extraRows: query.value ? [] : dividerRows(props.overview.path),
      leafRow: (b) => ({
        key: `branch:${b.name}`,
        icon: GitBranch,
        current: b.is_head,
        head: b.is_head,
        ahead: b.ahead,
        behind: b.behind,
        title: b.upstream ? `${b.name} → ${b.upstream}` : b.name,
      }),
    },
  ),
);

const tagRows = computed(() =>
  flattenTree(
    buildTree(props.overview.tags.filter(matches), (t) => t),
    {
      keyPrefix: "tag-folder:",
      isOpen,
      leafRow: (t) => ({ key: `tag:${t}`, icon: Tag, title: t }),
    },
  ),
);

const remoteRows = computed(() =>
  props.overview.remotes.flatMap((remote) => {
    const branches = remote.branches.filter(matches);
    if (query.value && !branches.length && !matches(remote.name)) {
      return [];
    }

    const key = `remote:${remote.name}/`;
    const open = isOpen(key);
    const rows = [
      { key, label: remote.name, depth: 0, folder: true, open, icon: Cloud, title: remote.url },
    ];
    if (open) {
      rows.push(
        ...flattenTree(buildTree(branches, (b) => b), {
          depth: 1,
          keyPrefix: key,
          isOpen,
          leafRow: (b) => ({
            key: `remote-branch:${remote.name}/${b}`,
            icon: GitBranch,
            title: `${remote.name}/${b}`,
          }),
        }),
      );
    }
    return rows;
  }),
);

const stashRows = computed(() =>
  props.overview.stashes
    .filter((s) => matches(s.message))
    .map((s) => ({
      key: `stash:${s.index}`,
      label: s.message,
      icon: Archive,
      depth: 0,
      title: `stash@{${s.index}}: ${s.message}`,
    })),
);

const submoduleRows = computed(() =>
  props.overview.submodules
    .filter((s) => matches(s.name))
    .map((s) => ({ key: `submodule:${s.path}`, label: s.name, icon: Package, depth: 0, title: s.path })),
);

const sections = computed(() =>
  [
    { id: "workspace", title: "Workspace", rows: workspaceRows.value },
    { id: "branches", title: "Branches", rows: branchRows.value },
    { id: "tags", title: "Tags", rows: tagRows.value },
    { id: "remotes", title: "Remotes", rows: remoteRows.value },
    { id: "stashes", title: "Stashes", rows: stashRows.value, optional: true },
    { id: "submodules", title: "Submodules", rows: submoduleRows.value, optional: true },
  ].filter((s) => !s.optional || s.rows.length),
);

function toggleSection(id) {
  collapsedSections.has(id) ? collapsedSections.delete(id) : collapsedSections.add(id);
}

// --- Dragging branches -----------------------------------------------------------------

// Dragging a branch onto the HEAD branch merges it. Dragging a branch, folder or
// divider elsewhere in Branches moves it among the rows in the same folder, except
// while filtering. On the HEAD branch, the middle of the row merges and its edges
// move.

// The name of the branch being dragged, if it can be merged; the row being dragged;
// and where it would land: { key, merge } or { key, after }.
const dragging = ref(null);
const dragRow = ref(null);
const dropAt = ref(null);

const ARRANGEABLE = /^branch(-folder|-divider)?:/;
const canMerge = (row) => !row.folder && !row.divider && (row.key.startsWith("branch:") || row.key.startsWith("remote-branch:"));
const canMove = (row) => !query.value && ARRANGEABLE.test(row.key);
const canDrag = (row) => (canMerge(row) && !row.head) || canMove(row);

// What follows the pointer: the row's icon and name, rather than the web view's
// snapshot of the whole row. It has to be on the page while dragging, so it sits
// off-screen until the drag ends.
let dragImage = null;

function onDragStart(row, event) {
  dragRow.value = row;
  dragging.value = canMerge(row) && !row.head ? row.key.slice(row.key.indexOf(":") + 1) : null;
  event.dataTransfer.setData("text/plain", row.key);
  event.dataTransfer.effectAllowed = "copyMove";

  dragImage = document.createElement("div");
  dragImage.className = "drag-image";
  const icon = event.currentTarget.querySelector(".row-icon")?.cloneNode(true);
  if (icon) dragImage.append(icon);
  dragImage.append(row.divider ? row.label || "Divider" : row.label);
  document.body.append(dragImage);
  event.dataTransfer.setDragImage(dragImage, 14, dragImage.offsetHeight / 2);
}

function onDragEnd() {
  dragging.value = null;
  dragRow.value = null;
  dropAt.value = null;
  dragImage?.remove();
  dragImage = null;
}

// Where a drop on `row` would land, from how far down the row the pointer is.
function landing(row, event) {
  const dragged = dragRow.value;
  if (!dragged) return null;
  const rect = event.currentTarget.getBoundingClientRect();
  const y = (event.clientY - rect.top) / rect.height;
  // Not while a merge or rebase is waiting.
  const merges = row.head && dragging.value && !props.overview.operation;
  const moves =
    canMove(dragged) && ARRANGEABLE.test(row.key) && row.key !== dragged.key && row.parent === dragged.parent;
  if (merges && (!moves || (y > 0.25 && y < 0.75))) return { key: row.key, merge: true };
  // Below an open folder's row are its own rows, so a row can't land straight after it.
  if (moves) return { key: row.key, after: y >= 0.5 && !(row.folder && row.open) };
  return null;
}

function onDragOver(row, event) {
  const at = landing(row, event);
  if (!at) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = at.merge ? "copy" : "move";
  dropAt.value = at;
}

function onDragLeave(row, event) {
  if (dropAt.value?.key === row.key && !event.currentTarget.contains(event.relatedTarget)) dropAt.value = null;
}

function onDrop(row, event) {
  const at = landing(row, event);
  if (!at) return;
  event.preventDefault();
  const name = dragging.value;
  const dragged = dragRow.value;
  onDragEnd();
  if (at.merge) {
    emit("merge-into-head", name);
    return;
  }
  const siblings = branchRows.value.filter((r) => r.parent === dragged.parent).map((r) => r.key);
  moveKey(props.overview.path, dragged.key, row.key, at.after, siblings);
}

const dropClass = (row) => {
  const at = dropAt.value;
  if (at?.key !== row.key) return null;
  return at.merge ? "drop-target" : at.after ? "drop-after" : "drop-before";
};

const COMPARABLE = ["branch", "remote-branch", "tag"];

function onRowClick(row, event) {
  if (row.divider) return;
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
        {{ overview.name }}
      </button>
      <button class="icon-button" title="Open Repository…" @click="emit('open-repository')">
        <FolderOpen :size="18" :stroke-width="1.5" />
      </button>
    </header>

    <nav class="sidebar-scroll">
      <section v-for="section in sections" :key="section.id" class="section">
        <button
          class="section-header"
          @click="toggleSection(section.id)"
          @contextmenu.prevent="emit('section-menu', section.id, $event)"
        >
          <span>{{ section.title }}</span>
          <span class="section-toggle">{{ collapsedSections.has(section.id) ? "Show" : "Hide" }}</span>
        </button>

        <template v-if="!collapsedSections.has(section.id)">
          <div
            v-for="row in section.rows"
            :key="row.key"
            class="row"
            :class="[dropClass(row), {
              selected: row.key === selected || compared.includes(row.key),
              current: row.current,
              divider: row.divider,
            }]"
            :style="{ paddingLeft: `${(row.divider ? 28 : 8) + row.depth * 18}px` }"
            :title="row.head && dragging ? `Merge ${dragging} into ${row.label}` : row.title"
            :draggable="canDrag(row)"
            @dragstart="onDragStart(row, $event)"
            @dragend="onDragEnd"
            @dragover="onDragOver(row, $event)"
            @dragleave="onDragLeave(row, $event)"
            @drop="onDrop(row, $event)"
            @click="onRowClick(row, $event)"
            @dblclick="emit('activate', row)"
            @contextmenu.prevent="
              row.divider || emit('update:selected', row.key);
              emit('menu', row, $event);
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

              <span v-if="row.head || row.ahead || row.behind" class="pill">
                <span v-if="row.head">HEAD</span>
                <span v-if="row.head && (row.ahead || row.behind)" class="pill-divider" />
                <span v-if="row.ahead" class="pill-count" :title="`${row.ahead} ahead of upstream`">
                  <ArrowUp :size="12" :stroke-width="2.25" />{{ row.ahead }}
                </span>
                <span v-if="row.behind" class="pill-count" :title="`${row.behind} behind upstream`">
                  <ArrowDown :size="12" :stroke-width="2.25" />{{ row.behind }}
                </span>
              </span>
              <span v-else-if="row.count" class="count" :class="{ fresh: row.fresh }">{{ row.count }}</span>
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
  flex: 1;
  min-width: 0;
  margin-right: 6px;
  padding: 4px 8px;
  overflow: hidden;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.repo-name:hover {
  background: var(--button-hover);
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
  font-size: 12px;
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

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-right: 8px;
  border-radius: 6px;
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
  border-radius: 1px;
  background: var(--accent);
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
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-tertiary);
}

/* The HEAD branch while a branch is dragged over it, ready to merge. */
.row.drop-target {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
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

.row.current .row-icon {
  color: var(--accent);
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
  border-radius: 6px;
  background: var(--pill-bg);
  color: var(--text-primary);
  font-size: 12px;
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
  font-size: 12px;
}

/* New issues are waiting. */
.count.fresh {
  padding: 0 6px;
  border-radius: 8px;
  background: var(--accent);
  font-weight: 600;
  color: #fff;
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
  border-radius: 6px;
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
