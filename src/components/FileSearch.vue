<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { File, Search } from "lucide-vue-next";

// The toolbar's file search: type part of a file's name or path and pick a match.
const props = defineProps({
  path: { type: String, required: true },
  refreshKey: { type: Number, default: 0 },
});
const emit = defineEmits(["pick"]);

const MAX_RESULTS = 50;

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
  return scored.slice(0, MAX_RESULTS).map(([, file]) => {
    const slash = file.lastIndexOf("/");
    return { file, name: file.slice(slash + 1), dir: slash > 0 ? file.slice(0, slash) : "" };
  });
});

function inOrder(text, letters) {
  let i = 0;
  for (const char of text) if (char === letters[i] && ++i === letters.length) return true;
  return false;
}

watch(results, () => (active.value = 0));

function place() {
  const rect = input.value.closest(".toolbar-search").getBoundingClientRect();
  position.value = { top: `${rect.bottom + 6}px`, right: `${window.innerWidth - rect.right}px` };
}

async function onFocus() {
  place();
  open.value = true;
  await ensureFiles();
}

// Typing loads the list too, in case focus arrived without a focus event.
function onInput() {
  if (!open.value) place();
  open.value = true;
  ensureFiles();
}

function onKeydown(event) {
  const count = results.value.length;
  if (event.key === "ArrowDown" && count) {
    event.preventDefault();
    active.value = (active.value + 1) % count;
    scrollActive();
  } else if (event.key === "ArrowUp" && count) {
    event.preventDefault();
    active.value = (active.value - 1 + count) % count;
    scrollActive();
  } else if (event.key === "Enter" && count) {
    pick(results.value[active.value]);
  } else if (event.key === "Escape") {
    query.value = "";
    input.value.blur();
  }
}

async function scrollActive() {
  await nextTick();
  list.value?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function pick(result) {
  emit("pick", result.file);
  query.value = "";
  open.value = false;
  input.value.blur();
}
</script>

<template>
  <div class="file-search">
    <label class="toolbar-search">
      <Search :size="15" :stroke-width="1.5" />
      <input
        ref="input"
        v-model="query"
        placeholder="Search for File"
        spellcheck="false"
        @focus="onFocus"
        @blur="open = false"
        @input="onInput"
        @keydown="onKeydown"
      />
    </label>
    <Teleport to="body">
      <div v-if="open && query.trim()" ref="list" class="results" :style="position" @mousedown.prevent>
        <div
          v-for="(result, i) in results"
          :key="result.file"
          class="result"
          :class="{ active: i === active }"
          @mouseenter="active = i"
          @click="pick(result)"
        >
          <File :size="15" :stroke-width="1.5" class="file-icon" />
          <span class="name">{{ result.name }}</span>
          <span class="dir">{{ result.dir }}</span>
        </div>
        <p v-if="!results.length" class="none">No tracked files match “{{ query.trim() }}”.</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.file-search {
  position: relative;
  width: 220px;
  min-width: 120px;
  flex-shrink: 1;
}

.results {
  position: fixed;
  z-index: 15;
  width: 420px;
  max-width: calc(100vw - 40px);
  max-height: 360px;
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

.file-icon {
  flex-shrink: 0;
  align-self: center;
  color: var(--icon);
}

.result.active .file-icon,
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
  margin: 8px;
  color: var(--text-tertiary);
}
</style>
