<script setup>
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { issueError } from "../lib/issues.js";
import { commandKey } from "../lib/platform.js";
import MarkdownEditor from "./MarkdownEditor.vue";

// The New Issue dialog: a title and a Markdown description. It creates the issue
// itself, so a refusal can be shown without losing what was written.
const props = defineProps({
  // { owner, repo }
  repo: { type: Object, required: true },
});
// "close" gives the new issue, or nothing when canceled.
const emit = defineEmits(["close"]);

const title = ref("");
const body = ref("");
const busy = ref(false);
const error = ref("");
const titleField = ref(null);
const editor = ref(null);

const ready = computed(() => title.value.trim() !== "" && !busy.value);

onMounted(() => titleField.value?.focus());

async function create() {
  if (!ready.value) return;
  busy.value = true;
  error.value = "";
  try {
    const issue = await invoke("github_create_issue", {
      owner: props.repo.owner,
      repo: props.repo.repo,
      title: title.value,
      body: body.value,
    });
    emit("close", issue);
  } catch (e) {
    error.value = issueError(e).text;
  } finally {
    busy.value = false;
  }
}

// Enter in the title moves on to the description; Ctrl+Enter (Cmd+Enter on a Mac)
// creates the issue from either.
function onTitleKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (commandKey(event)) create();
  else editor.value?.focus();
}
</script>

<template>
  <div class="backdrop" @mousedown.self="emit('close')" @keydown.esc="emit('close')">
    <div class="dialog" role="dialog" aria-labelledby="new-issue-title">
      <h2 id="new-issue-title">New Issue</h2>
      <p class="dim">On {{ repo.owner }}/{{ repo.repo }}</p>

      <input
        ref="titleField"
        v-model="title"
        class="title"
        placeholder="Title"
        spellcheck="true"
        :disabled="busy"
        @keydown="onTitleKeydown"
      />
      <MarkdownEditor
        ref="editor"
        v-model="body"
        :repo="repo"
        :rows="10"
        placeholder="Describe the issue"
        :disabled="busy"
        @submit="create"
        @cancel="emit('close')"
      />
      <p v-if="error" class="error">{{ error }}</p>

      <div class="buttons">
        <button type="button" class="secondary-button" :disabled="busy" @click="emit('close')">Cancel</button>
        <button type="button" class="primary-button" :disabled="!ready" @click="create">
          {{ busy ? "Creating…" : "Create Issue" }}
        </button>
      </div>
    </div>
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
  padding-top: 8vh;
  background: rgba(0, 0, 0, 0.25);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(680px, calc(100vw - 32px));
  padding: 22px 24px 20px;
  border-radius: 14px;
  background: var(--content-bg);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
}

h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.dim {
  margin: -8px 0 2px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.title {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  font-size: 15px;
  color: var(--text-primary);
}

.title:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}

.error {
  margin: 0;
  color: var(--danger);
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
