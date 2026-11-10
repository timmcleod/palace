<script setup>
import { computed } from "vue";
import { REF_ICONS } from "../lib/refBadges.js";

// A branch or tag spelled out in a pill, with an icon and tint for its kind, as in a commit's
// details, the history's card of a commit's branches and tags, and a stash's branch.
// HEAD, where the commit is checked out, shows as a pill.
const props = defineProps({
  // "head", "local", "remote" or "tag", as history.rs gives them.
  kind: { type: String, required: true },
  name: { type: String, required: true },
  // On one line, a long name cut short, as beside a commit's message in the history,
  // rather than wrapping; what it's in shows it in full (there, the card on hover).
  fit: { type: Boolean, default: false },
  // Without its kind's icon, the tint alone saying which, where pills sit side by side
  // in a row of the history (see Settings › Branch and tag names in the history).
  plain: { type: Boolean, default: false },
});

const icon = computed(() => REF_ICONS[props.kind]);
</script>

<template>
  <span v-if="kind === 'head'" class="head-pill">HEAD</span>
  <span v-else class="ref-name" :class="[kind, { fit, plain }]">
    <component :is="icon" v-if="!plain" :size="13" :stroke-width="2" class="icon" />
    <span class="text">{{ name }}</span>
  </span>
</template>

<style scoped>
.ref-name {
  --tint: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 1px 8px 1px 6px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--tint) 18%, transparent);
  overflow-wrap: anywhere;
  font-size: var(--font-sm);
  font-weight: 500;
  line-height: 16px;
  color: var(--text-primary);
}

.ref-name.plain {
  padding: 1px 8px;
}

.ref-name.fit {
  max-width: 240px;
  white-space: nowrap;
}

.fit .text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ref-name.remote {
  --tint: var(--text-secondary);
}

.ref-name.tag {
  --tint: var(--ref-tag);
  --tint-text: var(--ref-tag-text);
}

/* Its own color, where the tint is too light to read on itself, as a tag's is. */
.icon {
  flex-shrink: 0;
  color: var(--tint-text, var(--tint));
}

.head-pill {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--accent-fill);
  font-size: var(--font-xs);
  font-weight: 700;
  line-height: 16px;
  color: white;
}
</style>
