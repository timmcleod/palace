<script setup>
import { computed } from "vue";
import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert, X } from "lucide-vue-next";

// A card in the corner of the window showing a git operation: its live progress while
// running (for network operations), then the outcome.
const props = defineProps({
  // { title, line, state: "running" | "done" | "failed" | "conflict", message, cancellable }
  operation: { type: Object, required: true },
});
const emit = defineEmits(["cancel", "dismiss", "action"]);

// Git's progress lines look like "Receiving objects:  45% (9/20), 1.2 MiB | 3 MiB/s".
const percent = computed(() => {
  const match = props.operation.line?.match(/(\d+)%/);
  return match ? Number(match[1]) : null;
});
</script>

<template>
  <div class="remote-status" :class="operation.state" role="status">
    <div class="heading">
      <LoaderCircle v-if="operation.state === 'running'" :size="16" class="spinning" />
      <CircleCheck v-else-if="operation.state === 'done'" :size="16" class="icon-done" />
      <TriangleAlert v-else-if="operation.state === 'conflict'" :size="16" class="icon-conflict" />
      <CircleAlert v-else :size="16" class="icon-failed" />
      <span class="title">{{ operation.title }}</span>
      <template v-if="operation.state === 'running'">
        <button v-if="operation.cancellable" class="text-button" @click="emit('cancel')">Cancel</button>
      </template>
      <button v-else class="icon-button small" title="Dismiss" @click="emit('dismiss')"><X :size="14" /></button>
    </div>

    <template v-if="operation.state === 'running' && operation.cancellable">
      <div class="bar"><div class="fill" :style="{ width: `${percent ?? 0}%` }" /></div>
      <div class="line">{{ operation.line || "Connecting…" }}</div>
    </template>
    <pre v-else-if="operation.state !== 'running'" class="message">{{ operation.message }}</pre>
    <div v-if="operation.actions?.length && operation.state !== 'running'" class="actions">
      <button v-for="action in operation.actions" :key="action.label" class="secondary-button" @click="emit('action', action)">
        {{ action.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.remote-status {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 10;
  width: min(420px, calc(100vw - 32px));
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--content-bg);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);
}

.heading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title {
  flex: 1;
  font-weight: 600;
}

.icon-done {
  color: var(--lane-4);
}

.icon-failed {
  color: var(--danger);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.actions button {
  padding: 4px 12px;
  font-size: 12.5px;
}

.icon-conflict {
  color: var(--ref-tag);
}

.text-button {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--text-primary);
}

.text-button:hover {
  border-color: var(--danger);
  color: var(--danger);
}

.bar {
  height: 4px;
  margin: 10px 0 6px;
  border-radius: 2px;
  background: var(--pill-bg);
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s ease;
}

.line {
  overflow: hidden;
  font-size: 12px;
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message {
  max-height: 220px;
  margin: 8px 0 0;
  overflow: auto;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

.failed .message {
  font-family: ui-monospace, "Ubuntu Mono", monospace;
  font-size: 12px;
}

.spinning {
  color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
