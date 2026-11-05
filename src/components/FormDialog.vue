<script setup>
import { nextTick, onMounted, reactive, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { closeForm } from "../lib/overlays.js";
import { focusDialog, submitOnEnter } from "../lib/dialogKeys.js";
import { draftFor, dropDraft, keepDraft } from "../lib/drafts.js";

const props = defineProps({
  dialog: { type: Object, required: true },
});

const initial = Object.fromEntries(props.dialog.fields.map((f) => [f.key, f.value ?? (f.type === "checkbox" ? false : "")]));
// What was typed the last time this dialog was canceled, if it was.
const values = reactive({ ...initial, ...draftFor(props.dialog.draft) });
const form = ref(null);
const cancelButton = ref(null);

// Whether anything typed would be lost by closing.
const typed = () =>
  props.dialog.fields.some((f) => ["text", "textarea", undefined].includes(f.type) && values[f.key] !== initial[f.key]);

// Canceling keeps what was typed for next time; a click outside, easily a slip,
// doesn't close it then.
function cancel({ outside = false } = {}) {
  if (outside && typed()) return;
  if (typed()) keepDraft(props.dialog.draft, { ...values });
  else dropDraft(props.dialog.draft);
  closeForm(null);
}

// Text fields must be filled in unless marked optional; selects need a choice.
const ready = () =>
  props.dialog.fields.every((f) => f.type === "checkbox" || f.optional || String(values[f.key]).trim() !== "");

// A folder field shows the folder chosen, which only its Choose… changes.
async function chooseFolder(field) {
  const folder = await open({ directory: true, multiple: false, title: field.chooseTitle ?? field.label, defaultPath: values[field.key] || undefined }).catch(() => null);
  if (folder) values[field.key] = folder;
}

function submit() {
  if (!ready()) return;
  dropDraft(props.dialog.draft);
  closeForm({ ...values });
}

onMounted(async () => {
  await nextTick();
  const first = form.value?.querySelector("input:not([type=checkbox]):not([readonly]), select, textarea");
  first?.focus();
  // A one-line value is selected, ready to replace; a message is edited in place.
  if (first?.tagName === "INPUT") first.select();
  // With nothing to type, a dangerous action waits on Cancel, so Enter can't do it.
  if (!first && props.dialog.danger) cancelButton.value?.focus();
  focusDialog(form.value);
});
</script>

<template>
  <div class="backdrop" @mousedown.self="cancel({ outside: true })" @keydown.esc="cancel()">
    <form ref="form" class="dialog" @keydown="submitOnEnter" @submit.prevent="submit">
      <h2>{{ dialog.title }}</h2>
      <p v-if="dialog.message" class="message">{{ dialog.message }}</p>

      <template v-for="field in dialog.fields" :key="field.key">
        <label v-if="field.type === 'checkbox'" class="checkbox">
          <input v-model="values[field.key]" type="checkbox" />
          {{ field.label }}
        </label>
        <label v-else class="field">
          <span>{{ field.label }}</span>
          <select v-if="field.type === 'select'" v-model="values[field.key]">
            <option v-for="option in field.options" :key="option.value ?? option" :value="option.value ?? option">
              {{ option.label ?? option }}
            </option>
          </select>
          <textarea v-else-if="field.type === 'textarea'" v-model="values[field.key]" rows="8" spellcheck="true" />
          <div v-else-if="field.type === 'folder'" class="folder">
            <input :value="values[field.key]" type="text" readonly tabindex="-1" :title="values[field.key]" @click="chooseFolder(field)" />
            <button type="button" class="secondary-button" @click.prevent="chooseFolder(field)">Choose…</button>
          </div>
          <input
            v-else
            v-model="values[field.key]"
            :type="field.type === 'password' ? 'password' : 'text'"
            spellcheck="false"
            autocomplete="off"
            :placeholder="field.placeholder"
          />
          <span v-if="field.hint" class="hint">{{ field.hint }}</span>
        </label>
      </template>

      <div class="buttons">
        <button ref="cancelButton" type="button" class="secondary-button" @click="cancel()">Cancel</button>
        <button type="submit" class="primary-button" :class="{ danger: dialog.danger }" :disabled="!ready()">
          {{ dialog.confirmLabel }}
        </button>
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
  padding-top: 14vh;
  background: rgba(0, 0, 0, 0.25);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(440px, calc(100vw - 32px));
  padding: 18px 20px 16px;
  border-radius: 12px;
  background: var(--content-bg);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.message {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  white-space: pre-wrap;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.field input,
.field textarea,
.field select {
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  font-size: 14px;
  color: var(--text-primary);
}

.folder {
  display: flex;
  gap: 8px;
}

.folder input {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  cursor: default;
}

.folder .secondary-button {
  flex-shrink: 0;
  padding: 6px 12px;
}

.hint {
  font-size: 12px;
  color: var(--text-tertiary);
}

.field input:focus,
.field textarea:focus,
.field select:focus {
  border-color: var(--accent);
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.checkbox input {
  accent-color: var(--accent);
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.danger {
  background: var(--danger);
}

.field textarea {
  font-family: ui-monospace, "Ubuntu Mono", monospace;
  font-size: 13px;
  resize: vertical;
}
</style>
