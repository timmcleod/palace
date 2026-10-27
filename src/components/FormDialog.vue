<script setup>
import { nextTick, onMounted, reactive, ref } from "vue";
import { closeForm } from "../lib/overlays.js";

const props = defineProps({
  dialog: { type: Object, required: true },
});

const values = reactive(Object.fromEntries(props.dialog.fields.map((f) => [f.key, f.value ?? (f.type === "checkbox" ? false : "")])));
const form = ref(null);

// Text fields must be filled in unless marked optional; selects need a choice.
const ready = () =>
  props.dialog.fields.every((f) => f.type === "checkbox" || f.optional || String(values[f.key]).trim() !== "");

function submit() {
  if (ready()) closeForm({ ...values });
}

onMounted(async () => {
  await nextTick();
  const first = form.value?.querySelector("input:not([type=checkbox]), select");
  first?.focus();
  first?.select?.();
});
</script>

<template>
  <div class="backdrop" @mousedown.self="closeForm(null)" @keydown.esc="closeForm(null)">
    <form ref="form" class="dialog" @submit.prevent="submit">
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
          <input v-else v-model="values[field.key]" type="text" spellcheck="false" :placeholder="field.placeholder" />
        </label>
      </template>

      <div class="buttons">
        <button type="button" class="secondary-button" @click="closeForm(null)">Cancel</button>
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

.field input:focus,
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
</style>
