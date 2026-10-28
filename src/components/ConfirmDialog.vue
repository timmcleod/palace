<script setup>
import { computed, nextTick, onMounted, ref } from "vue";
import { closeConfirm } from "../lib/overlays.js";

// Asks before doing something, in the same style as Palace's other dialogs.
const props = defineProps({
  // { title, message, confirmLabel, danger }
  dialog: { type: Object, required: true },
});

// Blank lines in the message separate paragraphs: the question, then what it means.
const paragraphs = computed(() => props.dialog.message.split(/\n\s*\n/));

const cancelButton = ref(null);
const confirmButton = ref(null);
// For something that can't be undone, Enter cancels rather than going ahead.
onMounted(async () => {
  await nextTick();
  (props.dialog.danger && cancelButton.value ? cancelButton : confirmButton).value?.focus();
});

function onKeydown(event) {
  if (event.key === "Escape") closeConfirm(false);
}
</script>

<template>
  <div class="backdrop" @mousedown.self="closeConfirm(false)" @keydown="onKeydown">
    <form class="dialog" role="alertdialog" @submit.prevent="closeConfirm(true)">
      <header>
        <img src="/palace.svg" alt="" class="app-icon" />
        <div>
          <h2>{{ dialog.title }}</h2>
          <p v-for="(paragraph, i) in paragraphs" :key="i">{{ paragraph }}</p>
        </div>
      </header>

      <div class="buttons">
        <button v-if="dialog.cancel !== false" ref="cancelButton" type="button" class="secondary-button" @click="closeConfirm(false)">
          Cancel
        </button>
        <button ref="confirmButton" type="submit" class="primary-button" :class="{ danger: dialog.danger }">
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
  z-index: 30;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
  background: rgba(0, 0, 0, 0.25);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 22px;
  width: min(480px, calc(100vw - 32px));
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

p {
  margin: 0 0 8px;
  color: var(--text-secondary);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

p:first-of-type {
  color: var(--text-primary);
}

p:last-child {
  margin-bottom: 0;
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.buttons button {
  min-width: 110px;
}

.danger {
  background: var(--danger);
}
</style>
