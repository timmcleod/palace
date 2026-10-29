<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { File, GitCommitHorizontal, ListFilter, Search } from "lucide-vue-next";
import { shortcut } from "../lib/platform.js";

// The toolbar's search: files by name or path, and commits in the history being shown
// by message, author or hash. Picking a file shows its history, picking a commit shows
// the commit, and the last row narrows the history to every matching commit.
const props = defineProps({
  path: { type: String, required: true },
  // The history to search for commits; HEAD when null.
  rev: { type: String, default: null },
  refreshKey: { type: Number, default: 0 },
});
const emit = defineEmits(["pick", "pick-commit", "filter-commits"]);

const MAX_FILES = 8;
const MAX_COMMITS = 8;

const query = ref("");
const open = ref(false);
const active = ref(0);
const input = ref(null);
const list = ref(null);
// The toolbar clips what overflows it, so the results float over the page instead,
// lined up under the field.
const position = ref({});

// Tracked files, loaded when the search is first used and after anything changes.
let files = null;
const loaded = ref(0);
watch(
  () => [props.path, props.refreshKey],
  () => {
    files = null;
    loaded.value++;
    commitSearch.value = null;
    if (open.value) searchCommits();
    // Mid-search, load the new list straight away rather than on the next focus.
    if (open.value) ensureFiles();
  },
);

async function ensureFiles() {
  if (files) return;
  try {
    files = await invoke("tracked_files", { path: props.path });
  } catch {
    files = [];
  }
  loaded.value++;
}

// Matches in the file name rank above matches elsewhere in the path, which rank above
// letters that merely appear in order ("uvue" finds "src/components/User.vue").
const results = computed(() => {
  loaded.value;
  const q = query.value.trim().toLowerCase();
  if (!q || !files) return [];
  const scored = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let score;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (inOrder(lower, q)) score = 3;
    else continue;
    scored.push([score, file]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
  return scored.slice(0, MAX_FILES).map(([, file]) => {
    const slash = file.lastIndexOf("/");
    return { file, name: file.slice(slash + 1), dir: slash > 0 ? file.slice(0, slash) : "" };
  });
});

function inOrder(text, letters) {
  let i = 0;
  for (const char of text) if (char === letters[i] && ++i === letters.length) return true;
  return false;
}

// Commits are searched by the backend once typing pauses: { query, total, commits }.
const commitSearch = ref(null);
let commitTimer;
let commitSeq = 0;

function searchCommits() {
  clearTimeout(commitTimer);
  const q = query.value.trim();
  if (!q) {
    commitSearch.value = null;
    return;
  }
  const seq = ++commitSeq;
  commitTimer = setTimeout(async () => {
    try {
      const found = await invoke("search_commits", { path: props.path, rev: props.rev, query: q, limit: MAX_COMMITS });
      if (seq === commitSeq) commitSearch.value = { query: q, ...found };
    } catch {
      if (seq === commitSeq) commitSearch.value = { query: q, total: 0, commits: [] };
    }
  }, 200);
}

watch(query, searchCommits);
watch(() => props.rev, () => open.value && searchCommits());

// Commit results for what's typed now; older ones linger while the next search runs.
const commitsCurrent = computed(() => commitSearch.value?.query === query.value.trim());

// Everything that can be picked, in order, for the arrow keys.
const items = computed(() => {
  const list = results.value.map((r) => ({ kind: "file", key: `file:${r.file}`, ...r }));
  for (const commit of commitSearch.value?.commits ?? []) list.push({ kind: "commit", key: `commit:${commit.id}`, commit });
  const total = commitSearch.value?.total ?? 0;
  if (total > 1) list.push({ kind: "all", key: "all", total });
  return list;
});
const fileItems = computed(() => items.value.filter((item) => item.kind === "file"));
const commitItems = computed(() => items.value.filter((item) => item.kind !== "file"));

watch(items, () => (active.value = 0));

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });

function place() {
  const rect = input.value.closest(".toolbar-search").getBoundingClientRect();
  position.value = { top: `${rect.bottom + 6}px`, right: `${window.innerWidth - rect.right}px` };
}

async function onFocus() {
  place();
  open.value = true;
  if (!commitsCurrent.value) searchCommits();
  await ensureFiles();
}

// Typing loads the list too, in case focus arrived without a focus event.
function onInput() {
  if (!open.value) place();
  open.value = true;
  ensureFiles();
}

function onKeydown(event) {
  const count = items.value.length;
  if (event.key === "ArrowDown" && count) {
    event.preventDefault();
    active.value = (active.value + 1) % count;
    scrollActive();
  } else if (event.key === "ArrowUp" && count) {
    event.preventDefault();
    active.value = (active.value - 1 + count) % count;
    scrollActive();
  } else if (event.key === "Enter" && count) {
    pick(items.value[active.value]);
  } else if (event.key === "Escape") {
    query.value = "";
    input.value.blur();
  }
}

async function scrollActive() {
  await nextTick();
  list.value?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function pick(item) {
  if (item.kind === "file") emit("pick", item.file);
  else if (item.kind === "commit") emit("pick-commit", item.commit);
  else emit("filter-commits", commitSearch.value.query);
  query.value = "";
  open.value = false;
  input.value.blur();
}

function focus() {
  input.value.focus();
  input.value.select();
}

defineExpose({ focus });
</script>

<template>
  <div class="toolbar-search-box">
    <label class="toolbar-search">
      <Search :size="15" :stroke-width="1.5" />
      <input
        ref="input"
        v-model="query"
        placeholder="Search"
        :title="`Search files and commits (${shortcut('Ctrl+F')})`"
        spellcheck="false"
        @focus="onFocus"
        @blur="open = false"
        @input="onInput"
        @keydown="onKeydown"
      />
    </label>
    <Teleport to="body">
      <div v-if="open && query.trim()" ref="list" class="results" :style="position" @mousedown.prevent>
        <h3>Files</h3>
        <div
          v-for="(item, i) in fileItems"
          :key="item.key"
          class="result"
          :class="{ active: i === active }"
          @mouseenter="active = i"
          @click="pick(item)"
        >
          <File :size="15" :stroke-width="1.5" class="icon" />
          <span class="name">{{ item.name }}</span>
          <span class="dir">{{ item.dir }}</span>
        </div>
        <p v-if="!fileItems.length" class="none">No tracked files match.</p>

        <h3>Commits</h3>
        <div
          v-for="(item, j) in commitItems"
          :key="item.key"
          class="result"
          :class="{ active: fileItems.length + j === active, stale: !commitsCurrent }"
          @mouseenter="active = fileItems.length + j"
          @click="pick(item)"
        >
          <template v-if="item.kind === 'commit'">
            <GitCommitHorizontal :size="15" :stroke-width="1.5" class="icon" />
            <span class="name">{{ item.commit.summary }}</span>
            <span class="dir">{{ item.commit.author_name }} · {{ dateFormat.format(new Date(item.commit.time * 1000)) }}</span>
          </template>
          <template v-else>
            <ListFilter :size="15" :stroke-width="1.5" class="icon" />
            <span class="name">Show all {{ item.total.toLocaleString() }} matching commits</span>
          </template>
        </div>
        <p v-if="!commitItems.length" class="none">{{ commitsCurrent ? "No commits match." : "Searching…" }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.toolbar-search-box {
  position: relative;
  width: 220px;
  min-width: 120px;
  flex-shrink: 1;
}

.results {
  position: fixed;
  z-index: 15;
  width: 480px;
  max-width: calc(100vw - 40px);
  max-height: min(520px, calc(100vh - 80px));
  overflow-x: hidden;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--content-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.result {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 5px;
  white-space: nowrap;
}

.result.active {
  background: var(--accent);
  color: white;
}

.icon {
  flex-shrink: 0;
  align-self: center;
  color: var(--icon);
}

.result.stale {
  opacity: 0.6;
}

h3 {
  margin: 6px 8px 3px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

h3:not(:first-child) {
  margin-top: 10px;
}

.result.active .icon,
.result.active .dir {
  color: inherit;
  opacity: 0.85;
}

.name,
.dir {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The file name gives way only once the folder has been squeezed out. */
.name {
  flex-shrink: 1;
  min-width: 0;
}

.dir {
  flex-shrink: 100;
  min-width: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.none {
  margin: 4px 8px 6px;
  color: var(--text-tertiary);
}
</style>
