<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { closeTagDialog } from "../lib/overlays.js";
import RevisionInput from "./RevisionInput.vue";

// The Create New Tag dialog: a name, the revision to tag (typed, or picked from the
// repository's branches and tags), an optional message, and whether to push it.
const props = defineProps({
  // { path, revision, branches, remoteBranches, tags, hasRemote }
  dialog: { type: Object, required: true },
});

const name = ref("");
const revision = ref(props.dialog.revision);
const message = ref("");
const push = ref(false);

const nameInput = ref(null);
onMounted(async () => {
  await nextTick();
  nameInput.value?.focus();
});

// --- Revision ------------------------------------------------------------------------

// What the revision points at, or why it can't be tagged.
const target = ref(null);
const targetError = ref("");
let describeSeq = 0;
let describeTimer;

watch(
  revision,
  (value) => {
    clearTimeout(describeTimer);
    const seq = ++describeSeq;
    describeTimer = setTimeout(async () => {
      if (!value.trim()) {
        target.value = null;
        targetError.value = "";
        return;
      }
      try {
        const info = await invoke("describe_revision", { path: props.dialog.path, revision: value });
        if (seq !== describeSeq) return;
        target.value = info;
        targetError.value = "";
      } catch (e) {
        if (seq !== describeSeq) return;
        target.value = null;
        targetError.value = String(e);
      }
    }, 200);
  },
  { immediate: true },
);

// --- Submitting ----------------------------------------------------------------------

const nameError = computed(() => {
  const n = name.value.trim();
  if (props.dialog.tags.includes(n)) return `A tag called “${n}” already exists.`;
  if (/\s/.test(n)) return "Tag names can't contain spaces.";
  return "";
});

const ready = computed(() => name.value.trim() && !nameError.value && target.value && !targetError.value);

function submit() {
  if (!ready.value) return;
  closeTagDialog({
    name: name.value.trim(),
    revision: revision.value.trim(),
    message: message.value.trim(),
    push: push.value,
  });
}

function onKeydown(event) {
  if (event.key === "Escape") closeTagDialog(null);
}
</script>

<template>
  <div class="backdrop" @mousedown.self="closeTagDialog(null)" @keydown="onKeydown">
    <form class="dialog" @submit.prevent="submit">
      <header>
        <img src="/palace.svg" alt="" class="app-icon" />
        <div>
          <h2>Create New Tag</h2>
          <p>
            {{
              push
                ? "Creates a tag that points at the entered revision, then pushes it to the remote."
                : "Creates a new local tag that points at the entered revision."
            }}
          </p>
        </div>
      </header>

      <div class="fields">
        <label for="tag-name">Name:</label>
        <div>
          <input id="tag-name" ref="nameInput" v-model="name" type="text" spellcheck="false" placeholder="v1.2.0" />
          <p v-if="nameError" class="hint error">{{ nameError }}</p>
        </div>

        <label for="tag-revision">Revision:</label>
        <div>
          <RevisionInput
            id="tag-revision"
            v-model="revision"
            :branches="dialog.branches"
            :tags="dialog.tags"
            :remote-branches="dialog.remoteBranches"
          />
          <p v-if="targetError" class="hint error">{{ targetError }}</p>
          <p v-else-if="target" class="hint">
            <span class="mono">{{ target.short_id }}</span> {{ target.summary }}
          </p>
        </div>

        <label for="tag-message" class="top">Message:</label>
        <div>
          <textarea id="tag-message" v-model="message" rows="4" placeholder="Optional. With a message, the tag is annotated: it records who made it and when." />
        </div>

        <span v-if="dialog.hasRemote" />
        <label v-if="dialog.hasRemote" class="checkbox">
          <input v-model="push" type="checkbox" />
          Push to origin
        </label>
      </div>

      <div class="buttons">
        <button type="button" class="secondary-button" @click="closeTagDialog(null)">Cancel</button>
        <button type="submit" class="primary-button" :disabled="!ready">Create Tag</button>
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
  gap: 10px 12px;
}

.fields > label:not(.checkbox) {
  padding-top: 7px;
  text-align: right;
}

input[type="text"],
textarea {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  color: var(--text-primary);
}

input[type="text"]:focus,
textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}

textarea {
  resize: vertical;
}

.hint {
  margin: 5px 2px 0;
  overflow: hidden;
  font-size: 12.5px;
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint.error {
  color: var(--danger);
  white-space: normal;
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

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.buttons button {
  min-width: 110px;
}
</style>
