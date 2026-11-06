<script setup>
import { onBeforeUnmount, ref } from "vue";
import { Check } from "lucide-vue-next";

// Text, such as a commit's hash, that a click copies: `value`, which may be more than
// what's shown, as the full hash behind a short one. It says "Copied" for a moment.
// Dragging across it still selects it, as the text around it, and copies nothing.
const props = defineProps({
  value: { type: String, required: true },
  // What it is, for its tooltip: "Copy the commit hash".
  label: { type: String, default: "" },
});

const copied = ref(false);
let timer;

async function copy() {
  // A drag that selected text, rather than a click.
  if (!window.getSelection()?.isCollapsed) return;
  try {
    await navigator.clipboard.writeText(props.value);
  } catch {
    return;
  }
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => (copied.value = false), 1200);
}
onBeforeUnmount(() => clearTimeout(timer));

function onKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  copy();
}
</script>

<template>
  <span
    class="copy-text"
    :class="{ copied }"
    role="button"
    tabindex="0"
    :title="copied ? 'Copied' : label ? `${label} (${value})` : `Copy ${value}`"
    @click="copy"
    @keydown="onKeydown"
    ><slot>{{ value }}</slot
    ><span v-if="copied" class="copied-note" aria-live="polite"><Check :size="11" :stroke-width="2.5" />Copied</span></span
  >
</template>

<style scoped>
.copy-text {
  position: relative;
  margin: -1px -3px;
  padding: 1px 3px;
  border-radius: 4px;
  cursor: pointer;
}

.copy-text:hover {
  background: var(--row-hover);
  color: var(--text-primary);
}

.copy-text:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 0;
}

/* Beside it, over whatever follows, so nothing moves. */
.copied-note {
  position: absolute;
  top: 50%;
  left: calc(100% + 6px);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 4px;
  transform: translateY(-50%);
  background: var(--accent);
  font-family: system-ui, "Ubuntu", "Cantarell", sans-serif;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  color: white;
  pointer-events: none;
  -webkit-user-select: none;
  user-select: none;
}
</style>
