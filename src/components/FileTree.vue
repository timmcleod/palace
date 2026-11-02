<script>
import { reactive } from "vue";

// Each repository's open folders and whether ignored files show, kept while away from
// the Files view: path -> { expanded, showIgnored }.
const remembered = reactive(new Map());
</script>

<script setup>
import { computed, nextTick, shallowRef, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, CircleAlert } from "lucide-vue-next";
import FileIcon from "./FileIcon.vue";
import { focusOnOpen, isUnsaved } from "../lib/editing.js";
import { fileManager } from "../lib/platform.js";
import { askConfirm, openForm, openMenu, tell } from "../lib/overlays.js";

// The working copy's folders and files as they are on disk, with git's view of each:
// changed, new, conflicted. Folders with changes inside them show a dot.
const props = defineProps({
  path: { type: String, required: true },
  selected: { type: String, default: null },
  refreshKey: { type: Number, default: 0 },
});
// "deleted" says what was deleted, so the editor can let it go, "renamed" what was
// renamed ({ from, to }), so it can follow, and "open-terminal" a folder to start a
// terminal in.
const emit = defineEmits(["select", "deleted", "renamed", "open-terminal"]);

watch(
  () => props.path,
  (path) => remembered.has(path) || remembered.set(path, { expanded: new Set(), showIgnored: false }),
  { immediate: true },
);
const view = computed(() => remembered.get(props.path));
defineExpose({
  toggleIgnored: () => (view.value.showIgnored = !view.value.showIgnored),
  showsIgnored: () => view.value.showIgnored,
});

// Loaded folder listings by folder path ("" is the top).
const listings = shallowRef(new Map());
// path -> "modified", "added", "untracked", "renamed", "deleted" or "conflicted".
const statuses = shallowRef(new Map());
const error = ref("");
let loadSeq = 0;

const listing = (dir) => invoke("working_entries", { path: props.path, dir, showIgnored: view.value.showIgnored });

async function load() {
  const seq = ++loadSeq;
  const dirs = ["", ...view.value.expanded];
  const [results, status] = await Promise.all([
    Promise.allSettled(dirs.map(listing)),
    invoke("working_status", { path: props.path }).catch(() => []),
  ]);
  if (seq !== loadSeq) return;
  const loaded = new Map();
  error.value = "";
  results.forEach((result, i) => {
    if (result.status === "fulfilled") loaded.set(dirs[i], result.value);
    else if (dirs[i] === "") error.value = String(result.reason);
    else view.value.expanded.delete(dirs[i]);
  });
  // Folders opened while this loaded keep what they found.
  for (const [dir, entries] of listings.value) {
    if (!loaded.has(dir) && view.value.expanded.has(dir)) loaded.set(dir, entries);
  }
  listings.value = loaded;
  statuses.value = new Map(status.map((f) => [f.path, f.conflicted ? "conflicted" : (f.unstaged ?? f.staged)]));
}

watch(() => [props.path, props.refreshKey, view.value.showIgnored], load, { immediate: true });

async function toggle(dir) {
  const { expanded } = view.value;
  if (expanded.has(dir)) {
    expanded.delete(dir);
    return;
  }
  expanded.add(dir);
  if (!listings.value.has(dir)) {
    try {
      const entries = await listing(dir);
      listings.value = new Map(listings.value).set(dir, entries);
    } catch {
      expanded.delete(dir);
    }
  }
}

// Opens the folders on the way to `file`, as when it's picked from the search.
async function reveal(file) {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    if (!view.value.expanded.has(dir)) await toggle(dir);
  }
}
watch(() => props.selected, (file) => file && reveal(file), { immediate: true });

// Folders holding changed files, for their dots.
const changedFolders = computed(() => {
  const folders = new Set();
  for (const file of statuses.value.keys()) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return folders;
});

const rows = computed(() => {
  const result = [];
  const add = (dir, depth) => {
    for (const entry of listings.value.get(dir) ?? []) {
      result.push({ ...entry, depth });
      if (entry.kind === "dir" && view.value.expanded.has(entry.path)) add(entry.path, depth + 1);
    }
  };
  add("", 0);
  return result;
});

const BADGES = {
  modified: ["M", "Modified"],
  added: ["A", "Added"],
  untracked: ["U", "New, not yet tracked by git"],
  renamed: ["R", "Renamed"],
  typechange: ["T", "Changed type"],
  conflicted: ["!", "Conflicted"],
};


// --- New files and folders ---------------------------------------------------------

const folderOf = (file) => (file?.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

// Asks for a name, in `dir` ("" for the top), then makes it. A name can go into new
// folders ("docs/guide.md"). A new file opens, ready to write.
async function create(dir, folder) {
  const values = await openForm({
    title: folder ? "New Folder" : "New File",
    message: dir ? `In ${dir}/` : "At the top of the repository.",
    fields: [{ key: "name", label: "Name", type: "text", placeholder: folder ? "assets" : "notes.md" }],
    confirmLabel: "Create",
  });
  const name = values?.name?.trim().replace(/^\/+|\/+$/g, "");
  if (!name) return;
  const file = dir ? `${dir}/${name}` : name;
  try {
    await invoke("create_working_file", { path: props.path, file, folder });
  } catch (e) {
    tell(folder ? "Couldn't Create the Folder" : "Couldn't Create the File", String(e));
    return;
  }
  // Opens the folders down to it, and shows it.
  const opened = folder ? file : folderOf(file);
  const parts = opened ? opened.split("/") : [];
  for (let i = 1; i <= parts.length; i++) view.value.expanded.add(parts.slice(0, i).join("/"));
  await load();
  if (!folder) {
    focusOnOpen();
    emit("select", file);
  }
}

// Renames within the file's folder, or into a new one inside it ("old/notes.md").
async function rename(row) {
  const folder = row.kind === "dir";
  const dir = folderOf(row.path);
  const values = await openForm({
    title: folder ? "Rename Folder" : "Rename File",
    message: dir ? `In ${dir}/` : "At the top of the repository.",
    fields: [{ key: "name", label: "Name", type: "text", value: row.name }],
    confirmLabel: "Rename",
  });
  const name = values?.name?.trim().replace(/^\/+|\/+$/g, "");
  if (!name || name === row.name) return;
  const to = dir ? `${dir}/${name}` : name;
  try {
    await invoke("rename_working_file", { path: props.path, from: row.path, to });
  } catch (e) {
    tell(folder ? "Couldn't Rename the Folder" : "Couldn't Rename the File", String(e));
    return;
  }
  // Open folders keep open under their new names, and the way to it opens.
  const { expanded } = view.value;
  for (const open of [...expanded]) {
    if (open === row.path || open.startsWith(`${row.path}/`)) {
      expanded.delete(open);
      expanded.add(to + open.slice(row.path.length));
    }
  }
  const parts = folderOf(to) ? folderOf(to).split("/") : [];
  for (let i = 1; i <= parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
  emit("renamed", { from: row.path, to });
  await load();
}

// A copy beside the file ("notes copy.md"), opened to change.
async function duplicate(row) {
  try {
    const copy = await invoke("duplicate_working_file", { path: props.path, file: row.path });
    await load();
    focusOnOpen();
    emit("select", copy);
  } catch (e) {
    tell("Couldn't Duplicate the File", String(e));
  }
}

// Deleting moves to the Trash, where it can be got back from, as discarding does.
async function remove(row) {
  const folder = row.kind === "dir";
  const ok = await askConfirm({
    title: folder ? "Delete Folder?" : "Delete File?",
    message: folder
      ? `“${row.path}” and everything in it will be moved to the Trash.`
      : `“${row.path}” will be moved to the Trash.${isUnsaved(props.path, row.path) ? " Your edits to it that aren't saved will be lost." : ""}`,
    confirmLabel: "Move to Trash",
    danger: true,
  });
  if (!ok) return;
  try {
    await invoke("delete_working_file", { path: props.path, file: row.path });
  } catch (e) {
    tell(folder ? "Couldn't Delete the Folder" : "Couldn't Delete the File", String(e));
    return;
  }
  view.value.expanded.delete(row.path);
  emit("deleted", row.path);
  await load();
}

const outside = (command, failed, file) => invoke(command, { path: props.path, file }).catch((e) => tell(failed, String(e)));

function rowMenu(event, row) {
  const dir = row.kind === "dir" ? row.path : folderOf(row.path);
  const isFile = row.kind === "file" || row.kind === "link";
  openMenu(event, [
    { label: "New File…", action: () => create(dir, false) },
    { label: "New Folder…", action: () => create(dir, true) },
    { separator: true },
    isFile && { label: "Open in Default App", action: () => outside("open_in_editor", "Couldn't Open the File", row.path) },
    { label: `Reveal in ${fileManager}`, action: () => outside("show_in_folder", "Couldn't Show It", row.path) },
    { label: "Open Terminal Here", action: () => emit("open-terminal", dir) },
    { label: "Copy Path", action: () => navigator.clipboard.writeText(row.path) },
    { separator: true },
    { label: "Rename…", action: () => rename(row) },
    row.kind === "file" && { label: "Duplicate", action: () => duplicate(row) },
    { label: "Delete…", danger: true, action: () => remove(row) },
  ]);
}

// Right-clicking empty space acts on the top of the repository.
function listMenu(event) {
  if (event.target.closest(".tree-row")) return;
  openMenu(event, [
    { label: "New File…", action: () => create("", false) },
    { label: "New Folder…", action: () => create("", true) },
    { separator: true },
    { label: "Open Terminal Here", action: () => emit("open-terminal", "") },
  ]);
}

function activate(row) {
  cursor.value = row.path;
  if (row.kind === "dir") toggle(row.path);
  else if (row.kind === "file" || row.kind === "link") emit("select", row.path);
}

// --- Keys -------------------------------------------------------------------------
// The arrows move through the tree, as in a file manager: Up and Down from row to row,
// Right opens a folder or steps into it, Left closes it or steps out to its folder.
// Enter or Space opens a file.

// The row the keys act on: the open file's, until they move.
const cursor = ref(null);
watch(() => props.selected, (file) => (cursor.value = file), { immediate: true });

function moveTo(row) {
  if (!row) return;
  cursor.value = row.path;
  nextTick(() => list.value?.querySelector(`[data-path="${CSS.escape(row.path)}"]`)?.scrollIntoView({ block: "nearest" }));
}

const list = ref(null);

function onKeydown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const all = rows.value;
  if (!all.length) return;
  const at = all.findIndex((r) => r.path === cursor.value);
  const row = all[at];
  const keys = {
    ArrowDown: () => moveTo(all[at < 0 ? 0 : Math.min(at + 1, all.length - 1)]),
    ArrowUp: () => moveTo(all[at < 0 ? 0 : Math.max(at - 1, 0)]),
    Home: () => moveTo(all[0]),
    End: () => moveTo(all.at(-1)),
    ArrowRight: () => {
      if (row?.kind !== "dir") return;
      if (!view.value.expanded.has(row.path)) toggle(row.path);
      else if (all[at + 1]?.depth > row.depth) moveTo(all[at + 1]);
    },
    ArrowLeft: () => {
      if (!row) return;
      if (row.kind === "dir" && view.value.expanded.has(row.path)) toggle(row.path);
      else moveTo(all.find((r) => r.path === folderOf(row.path)));
    },
    Enter: () => row && activate(row),
    " ": () => row && activate(row),
  };
  if (!keys[event.key]) return;
  event.preventDefault();
  keys[event.key]();
}
</script>

<template>
  <div ref="list" class="file-tree" tabindex="0" @contextmenu="listMenu" @keydown="onKeydown">
    <p v-if="error" class="message"><CircleAlert :size="15" /> {{ error }}</p>
    <div
      v-for="row in rows"
      :key="row.path"
      class="tree-row"
      :data-path="row.path"
      :class="{ selected: row.path === selected, cursor: row.path === cursor, muted: row.ignored || row.kind === 'submodule' }"
      :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
      :title="row.kind === 'submodule' ? 'A separate repository' : row.path"
      @click="activate(row)"
      @contextmenu.prevent="rowMenu($event, row)"
    >
      <ChevronRight v-if="row.kind === 'dir'" :size="14" class="chevron" :class="{ open: view.expanded.has(row.path) }" />
      <span v-else class="chevron" />
      <FileIcon :name="row.name" :kind="row.kind" :open="view.expanded.has(row.path)" />
      <span class="name" :class="statuses.get(row.path)">{{ row.name }}</span>
      <span v-if="isUnsaved(path, row.path)" class="unsaved" title="Edits not saved" />
      <span v-if="row.kind === 'dir' && changedFolders.has(row.path)" class="changed-dot" title="Has changes" />
      <span v-else-if="BADGES[statuses.get(row.path)]" class="badge" :class="statuses.get(row.path)" :title="BADGES[statuses.get(row.path)][1]">
        {{ BADGES[statuses.get(row.path)][0] }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.file-tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding-right: 12px;
  white-space: nowrap;
  cursor: default;
}

.tree-row:hover {
  background: var(--row-hover);
}

.tree-row.selected {
  background: var(--row-selected);
}

.file-tree:focus {
  outline: none;
}

/* Where the keys are, while the tree has them: a bar down the row's edge, and a tint
   when it isn't on the open file. */
.file-tree:focus .tree-row.cursor {
  box-shadow: inset 2px 0 var(--accent);
}

.file-tree:focus .tree-row.cursor:not(.selected) {
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}

.tree-row.muted {
  color: var(--text-tertiary);
}

.chevron {
  flex-shrink: 0;
  width: 14px;
  color: var(--text-tertiary);
  transition: transform 0.1s;
}

.chevron.open {
  transform: rotate(90deg);
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Changed files' names take their status's color, as in the Working Copy. */
.name.modified,
.badge.modified {
  color: var(--ref-tag);
}

.name.added,
.name.untracked,
.badge.added,
.badge.untracked {
  color: var(--diff-added-text);
}

.name.conflicted,
.badge.conflicted {
  color: var(--danger);
}

.badge {
  flex-shrink: 0;
  width: 14px;
  font-family: ui-monospace, "Ubuntu Mono", monospace;
  font-size: 11.5px;
  font-weight: 700;
  text-align: center;
  color: var(--text-tertiary);
}

.changed-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  margin: 0 4px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ref-tag) 75%, transparent);
}

/* A dot for edits not saved, as editors mark them. */
.unsaved {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-secondary);
}

.message {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 16px;
  color: var(--text-tertiary);
}
</style>
