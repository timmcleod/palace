<script setup>
import { ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { confirmDiscard } from "../lib/confirm.js";
import DiffTable from "./DiffTable.vue";

// The staged and unstaged changes of one working-copy file, with hunk staging.
const props = defineProps({
  path: { type: String, required: true },
  file: { type: Object, required: true },
  // undoable(step, work): runs `work`, remembering how to undo it.
  undoable: { type: Function, default: (step, work) => work() },
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

async function run(command, args, step) {
  busy.value = true;
  error.value = "";
  try {
    const work = () => invoke(command, { path: props.path, ...args });
    await (step ? props.undoable(step, work) : work());
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
    emit("changed");
  }
}

// `lines`, when set, narrows the action to those lines of the hunk.
async function onHunk(staged, { action, index, lines }) {
  if (action === "discard") {
    const what = !lines ? "this chunk" : lines.length === 1 ? "this line" : "these lines";
    const ok = await confirmDiscard(`Discard ${what}?`);
    if (ok) run("discard_hunk", { file: props.file.path, hunk: index, lines }, discardStep());
  } else {
    run("stage_hunk", { file: props.file.path, oldPath: props.file.old_path, staged, hunk: index, lines });
  }
}

async function discardFile() {
  const name = props.file.path.split("/").at(-1);
  const ok = await confirmDiscard(
    `Discard all changes to “${name}”?`,
    "Its staged and unstaged changes will be thrown away.",
  );
  if (ok) run("discard_files", { files: [props.file.path] }, discardStep());
}

// Discarding can be undone, with copies of the file as it was.
const discardStep = () => ({ label: "Discard", mode: "keep", cover: { files: [props.file.path, props.file.old_path].filter(Boolean) } });

function stageFile() {
  run("stage_files", { files: [props.file.path] });
}

function unstageFile() {
  run("unstage_files", { files: [props.file.path, props.file.old_path].filter(Boolean) });
}

const SECTIONS = [
  {
    staged: false,
    title: "Unstaged Changes",
    hunkActions: [
      { id: "discard", label: "Discard Chunk", verb: "Discard", danger: true },
      { id: "stage", label: "Stage Chunk", verb: "Stage" },
    ],
    fileAction: "Stage File",
  },
  {
    staged: true,
    title: "Staged Changes",
    hunkActions: [{ id: "unstage", label: "Unstage Chunk", verb: "Unstage" }],
    fileAction: "Unstage File",
  },
];
</script>

<template>
  <div class="working-diff selectable">
    <p v-if="file.conflicted" class="note">
      This file has merge conflicts. Resolve them in your editor, then stage the file to mark it resolved.
    </p>
    <p v-if="error" class="note error">{{ error }}</p>

    <div class="file-actions">
      <button class="link-button danger" :disabled="busy" @click="discardFile">Discard All Changes…</button>
    </div>

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
          :file="file.path"
          :hunk-actions="section.hunkActions"
          :busy="busy"
          :loading-all="loadingAll === section.staged"
          @hunk="onHunk(section.staged, $event)"
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
}

.note.error {
  background: var(--error-bg);
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

.link-button.danger:not(:disabled) {
  color: var(--danger);
}

.file-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
