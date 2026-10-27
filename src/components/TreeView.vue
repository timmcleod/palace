<script setup>
import { computed, reactive, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, CircleAlert, File, FileSymlink, Folder, FolderGit2, FolderOpen } from "lucide-vue-next";

// Every file as it was at a commit: a folder tree on top, the chosen file below.
const props = defineProps({
  path: { type: String, required: true },
  commit: { type: Object, required: true },
  // A file to reveal and open, such as the one being searched for.
  reveal: { type: String, default: null },
});

// Loaded folder listings by folder path ("" is the top), and which folders are open.
const listings = reactive(new Map());
const expanded = reactive(new Set());
const selected = ref(null);
const contents = shallowRef(null);
const error = ref("");

let loadSeq = 0;

async function listing(dir) {
  return invoke("tree_entries", { path: props.path, id: props.commit.id, dir });
}

// Reloads everything for the current commit, keeping open folders and the chosen
// file where they still exist, so stepping through history keeps your place.
async function load() {
  const seq = ++loadSeq;
  error.value = "";
  const dirs = ["", ...expanded];
  const results = await Promise.allSettled(dirs.map(listing));
  if (seq !== loadSeq) return;

  listings.clear();
  results.forEach((result, i) => {
    if (result.status === "fulfilled") listings.set(dirs[i], result.value);
    else if (dirs[i] === "") error.value = String(result.reason);
    else expanded.delete(dirs[i]);
  });

  if (props.reveal) await revealFile(props.reveal);
  else if (selected.value) await openFile(selected.value);
}

watch(() => [props.path, props.commit.id], load, { immediate: true });
watch(() => props.reveal, (file) => file && revealFile(file));

async function toggle(dir) {
  if (expanded.has(dir)) {
    expanded.delete(dir);
    return;
  }
  expanded.add(dir);
  if (!listings.has(dir)) {
    try {
      listings.set(dir, await listing(dir));
    } catch {
      expanded.delete(dir);
    }
  }
}

// Opens every folder on the way to `file`, then the file itself.
async function revealFile(file) {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    if (!expanded.has(dir)) await toggle(dir);
  }
  await openFile(file);
}

async function openFile(file) {
  selected.value = file;
  const seq = loadSeq;
  try {
    const result = await invoke("file_contents", { path: props.path, id: props.commit.id, file });
    if (seq === loadSeq && selected.value === file) contents.value = { file, ...result };
  } catch {
    // Not in this commit.
    if (seq === loadSeq && selected.value === file) contents.value = { file, missing: true };
  }
}

const rows = computed(() => {
  const result = [];
  const add = (dir, depth) => {
    for (const entry of listings.get(dir) ?? []) {
      result.push({ ...entry, depth });
      if (entry.kind === "dir" && expanded.has(entry.path)) add(entry.path, depth + 1);
    }
  };
  add("", 0);
  return result;
});

const ICONS = { file: File, link: FileSymlink, submodule: FolderGit2 };

function activate(row) {
  if (row.kind === "dir") toggle(row.path);
  else if (row.kind !== "submodule") openFile(row.path);
}

const lines = computed(() => {
  const text = contents.value?.text;
  if (text == null) return null;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return { text: body, numbers: Array.from({ length: body.split("\n").length }, (_, i) => i + 1).join("\n") };
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="tree-view">
    <div class="tree-list">
      <p v-if="error" class="message"><CircleAlert :size="15" /> {{ error }}</p>
      <div
        v-for="row in rows"
        :key="row.path"
        class="tree-row"
        :class="{ selected: row.path === selected, muted: row.kind === 'submodule' }"
        :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
        :title="row.kind === 'submodule' ? 'A submodule: a separate repository' : row.path"
        @click="activate(row)"
      >
        <ChevronRight v-if="row.kind === 'dir'" :size="14" class="chevron" :class="{ open: expanded.has(row.path) }" />
        <span v-else class="chevron" />
        <component
          :is="row.kind === 'dir' ? (expanded.has(row.path) ? FolderOpen : Folder) : ICONS[row.kind]"
          :size="16"
          :stroke-width="1.5"
          class="row-icon"
          :class="{ folder: row.kind === 'dir' }"
        />
        <span class="name">{{ row.name }}</span>
      </div>
    </div>

    <div class="viewer">
      <template v-if="contents">
        <div class="viewer-header">
          <span class="file-path">{{ contents.file }}</span>
          <span v-if="!contents.missing" class="dim">{{ formatSize(contents.size) }}</span>
        </div>
        <p v-if="contents.missing" class="message">This file doesn't exist in this commit.</p>
        <p v-else-if="contents.binary" class="message">Binary file, not shown.</p>
        <p v-else-if="contents.too_large" class="message">This file is too large to show.</p>
        <div v-else class="source selectable mono">
          <pre class="numbers">{{ lines.numbers }}</pre>
          <pre class="text">{{ lines.text }}</pre>
        </div>
      </template>
      <div v-else class="empty-state">
        <p>Select a file to see its contents at this commit.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tree-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tree-list {
  flex: 0 0 40%;
  min-height: 120px;
  overflow-y: auto;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding-right: 10px;
  white-space: nowrap;
}

.tree-row:hover {
  background: var(--row-hover);
}

.tree-row.selected {
  background: var(--row-selected);
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

.row-icon {
  flex-shrink: 0;
  color: var(--icon);
}

.row-icon.folder {
  color: var(--accent);
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.viewer {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.viewer-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}

.file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.source {
  flex: 1;
  display: flex;
  overflow: auto;
  font-size: 12px;
  line-height: 18px;
}

pre {
  margin: 0;
  padding: 6px 0;
  font: inherit;
  tab-size: var(--tab-size);
}

.numbers {
  position: sticky;
  left: 0;
  min-width: 44px;
  padding-right: 8px;
  padding-left: 8px;
  text-align: right;
  color: var(--text-tertiary);
  background: var(--diff-gutter-bg);
  -webkit-user-select: none;
  user-select: none;
}

.text {
  flex: 1;
  padding-left: 10px;
  padding-right: 16px;
}

.message {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 16px;
  color: var(--text-tertiary);
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}
</style>
