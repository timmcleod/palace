<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { slideOpen } from "../lib/slide.js";
import DiffTable from "./DiffTable.vue";

// One file's diff within a commit, or within a comparison of two revisions.
const props = defineProps({
  path: { type: String, required: true },
  commitId: { type: String, default: null },
  // { base, head }, in place of a commit.
  comparison: { type: Object, default: null },
  index: { type: Number, required: true },
  // The file's path in the repository.
  file: { type: String, default: null },
  // Opened by a click on it: it slides open once its diff has come, rather than showing
  // "Loading…" first and then the diff in its place, each moving what's below.
  slide: { type: Boolean, default: false },
});

// "loaded" says the diff has come, as when it shows after "Loading…".
const emit = defineEmits(["loaded"]);

// Bigger diffs wait for an explicit click, so expanding a lockfile doesn't stall the UI.
const MAX_LINES = 3000;

const diff = shallowRef(null);
const error = ref("");
const loading = ref(false);
const root = ref(null);
const scroller = inject("diffScroller", null);

// Which diff this is, for review comments on it (see review.js).
const where = computed(() =>
  props.comparison ? `compare:${props.comparison.base}..${props.comparison.head}` : props.commitId ? `commit:${props.commitId}` : null,
);

// Hidden, at no height, until there's something to slide open to: the diff, why it
// couldn't be read, or, should it take a while, "Loading…", rather than seeming to do
// nothing.
const WAIT_MS = 400;
const shown = ref(!props.slide);
let waiting = props.slide ? setTimeout(reveal, WAIT_MS) : null;
async function reveal() {
  clearTimeout(waiting);
  if (shown.value) return;
  shown.value = true;
  await nextTick();
  // Not an image's: its height isn't known until the picture's loaded, so it would slide
  // open short of it and then jump the rest of the way.
  if (root.value && !diff.value?.images) slideOpen(root.value);
}

async function load(maxLines) {
  loading.value = true;
  try {
    const where = props.comparison
      ? ["compare_file_diff", { base: props.comparison.base, head: props.comparison.head }]
      : ["file_diff", { id: props.commitId }];
    diff.value = await invoke(where[0], { path: props.path, ...where[1], index: props.index, maxLines });
    error.value = "";
    emit("loaded");
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
    reveal();
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
onBeforeUnmount(() => {
  observer?.disconnect();
  clearTimeout(waiting);
});
</script>

<template>
  <div ref="root" class="file-diff" :class="{ waiting: !shown }">
    <div class="inner">
      <DiffTable v-if="diff" :diff="diff" :file="file" :repo="path" :where="where" :loading-all="loading" @show-all="load(null)" />
      <p v-else class="notice" :class="{ error }">{{ error || "Loading…" }}</p>
    </div>
  </div>
</template>

<style scoped>
.file-diff {
  /* Holds the margin below inside it, so it slides open and closed with the rest. */
  display: flow-root;
}

.file-diff.waiting {
  height: 0;
  overflow: hidden;
}

.inner {
  margin: 0 16px 12px;
}

.notice {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
}

.notice.error {
  color: var(--danger);
}
</style>
