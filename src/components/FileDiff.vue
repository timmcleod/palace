<script setup>
import { inject, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import DiffTable from "./DiffTable.vue";

// One file's diff within a commit, or within a comparison of two revisions.
const props = defineProps({
  path: { type: String, required: true },
  commitId: { type: String, default: null },
  // { base, head }, in place of a commit.
  comparison: { type: Object, default: null },
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
    const where = props.comparison
      ? ["compare_file_diff", { base: props.comparison.base, head: props.comparison.head }]
      : ["file_diff", { id: props.commitId }];
    diff.value = await invoke(where[0], { path: props.path, ...where[1], index: props.index, maxLines });
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
</script>

<template>
  <div ref="root" class="file-diff">
    <DiffTable v-if="diff" :diff="diff" :loading-all="loading" @show-all="load(null)" />
    <p v-else class="notice" :class="{ error }">{{ error || "Loading…" }}</p>
  </div>
</template>

<style scoped>
.file-diff {
  margin: 0 16px 12px;
}

.notice {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-tertiary);
}

.notice.error {
  color: var(--danger);
}
</style>
