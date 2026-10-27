<script setup>
import { ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import DiffTable from "./DiffTable.vue";

// The staged and unstaged changes of one working-copy file, with hunk staging.
const props = defineProps({
  path: { type: String, required: true },
  file: { type: Object, required: true },
});
const emit = defineEmits(["changed"]);

const MAX_LINES = 3000;

const diffs = shallowRef({ staged: null, unstaged: null });
const error = ref("");
const busy = ref(false);
const loadingAll = ref(null);

let loadSeq = 0;

function fetchDiff(staged, maxLines) {
  return invoke("working_diff", {
    path: props.path,
    file: props.file.path,
    oldPath: props.file.old_path,
    staged,
    maxLines,
  });
}

async function load() {
  const seq = ++loadSeq;
  try {
    const [staged, unstaged] = await Promise.all([
      props.file.staged ? fetchDiff(true, MAX_LINES) : null,
      props.file.unstaged ? fetchDiff(false, MAX_LINES) : null,
    ]);
    if (seq !== loadSeq) return;
    diffs.value = { staged, unstaged };
    error.value = "";
  } catch (e) {
    if (seq === loadSeq) error.value = String(e);
  }
}

// The status list hands over a new file object whenever it reloads, which is
// exactly when the diffs may have changed.
watch(() => props.file, load, { immediate: true });

async function showAll(staged) {
  loadingAll.value = staged;
  try {
    const full = await fetchDiff(staged, null);
    diffs.value = { ...diffs.value, [staged ? "staged" : "unstaged"]: full };
  } catch (e) {
    error.value = String(e);
  } finally {
    loadingAll.value = null;
  }
}

async function run(command, args) {
  busy.value = true;
  error.value = "";
  try {
    await invoke(command, { path: props.path, ...args });
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
    emit("changed");
  }
}

function toggleHunk(staged, hunk) {
  run("stage_hunk", { file: props.file.path, oldPath: props.file.old_path, staged, hunk });
}

function stageFile() {
  run("stage_files", { files: [props.file.path] });
}

function unstageFile() {
  run("unstage_files", { files: [props.file.path, props.file.old_path].filter(Boolean) });
}

const SECTIONS = [
  { staged: false, title: "Unstaged Changes", hunkAction: "Stage Hunk", fileAction: "Stage File" },
  { staged: true, title: "Staged Changes", hunkAction: "Unstage Hunk", fileAction: "Unstage File" },
];
</script>

<template>
  <div class="working-diff">
    <p v-if="file.conflicted" class="note">
      This file has merge conflicts. Resolve them in your editor, then stage the file to mark it resolved.
    </p>
    <p v-if="error" class="note error">{{ error }}</p>

    <template v-for="section in SECTIONS" :key="section.title">
      <section v-if="diffs[section.staged ? 'staged' : 'unstaged']" class="section">
        <header>
          <h3>{{ section.title }}</h3>
          <button class="link-button" :disabled="busy" @click="section.staged ? unstageFile() : stageFile()">
            {{ section.fileAction }}
          </button>
        </header>
        <DiffTable
          :diff="diffs[section.staged ? 'staged' : 'unstaged']"
          :hunk-action="section.hunkAction"
          :busy="busy"
          :loading-all="loadingAll === section.staged"
          @hunk="toggleHunk(section.staged, $event)"
          @show-all="showAll(section.staged)"
        />
      </section>
    </template>
  </div>
</template>

<style scoped>
.working-diff {
  flex: 1;
  overflow-y: auto;
  padding: 4px 16px 16px;
}

.note {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--toolbar-group-bg);
  color: var(--text-secondary);
  font-size: 12.5px;
  white-space: pre-wrap;
  user-select: text;
}

.note.error {
  background: var(--diff-removed-bg);
  color: var(--danger);
}

.section {
  margin-top: 12px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--accent);
  cursor: pointer;
}

.link-button:disabled {
  color: var(--text-tertiary);
}
</style>
