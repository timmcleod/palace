<script setup>
import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeftRight, CircleAlert, FileDiff, X } from "lucide-vue-next";
import RevisionInput from "./RevisionInput.vue";

// Above the history while comparing: the two revisions, how far apart they are, and
// a row for all of `head`'s changes at once.
const props = defineProps({
  path: { type: String, required: true },
  // { base, head }
  comparison: { type: Object, required: true },
  // { branches, tags, remoteBranches } for the revision fields.
  choices: { type: Object, required: true },
  // Whether All Changes is what the detail pane shows.
  allSelected: { type: Boolean, default: false },
  refreshKey: { type: Number, default: 0 },
});
const emit = defineEmits(["change", "close", "select-all"]);

const head = ref(props.comparison.head);
const base = ref(props.comparison.base);
const summary = ref(null);
const error = ref("");

watch(
  () => props.comparison,
  (c) => {
    head.value = c.head;
    base.value = c.base;
  },
);

// Typing waits for a pause before comparing.
let timer;
watch([head, base], ([h, b]) => {
  clearTimeout(timer);
  if (h === props.comparison.head && b === props.comparison.base) return;
  timer = setTimeout(() => {
    if (h.trim() && b.trim()) emit("change", { head: h.trim(), base: b.trim() });
  }, 400);
});

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  try {
    const { base, head } = props.comparison;
    const result = await invoke("compare", { path: props.path, base, head });
    if (seq !== loadSeq) return;
    summary.value = result;
    error.value = "";
  } catch (e) {
    if (seq !== loadSeq) return;
    summary.value = null;
    error.value = String(e);
  }
}
watch(() => [props.path, props.comparison, props.refreshKey], load, { immediate: true });

function swap() {
  emit("change", { head: props.comparison.base, base: props.comparison.head });
}

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
</script>

<template>
  <div class="compare-bar">
    <div class="fields">
      <RevisionInput
        v-model="head"
        class="field"
        :branches="choices.branches"
        :tags="choices.tags"
        :remote-branches="choices.remoteBranches"
        title="What to look at"
      />
      <span class="with">with</span>
      <RevisionInput
        v-model="base"
        class="field"
        :branches="choices.branches"
        :tags="choices.tags"
        :remote-branches="choices.remoteBranches"
        title="What to compare it with"
      />
      <button class="icon-button" title="Swap the two sides" @click="swap">
        <ArrowLeftRight :size="16" :stroke-width="1.5" />
      </button>
      <button class="icon-button" title="Stop comparing" @click="emit('close')">
        <X :size="16" :stroke-width="1.5" />
      </button>
    </div>

    <p v-if="error" class="error">
      <CircleAlert :size="14" :stroke-width="1.75" />
      {{ error }}
    </p>
    <template v-else-if="summary">
      <p class="counts">
        <strong>{{ plural(summary.ahead, "commit") }}</strong> on “{{ comparison.head }}” that “{{ comparison.base }}”
        doesn't have.
        <template v-if="summary.behind">
          “{{ comparison.base }}” has {{ plural(summary.behind, "commit") }} that “{{ comparison.head }}” doesn't.
        </template>
      </p>
      <button class="all-changes" :class="{ selected: allSelected }" @click="emit('select-all')">
        <FileDiff :size="16" :stroke-width="1.5" />
        <span class="label">All Changes</span>
        <span class="detail">
          {{ plural(summary.files.length, "file") }}
          <span v-if="summary.additions" class="plus">+{{ summary.additions.toLocaleString() }}</span>
          <span v-if="summary.deletions" class="minus">−{{ summary.deletions.toLocaleString() }}</span>
        </span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.compare-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.fields {
  display: flex;
  align-items: center;
  gap: 4px;
}

.field {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

.field :deep(input) {
  padding-top: 5px;
  padding-bottom: 5px;
}

.with {
  padding: 0 2px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.counts,
.error {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.counts strong {
  font-weight: 600;
  color: var(--text-primary);
}

.error {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--danger);
}

.all-changes {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: var(--toolbar-group-bg);
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--text-primary);
  cursor: default;
}

.all-changes:hover {
  background: var(--row-hover);
}

.all-changes.selected {
  background: var(--row-selected);
}

.all-changes > svg {
  color: var(--icon);
}

.label {
  font-weight: 600;
}

.detail {
  display: flex;
  gap: 6px;
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 12px;
}

.plus {
  color: var(--diff-added-text);
}

.minus {
  color: var(--diff-removed-text);
}
</style>
