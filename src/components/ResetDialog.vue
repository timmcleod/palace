<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { closeResetDialog } from "../lib/overlays.js";
import RevisionInput from "./RevisionInput.vue";
import { submitOnEnter } from "../lib/dialogKeys.js";

// The Reset dialog: move HEAD, and the branch it's on, to another revision.
const props = defineProps({
  // { path, revision, branch, upstream, branches, tags, remoteBranches }
  dialog: { type: Object, required: true },
});

const revision = ref(props.dialog.revision);
const keepChanges = ref(true);

onMounted(() => document.getElementById("reset-revision")?.select());

// What the reset would do, or why it can't.
const preview = ref(null);
const previewError = ref("");
let previewSeq = 0;
let previewTimer;

watch(
  revision,
  (value) => {
    clearTimeout(previewTimer);
    const seq = ++previewSeq;
    previewTimer = setTimeout(async () => {
      if (!value.trim()) {
        preview.value = null;
        previewError.value = "";
        return;
      }
      try {
        const result = await invoke("reset_preview", { path: props.dialog.path, revision: value });
        if (seq !== previewSeq) return;
        preview.value = result;
        previewError.value = "";
      } catch (e) {
        if (seq !== previewSeq) return;
        preview.value = null;
        previewError.value = String(e);
      }
    }, 200);
  },
  { immediate: true },
);

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const target = computed(() => props.dialog.branch ?? "HEAD");

// Rolling back commits that are already on the remote means force pushing later.
const pushedNote = computed(() => {
  const p = preview.value;
  if (!p?.pushed) return "";
  const which = p.rolled_back === 1 ? "It's" : p.pushed === p.rolled_back ? "They're all" : `${p.pushed} of them are`;
  return `${which} already on ${props.dialog.upstream}, so you'll need to force push afterwards.`;
});

const ready = computed(() => !!preview.value && !previewError.value);

function submit() {
  if (!ready.value) return;
  closeResetDialog({ revision: revision.value.trim(), keepChanges: keepChanges.value });
}

function onKeydown(event) {
  if (event.key === "Escape") closeResetDialog(null);
}
</script>

<template>
  <div class="backdrop" @mousedown.self="closeResetDialog(null)" @keydown="onKeydown">
    <form class="dialog" @keydown="submitOnEnter" @submit.prevent="submit">
      <header>
        <img src="/palace.svg" alt="" class="app-icon" />
        <div>
          <h2>Reset Working Copy to Revision</h2>
          <p>
            Resets your working copy to the selected revision. Currently uncommitted changes in your working copy will
            be preserved.
          </p>
        </div>
      </header>

      <div class="fields">
        <label for="reset-revision">Revision:</label>
        <div>
          <RevisionInput
            id="reset-revision"
            v-model="revision"
            :branches="dialog.branches"
            :tags="dialog.tags"
            :remote-branches="dialog.remoteBranches"
          />
          <p v-if="previewError" class="hint error">{{ previewError }}</p>
          <template v-else-if="preview">
            <p class="hint">
              <span class="mono">{{ preview.short_id }}</span> {{ preview.summary }}
            </p>
            <p v-if="preview.rolled_back" class="hint">
              Takes {{ plural(preview.rolled_back, "commit") }} off {{ target }}.
            </p>
            <p v-if="pushedNote" class="hint warning">{{ pushedNote }}</p>
          </template>
        </div>

        <span />
        <div>
          <label class="checkbox">
            <input v-model="keepChanges" type="checkbox" />
            Keep Changes
          </label>
          <p class="hint indent">
            {{
              keepChanges
                ? "Keeps all changes from rolled back revisions in your working tree."
                : "Discards the changes from rolled back revisions. If that would overwrite an uncommitted change, nothing is reset."
            }}
          </p>
        </div>
      </div>

      <div class="buttons">
        <button type="button" class="secondary-button" @click="closeResetDialog(null)">Cancel</button>
        <button type="submit" class="primary-button" :disabled="!ready">Reset</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
  background: rgba(0, 0, 0, 0.25);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 22px;
  width: min(540px, calc(100vw - 32px));
  padding: 26px 26px 20px;
  border-radius: 14px;
  background: var(--content-bg);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
}

header {
  display: flex;
  gap: 18px;
}

.app-icon {
  width: 64px;
  height: 64px;
  flex-shrink: 0;
}

h2 {
  margin: 4px 0 6px;
  font-size: 16px;
  font-weight: 600;
}

header p {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.45;
}

.fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: start;
  gap: 12px 12px;
}

.fields > label {
  padding-top: 7px;
  text-align: right;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
}

.checkbox input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
}

.hint {
  margin: 5px 2px 0;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.hint.indent {
  margin-left: 24px;
}

.hint.error {
  color: var(--danger);
}

.hint.warning {
  color: var(--text-secondary);
}

.hint.warning::before {
  content: "⚠ ";
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.buttons button {
  min-width: 110px;
}
</style>
