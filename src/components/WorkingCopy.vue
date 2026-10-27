<script setup>
import { computed, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, X } from "lucide-vue-next";

// The list of changed files with staging checkboxes, and the commit form below it.
const props = defineProps({
  path: { type: String, required: true },
  refreshKey: { type: Number, default: 0 },
  selectedPath: { type: String, default: null },
  subject: { type: String, default: "" },
  body: { type: String, default: "" },
});
const emit = defineEmits(["select", "changed", "update:subject", "update:body"]);

const files = shallowRef(null);
const error = ref("");
const busy = ref(false);
const committing = ref(false);
const commitError = ref("");

let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  try {
    const result = await invoke("working_status", { path: props.path });
    if (seq !== loadSeq) return;
    files.value = result;
    // Hand the parent the fresh copy of the selected file, or null if it's gone.
    emit("select", result.find((f) => f.path === props.selectedPath) ?? null);
  } catch (e) {
    if (seq === loadSeq) error.value = String(e);
  }
}

watch(() => [props.path, props.refreshKey], load, { immediate: true });

// Runs a git operation, then has the whole window refresh.
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

// Unstaging a rename has to name both paths, or the old path stays staged as deleted.
const pathsOf = (file) => [file.path, file.old_path].filter(Boolean);

const fullyStaged = (file) => file.staged && !file.unstaged;

function toggle(file) {
  if (fullyStaged(file)) {
    run("unstage_files", { files: pathsOf(file) });
  } else {
    run("stage_files", { files: [file.path] });
  }
}

const unstagedFiles = computed(() => files.value?.filter((f) => f.unstaged) ?? []);
const stagedFiles = computed(() => files.value?.filter((f) => f.staged) ?? []);

function stageAll() {
  run("stage_files", { files: unstagedFiles.value.map((f) => f.path) });
}

function unstageAll() {
  run("unstage_files", { files: stagedFiles.value.flatMap(pathsOf) });
}

const canCommit = computed(
  () => stagedFiles.value.length > 0 && props.subject.trim() !== "" && !committing.value && !busy.value,
);

async function commit() {
  if (!canCommit.value) return;
  committing.value = true;
  commitError.value = "";
  const message = [props.subject.trim(), props.body.trim()].filter(Boolean).join("\n\n");
  try {
    await invoke("commit_changes", { path: props.path, message });
    emit("update:subject", "");
    emit("update:body", "");
  } catch (e) {
    commitError.value = String(e);
  } finally {
    committing.value = false;
    emit("changed");
  }
}

const STATUS_LETTER = {
  added: "A",
  untracked: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  conflicted: "!",
};

// What the badge shows: a conflict first, then the unstaged change, then the staged one.
const statusOf = (file) => (file.conflicted ? "conflicted" : (file.unstaged ?? file.staged));

function splitPath(path) {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
</script>

<template>
  <div class="working-copy">
    <div v-if="files?.length" class="list-bar">
      <span>{{ plural(files.length, "changed file") }}</span>
      <span class="bar-actions">
        <button class="link-button" :disabled="busy || !unstagedFiles.length" @click="stageAll">Stage All</button>
        <button class="link-button" :disabled="busy || !stagedFiles.length" @click="unstageAll">Unstage All</button>
      </span>
    </div>

    <p v-if="error" class="banner">
      <span>{{ error }}</span>
      <button class="icon-button small" title="Dismiss" @click="error = ''"><X :size="14" /></button>
    </p>

    <div v-if="files && !files.length" class="clean">
      <CircleCheck :size="32" :stroke-width="1.25" />
      <p>No local changes.</p>
    </div>

    <div v-else class="files">
      <div
        v-for="file in files"
        :key="file.path"
        class="file"
        :class="{ selected: file.path === selectedPath }"
        @click="emit('select', file)"
      >
        <input
          type="checkbox"
          :checked="fullyStaged(file)"
          :indeterminate="!!(file.staged && file.unstaged)"
          :disabled="busy"
          :title="fullyStaged(file) ? 'Unstage' : 'Stage'"
          @click.stop.prevent="toggle(file)"
        />
        <span class="badge" :class="statusOf(file)" :title="statusOf(file)">{{ STATUS_LETTER[statusOf(file)] }}</span>
        <span class="file-path" :title="file.old_path ? `${file.old_path} → ${file.path}` : file.path">
          <span v-if="file.old_path" class="dim">{{ file.old_path }} → </span>
          <span class="dim">{{ splitPath(file.path).dir }}</span>{{ splitPath(file.path).name }}
        </span>
      </div>
    </div>

    <form class="composer" @submit.prevent="commit">
      <p v-if="commitError" class="commit-error">{{ commitError }}</p>
      <div class="subject-row">
        <input
          class="subject"
          placeholder="Commit subject"
          spellcheck="true"
          :value="subject"
          @input="emit('update:subject', $event.target.value)"
          @keydown.ctrl.enter.prevent="commit"
        />
        <span class="counter" :class="{ long: subject.length > 72 }" title="Keep subjects under about 72 characters">
          {{ subject.length }}
        </span>
      </div>
      <textarea
        placeholder="Description (optional)"
        rows="4"
        spellcheck="true"
        :value="body"
        @input="emit('update:body', $event.target.value)"
        @keydown.ctrl.enter.prevent="commit"
      />
      <div class="composer-actions">
        <span class="hint">Ctrl+Enter</span>
        <button type="submit" class="primary-button" :disabled="!canCommit">
          {{ committing ? "Committing…" : `Commit ${plural(stagedFiles.length, "file")}` }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.working-copy {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.list-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.bar-actions {
  display: flex;
  gap: 14px;
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}

.link-button:disabled {
  color: var(--text-tertiary);
  cursor: default;
}

.banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin: 0 12px 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--diff-removed-bg);
  color: var(--danger);
  font-size: 12.5px;
  white-space: pre-wrap;
  user-select: text;
}

.files {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}

.file {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border-radius: 6px;
  white-space: nowrap;
}

.file:hover {
  background: var(--row-hover);
}

.file.selected {
  background: var(--row-selected);
}

input[type="checkbox"] {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent);
}

.badge {
  flex-shrink: 0;
  width: 17px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 700;
  line-height: 17px;
  text-align: center;
  color: white;
  background: var(--status);
}

.modified {
  --status: var(--accent);
}
.added,
.untracked {
  --status: var(--lane-4);
}
.deleted,
.conflicted {
  --status: var(--danger);
}
.renamed {
  --status: var(--lane-2);
}
.typechange {
  --status: var(--text-tertiary);
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clean {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-tertiary);
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.commit-error {
  margin: 0;
  max-height: 120px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--diff-removed-bg);
  color: var(--danger);
  font-size: 12.5px;
  white-space: pre-wrap;
  user-select: text;
}

.subject-row {
  position: relative;
}

.subject,
textarea {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  color: var(--text-primary);
}

.subject {
  padding-right: 42px;
  font-weight: 500;
}

.subject:focus,
textarea:focus {
  border-color: var(--accent);
}

textarea {
  resize: vertical;
  min-height: 60px;
}

.counter {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.counter.long {
  color: var(--ref-tag);
}

.composer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.hint {
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>
