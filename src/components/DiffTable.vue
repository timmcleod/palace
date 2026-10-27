<script setup>
// Renders one file's diff. Loading it is up to the parent.
defineProps({
  diff: { type: Object, required: true },
  // Buttons shown on each hunk, as [{ id, label, danger }].
  hunkActions: { type: Array, default: () => [] },
  // Disables the hunk buttons while an action is running.
  busy: { type: Boolean, default: false },
  loadingAll: { type: Boolean, default: false },
});
const emit = defineEmits(["hunk", "show-all"]);

const LINE_CLASS = { "+": "added", "-": "removed", "\\": "marker" };
</script>

<template>
  <div class="diff-table">
    <p v-if="diff.binary" class="notice">Binary file not shown.</p>
    <p v-else-if="diff.truncated" class="notice">
      This diff is large ({{ diff.total_lines.toLocaleString() }} lines).
      <button class="link-button" :disabled="loadingAll" @click="emit('show-all')">
        {{ loadingAll ? "Loading…" : "Show Diff" }}
      </button>
    </p>
    <p v-else-if="!diff.hunks.length" class="notice">No content changes.</p>

    <div v-else class="scroller">
      <table class="mono">
        <tbody v-for="(hunk, h) in diff.hunks" :key="h">
          <tr class="hunk-header">
            <td class="gutter" />
            <td class="gutter" />
            <td class="text">
              <div class="hunk-bar">
                <span>{{ hunk.header }}</span>
                <span v-if="hunkActions.length" class="hunk-actions">
                  <button
                    v-for="action in hunkActions"
                    :key="action.id"
                    class="hunk-action"
                    :class="{ danger: action.danger }"
                    :disabled="busy"
                    @click="emit('hunk', { action: action.id, index: h })"
                  >
                    {{ action.label }}
                  </button>
                </span>
              </div>
            </td>
          </tr>
          <tr v-for="(line, l) in hunk.lines" :key="l" :class="LINE_CLASS[line.kind]">
            <td class="gutter">{{ line.old ?? "" }}</td>
            <td class="gutter">{{ line.new ?? "" }}</td>
            <td class="text">{{ line.text }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.diff-table {
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.notice {
  margin: 0;
  padding: 10px 12px;
  color: var(--text-tertiary);
}

.link-button {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}

.scroller {
  overflow-x: auto;
}

table {
  min-width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  line-height: 18px;
}

td {
  padding: 0;
  vertical-align: top;
}

.gutter {
  min-width: 40px;
  padding: 0 8px;
  text-align: right;
  color: var(--text-tertiary);
  background: var(--diff-gutter-bg);
  user-select: none;
}

.text {
  width: 100%;
  padding: 0 10px;
  white-space: pre;
  tab-size: 4;
  user-select: text;
}

.hunk-header td {
  padding-top: 3px;
  padding-bottom: 3px;
  background: var(--diff-hunk-bg);
  color: var(--text-tertiary);
}

.hunk-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* Stays in view at the right edge even when long lines scroll the table sideways. */
.hunk-actions {
  position: sticky;
  right: 8px;
  display: flex;
  gap: 6px;
}

.hunk-action {
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--content-bg);
  font: inherit;
  font-family: system-ui, "Ubuntu", sans-serif;
  color: var(--text-primary);
  user-select: none;
  cursor: pointer;
}

.hunk-action:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.hunk-action.danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.hunk-action:disabled {
  opacity: 0.5;
}

.added .text {
  background: var(--diff-added-bg);
}

.added .gutter {
  background: var(--diff-added-gutter);
}

.removed .text {
  background: var(--diff-removed-bg);
}

.removed .gutter {
  background: var(--diff-removed-gutter);
}

.marker .text {
  color: var(--text-tertiary);
  font-style: italic;
}
</style>
