<script>
import { ref } from "vue";

// Whether blame is showing. It outlives the view, which closes while a commit's
// changes are shown, so it's still on when you come back.
const showBlame = ref(false);
</script>

<script setup>
import { computed, reactive, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, CircleAlert, File, FileSymlink, Folder, FolderGit2, FolderOpen, UserRoundSearch } from "lucide-vue-next";

// Every file as it was at a commit: a folder tree on top, the chosen file below.
const props = defineProps({
  path: { type: String, required: true },
  commit: { type: Object, required: true },
  // A file to reveal and open, such as the one being searched for.
  reveal: { type: String, default: null },
});
// "file-opened" keeps the window told which file is open, so going Back can reopen
// it; "show-commit" asks to show a commit from the blame.
const emit = defineEmits(["file-opened", "show-commit"]);

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
  emit("file-opened", file);
  const seq = loadSeq;
  try {
    const result = await invoke("file_contents", { path: props.path, id: props.commit.id, file });
    if (seq === loadSeq && selected.value === file) contents.value = { file, ...result };
  } catch {
    // Not in this commit.
    if (seq === loadSeq && selected.value === file) contents.value = { file, missing: true };
  }
}

// --- Blame -----------------------------------------------------------------------
// Beside the file, who last changed each run of lines. It stays on while moving
// between files and commits.

const LINE_HEIGHT = 18;
const blame = shallowRef(null);
const blameError = ref("");
let blameSeq = 0;

async function loadBlame() {
  const seq = ++blameSeq;
  blame.value = null;
  blameError.value = "";
  const file = contents.value?.file;
  if (!showBlame.value || !file || contents.value.text == null) return;
  try {
    const hunks = await invoke("blame_file", { path: props.path, id: props.commit.id, file });
    if (seq === blameSeq) blame.value = hunks;
  } catch (e) {
    if (seq === blameSeq) blameError.value = String(e);
  }
}

watch([showBlame, contents], loadBlame);

// Newer changes get a stronger mark, so recent work stands out.
const ages = computed(() => {
  const times = [...new Set((blame.value ?? []).map((h) => h.time))].sort((a, b) => a - b);
  return new Map(times.map((t, i) => [t, times.length > 1 ? i / (times.length - 1) : 1]));
});

const blameDate = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });

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
          <button
            v-if="contents.text != null"
            class="blame-toggle"
            :class="{ active: showBlame }"
            title="Show who last changed each line"
            @click="showBlame = !showBlame"
          >
            <UserRoundSearch :size="14" /> Blame
          </button>
        </div>
        <p v-if="showBlame && blameError" class="message"><CircleAlert :size="15" /> {{ blameError }}</p>
        <p v-if="contents.missing" class="message">This file doesn't exist in this commit.</p>
        <p v-else-if="contents.binary" class="message">Binary file, not shown.</p>
        <p v-else-if="contents.too_large" class="message">This file is too large to show.</p>
        <div v-else class="source selectable mono">
          <div v-if="showBlame" class="blame">
            <div
              v-for="hunk in blame ?? []"
              :key="hunk.start"
              class="blame-hunk"
              :style="{ height: `${hunk.lines * LINE_HEIGHT}px`, '--age': ages.get(hunk.time) }"
              :title="`${hunk.summary}\n${hunk.author} <${hunk.email}>, ${new Date(hunk.time * 1000).toLocaleString()}\nClick to see this commit`"
              @click="emit('show-commit', hunk, contents.file)"
            >
              <span class="blame-id">{{ hunk.short_id }}</span>
              <span class="blame-author">{{ hunk.author }}</span>
              <span class="blame-date">{{ blameDate.format(hunk.time * 1000) }}</span>
            </div>
          </div>
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
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}

.viewer-header .dim {
  margin-left: auto;
}

.blame-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-secondary);
}

.blame-toggle.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--text-primary);
}

.blame {
  flex-shrink: 0;
  width: 250px;
  padding: 6px 0;
  border-right: 1px solid var(--border);
  font-family: system-ui, "Ubuntu", sans-serif;
  font-size: 12px;
}

/* A run of lines from one commit. The bar on its left is stronger the newer the
   change. */
.blame-hunk {
  display: flex;
  gap: 6px;
  overflow: hidden;
  box-sizing: border-box;
  padding: 0 8px 0 10px;
  border-left: 3px solid color-mix(in srgb, var(--accent) calc(15% + var(--age, 0) * 85%), transparent);
  box-shadow: inset 0 1px 0 var(--border);
  line-height: 18px;
  white-space: nowrap;
  color: var(--text-secondary);
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
}

.blame-hunk:first-child {
  box-shadow: none;
}

.blame-hunk:hover {
  background: var(--row-hover);
  color: var(--text-primary);
}

.blame-id {
  flex-shrink: 0;
  font-family: ui-monospace, "Ubuntu Mono", monospace;
  color: var(--text-tertiary);
}

.blame-author {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.blame-date {
  flex-shrink: 0;
  color: var(--text-tertiary);
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
