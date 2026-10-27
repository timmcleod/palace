<script setup>
import { inject, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";

const props = defineProps({
  path: { type: String, required: true },
  commitId: { type: String, required: true },
  index: { type: Number, required: true },
});

// Bigger diffs wait for an explicit click, so expanding a lockfile doesn't stall the UI.
const MAX_LINES = 3000;

const diff = shallowRef(null);
const error = ref("");
const loading = ref(false);
const root = ref(null);
const scroller = inject("diffScroller", null);

async function load(maxLines) {
  loading.value = true;
  try {
    diff.value = await invoke("file_diff", {
      path: props.path,
      id: props.commitId,
      index: props.index,
      maxLines,
    });
    error.value = "";
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

// Load only once the diff scrolls near the viewport, so Expand All on a commit with
// hundreds of files fetches just the ones being looked at.
let observer;
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        load(MAX_LINES);
      }
    },
    // The margin only applies to the root, so the root must be the scrolling pane.
    { root: scroller?.value ?? null, rootMargin: "600px 0px" },
  );
  observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());

const LINE_CLASS = { "+": "added", "-": "removed", "\\": "marker" };
</script>

<template>
  <div ref="root" class="file-diff">
    <p v-if="error" class="notice error">{{ error }}</p>
    <p v-else-if="!diff" class="notice">Loading…</p>
    <p v-else-if="diff.binary" class="notice">Binary file not shown.</p>
    <p v-else-if="diff.truncated" class="notice">
      This diff is large ({{ diff.total_lines.toLocaleString() }} lines).
      <button class="link-button" :disabled="loading" @click="load(null)">
        {{ loading ? "Loading…" : "Show Diff" }}
      </button>
    </p>
    <p v-else-if="!diff.hunks.length" class="notice">No content changes.</p>

    <div v-else class="scroller">
      <table class="mono">
        <tbody v-for="(hunk, h) in diff.hunks" :key="h">
          <tr class="hunk-header">
            <td class="gutter" />
            <td class="gutter" />
            <td class="text">{{ hunk.header }}</td>
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
.file-diff {
  margin: 0 16px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.notice {
  margin: 0;
  padding: 10px 12px;
  color: var(--text-tertiary);
}

.notice.error {
  color: var(--danger);
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
