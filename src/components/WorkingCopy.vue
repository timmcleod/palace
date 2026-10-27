<script setup>
import { computed, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, Undo2, X } from "lucide-vue-next";
import { ask } from "@tauri-apps/plugin-dialog";
import { confirmDiscard } from "../lib/confirm.js";

// The list of changed files with staging checkboxes, and the commit form below it.
const props = defineProps({
  path: { type: String, required: true },
  refreshKey: { type: Number, default: 0 },
  selectedPath: { type: String, default: null },
  // The commit being written: { subject, body, amend, saved }. Owned by the parent so
  // it survives switching views; this component edits its fields.
  draft: { type: Object, required: true },
});
const emit = defineEmits(["select", "changed"]);

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

async function discard(list) {
  const ok =
    list.length === 1
      ? await confirmDiscard(
          `Discard all changes to “${list[0].path.split("/").at(-1)}”?`,
          "Its staged and unstaged changes will be thrown away. The current version of the file will be moved to the Trash.",
        )
      : await confirmDiscard(
          `Discard changes to ${list.length} files?`,
          "All their staged and unstaged changes will be thrown away. The current versions of the files will be moved to the Trash.",
        );
  if (ok) run("discard_files", { files: list.map((f) => f.path) });
}

// --- Amend -----------------------------------------------------------------------

// The commit being amended: { message, pushed }.
const head = shallowRef(null);

async function toggleAmend(on) {
  commitError.value = "";
  if (!on) {
    // Put back whatever was being written before amending.
    Object.assign(props.draft, props.draft.saved ?? { subject: "", body: "" }, { amend: false, saved: null });
    return;
  }

  try {
    head.value = await invoke("head_commit", { path: props.path });
  } catch (e) {
    commitError.value = String(e);
    return;
  }
  if (!head.value) {
    commitError.value = "There's no commit to amend yet.";
    return;
  }
  const [subject, ...rest] = head.value.message.split("\n");
  props.draft.saved = { subject: props.draft.subject, body: props.draft.body };
  Object.assign(props.draft, { subject, body: rest.join("\n").trim(), amend: true });
}

// Reopening the view while amending needs the pushed warning again.
watch(
  () => props.draft.amend,
  async (amend) => {
    if (amend && !head.value) head.value = await invoke("head_commit", { path: props.path }).catch(() => null);
  },
  { immediate: true },
);

// --- Commit ----------------------------------------------------------------------

const canCommit = computed(
  () =>
    (stagedFiles.value.length > 0 || props.draft.amend) &&
    props.draft.subject.trim() !== "" &&
    !committing.value &&
    !busy.value,
);

async function commit() {
  if (!canCommit.value) return;
  if (props.draft.amend && head.value?.pushed) {
    const ok = await ask(
      "This commit has already been pushed. After amending it, your branch and its upstream will have diverged, and you'll need to force push to publish the change.",
      { title: "Amend a Pushed Commit?", kind: "warning", okLabel: "Amend", cancelLabel: "Cancel" },
    );
    if (!ok) return;
  }

  committing.value = true;
  commitError.value = "";
  const message = [props.draft.subject.trim(), props.draft.body.trim()].filter(Boolean).join("\n\n");
  try {
    await invoke("commit_changes", { path: props.path, message, amend: props.draft.amend });
    Object.assign(props.draft, { subject: "", body: "", amend: false, saved: null });
    head.value = null;
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
        <button class="link-button danger" :disabled="busy" @click="discard(files)">Discard All…</button>
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
        <button
          class="icon-button small discard"
          title="Discard Changes…"
          :disabled="busy"
          @click.stop="discard([file])"
        >
          <Undo2 :size="14" />
        </button>
      </div>
    </div>

    <form class="composer" @submit.prevent="commit">
      <p v-if="commitError" class="commit-error">{{ commitError }}</p>
      <p v-if="draft.amend && head?.pushed" class="amend-warning">
        This commit has already been pushed. Amending it will mean force pushing.
      </p>
      <div class="subject-row">
        <input
          v-model="draft.subject"
          class="subject"
          placeholder="Commit subject"
          spellcheck="true"
          @keydown.ctrl.enter.prevent="commit"
        />
        <span
          class="counter"
          :class="{ long: draft.subject.length > 72 }"
          title="Keep subjects under about 72 characters"
        >
          {{ draft.subject.length }}
        </span>
      </div>
      <textarea
        v-model="draft.body"
        placeholder="Description (optional)"
        rows="4"
        spellcheck="true"
        @keydown.ctrl.enter.prevent="commit"
      />
      <div class="composer-actions">
        <label class="amend">
          <input
            type="checkbox"
            :checked="draft.amend"
            :disabled="committing"
            @change="toggleAmend($event.target.checked)"
          />
          Amend last commit
        </label>
        <span class="hint">Ctrl+Enter</span>
        <button type="submit" class="primary-button" :disabled="!canCommit">
          <template v-if="committing">{{ draft.amend ? "Amending…" : "Committing…" }}</template>
          <template v-else-if="draft.amend">Amend Last Commit</template>
          <template v-else>Commit {{ plural(stagedFiles.length, "file") }}</template>
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

.link-button.danger:not(:disabled) {
  color: var(--danger);
}

.banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin: 0 12px 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--error-bg);
  color: var(--danger);
  font-size: 12.5px;
  white-space: pre-wrap;
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

.discard {
  flex-shrink: 0;
  visibility: hidden;
}

.file:hover .discard {
  visibility: visible;
}

.discard:hover:not(:disabled) {
  color: var(--danger);
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
  background: var(--error-bg);
  color: var(--danger);
  font-size: 12.5px;
  white-space: pre-wrap;
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

.amend {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  font-size: 13px;
  color: var(--text-secondary);
}

.amend-warning {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--toolbar-group-bg);
  color: var(--ref-tag);
  font-size: 12.5px;
}

.hint {
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>
