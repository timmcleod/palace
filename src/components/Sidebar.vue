<script setup>
import { computed, reactive, ref } from "vue";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Cloud,
  Folder,
  FolderOpen,
  GitBranch,
  ListFilter,
  Package,
  Plus,
  Github,
  Settings,
  SlidersHorizontal,
  Tag,
  X,
} from "lucide-vue-next";
import { buildTree, flattenTree } from "../lib/tree.js";

const props = defineProps({
  overview: { type: Object, required: true },
  selected: { type: String, default: null },
});
const emit = defineEmits(["update:selected", "open-repository", "menu", "activate", "section-menu", "merge-into-head"]);

const filter = ref("");
const collapsedSections = reactive(new Set());
const collapsedFolders = reactive(new Set());

const query = computed(() => filter.value.trim().toLowerCase());
const matches = (name) => !query.value || name.toLowerCase().includes(query.value);
// While filtering, every folder opens so matches nested inside them stay visible.
const isOpen = (key) => query.value !== "" || !collapsedFolders.has(key);

const workspaceRows = computed(() => [
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
  { key: "workspace:github", label: "GitHub", icon: Github, depth: 0 },
  { key: "workspace:settings", label: "Settings", icon: Settings, depth: 0 },
]);

const branchRows = computed(() =>
  flattenTree(
    buildTree(
      props.overview.branches.filter((b) => matches(b.name)),
      (b) => b.name,
    ),
    {
      keyPrefix: "branch-folder:",
      isOpen,
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

// --- Dragging a branch onto the HEAD branch merges it --------------------------------

// The name of the branch being dragged, and whether it's over the HEAD branch.
const dragging = ref(null);
const overHead = ref(false);

const canDrag = (row) =>
  !row.folder && ((row.key.startsWith("branch:") && !row.head) || row.key.startsWith("remote-branch:"));

// What follows the pointer: the row's icon and name, rather than the web view's
// snapshot of the whole row. It has to be on the page while dragging, so it sits
// off-screen until the drag ends.
let dragImage = null;

function onDragStart(row, event) {
  dragging.value = row.key.slice(row.key.indexOf(":") + 1);
  event.dataTransfer.setData("text/plain", dragging.value);
  event.dataTransfer.effectAllowed = "copy";

  dragImage = document.createElement("div");
  dragImage.className = "drag-image";
  const icon = event.currentTarget.querySelector(".row-icon")?.cloneNode(true);
  if (icon) dragImage.append(icon);
  dragImage.append(row.label);
  document.body.append(dragImage);
  event.dataTransfer.setDragImage(dragImage, 14, dragImage.offsetHeight / 2);
}

function onDragEnd() {
  dragging.value = null;
  overHead.value = false;
  dragImage?.remove();
  dragImage = null;
}

// Only the HEAD branch accepts a drop, and not while a merge or rebase is waiting.
function onDragOver(row, event) {
  if (!row.head || !dragging.value || props.overview.operation) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  overHead.value = true;
}

function onDragLeave(row, event) {
  if (row.head && !event.currentTarget.contains(event.relatedTarget)) overHead.value = false;
}

function onDrop(row, event) {
  if (!row.head || !dragging.value) return;
  event.preventDefault();
  const name = dragging.value;
  onDragEnd();
  emit("merge-into-head", name);
}

function onRowClick(row) {
  if (row.folder && !query.value) {
    collapsedFolders.has(row.key) ? collapsedFolders.delete(row.key) : collapsedFolders.add(row.key);
  }
  emit("update:selected", row.key);
}
</script>

<template>
  <aside class="sidebar">
    <header class="sidebar-toolbar">
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
            :class="{ selected: row.key === selected, current: row.current, 'drop-target': row.head && overHead }"
            :style="{ paddingLeft: `${8 + row.depth * 18}px` }"
            :title="row.head && dragging ? `Merge ${dragging} into ${row.label}` : row.title"
            :draggable="canDrag(row)"
            @dragstart="onDragStart(row, $event)"
            @dragend="onDragEnd"
            @dragover="onDragOver(row, $event)"
            @dragleave="onDragLeave(row, $event)"
            @drop="onDrop(row, $event)"
            @click="onRowClick(row)"
            @dblclick="emit('activate', row)"
            @contextmenu.prevent="
              emit('update:selected', row.key);
              emit('menu', row, $event);
            "
          >
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
            <span v-else-if="row.count" class="count">{{ row.count }}</span>
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
      <button class="icon-button" title="New branch (coming soon)" disabled>
        <Plus :size="17" :stroke-width="1.5" />
      </button>
      <button class="icon-button" title="Sidebar options (coming soon)" disabled>
        <SlidersHorizontal :size="16" :stroke-width="1.5" />
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

.sidebar-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: var(--toolbar-height);
  padding: 0 12px;
  flex-shrink: 0;
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
