<script setup>
import { nextTick, onMounted, ref } from "vue";
import { Check, Pencil, Trash2 } from "lucide-vue-next";
import { linesLabel } from "../lib/review.js";
import { isMac } from "../lib/platform.js";

// One review comment under the lines it's on, or the box for writing one. With
// `quote`, it shows the lines too, as for a comment whose lines have changed since.
const props = defineProps({
  // The comment, or null for a new one.
  comment: { type: Object, default: null },
  // The lines a new comment is on.
  lines: { type: Array, default: null },
  quote: { type: Boolean, default: false },
});
const emit = defineEmits(["save", "cancel", "delete"]);

const editing = ref(!props.comment);
const body = ref(props.comment?.body ?? "");
const field = ref(null);

async function edit() {
  body.value = props.comment.body;
  editing.value = true;
  await nextTick();
  field.value?.focus();
}

onMounted(() => editing.value && field.value?.focus());

function save() {
  if (!body.value.trim()) return;
  emit("save", body.value.trim());
  if (props.comment) editing.value = false;
}

function cancel() {
  if (props.comment) editing.value = false;
  else emit("cancel");
}

function onKey(event) {
  if (event.key === "Enter" && (isMac ? event.metaKey : event.ctrlKey)) {
    event.preventDefault();
    save();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }
}

const SIGN = { "+": "+", "-": "−", " ": " " };
</script>

<template>
  <div class="review-comment" :class="{ sent: comment?.sent && !editing }">
    <div v-if="quote && comment" class="quote mono">
      <div v-for="(line, i) in comment.lines.slice(0, 6)" :key="i" :class="line.kind === '+' ? 'added' : line.kind === '-' ? 'removed' : ''">{{
        `${SIGN[line.kind] ?? " "} ${line.text}`
      }}</div>
    </div>
    <template v-if="editing">
      <div class="label">{{ linesLabel(comment?.lines ?? lines) }}</div>
      <textarea
        ref="field"
        v-model="body"
        rows="3"
        placeholder="Discuss this with your agent…"
        spellcheck="true"
        @keydown="onKey"
      />
      <div class="buttons">
        <button class="secondary-button" @click="cancel">Cancel</button>
        <button class="primary-button" :disabled="!body.trim()" @click="save">
          {{ comment ? "Save" : "Add Comment" }} <span class="key">{{ isMac ? "⌘↩" : "Ctrl+Enter" }}</span>
        </button>
      </div>
    </template>
    <template v-else>
      <div class="header">
        <span class="label">{{ linesLabel(comment.lines) }}</span>
        <span v-if="comment.sent" class="sent-mark"><Check :size="12" /> Sent</span>
        <span class="spacer" />
        <button class="icon-button small" title="Edit" @click="edit"><Pencil :size="13" /></button>
        <button class="icon-button small" title="Delete" @click="emit('delete')"><Trash2 :size="13" /></button>
      </div>
      <div class="body">{{ comment.body }}</div>
    </template>
  </div>
</template>

<style scoped>
.review-comment {
  position: sticky;
  left: 0;
  box-sizing: border-box;
  /* Within the room it has, its margins included, so a narrow diff doesn't scroll. */
  width: min(640px, calc(100% - 20px));
  margin: 6px 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  background: var(--content-bg);
  font-family: system-ui, "Ubuntu", sans-serif;
  font-size: 12.5px;
  line-height: 1.45;
  white-space: normal;
  color: var(--text-primary);
}

.review-comment.sent {
  border-left-color: var(--border);
  opacity: 0.65;
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}

.label {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.review-comment > .label {
  margin-bottom: 5px;
}

.sent-mark {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.spacer {
  flex: 1;
}

.body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 60px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--content-bg);
  font: inherit;
  color: var(--text-primary);
  resize: vertical;
}

textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

.buttons button {
  padding: 3px 11px;
  font-size: 12.5px;
}

.key {
  margin-left: 4px;
  opacity: 0.7;
}

.quote {
  margin-bottom: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--diff-gutter-bg);
  font-size: 11.5px;
  white-space: pre;
  overflow: hidden;
  color: var(--text-secondary);
}

.quote .added {
  background: var(--diff-added-bg);
}

.quote .removed {
  background: var(--diff-removed-bg);
}
</style>
