<script setup>
import { CircleDot } from "lucide-vue-next";

// The list of open issues offered while "#" is typed: see issueSuggestions.js.
defineProps({
  // useIssueSuggestions()'s result.
  suggestions: { type: Object, required: true },
});
</script>

<template>
  <div v-if="suggestions.items.value.length" class="suggestions" :style="suggestions.position.value" role="listbox">
    <!-- mousedown, so the field keeps focus. -->
    <div
      v-for="(issue, i) in suggestions.items.value"
      :key="issue.number"
      class="suggestion"
      :class="{ active: i === suggestions.index.value }"
      role="option"
      @mousedown.prevent="suggestions.pick(issue)"
      @mouseenter="suggestions.index.value = i"
    >
      <CircleDot :size="14" class="icon" />
      <span class="number">#{{ issue.number }}</span>
      <span class="title">{{ issue.title }}</span>
    </div>
  </div>
</template>

<style scoped>
.suggestions {
  position: fixed;
  z-index: 30;
  max-width: 480px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--content-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.suggestion {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 5px;
  font-size: 13px;
  white-space: nowrap;
}

.suggestion.active {
  background: var(--accent);
  color: #fff;
}

.icon {
  flex-shrink: 0;
  color: #1a7f37;
}

.active .icon,
.active .number {
  color: inherit;
}

.number {
  color: var(--text-tertiary);
}

.title {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
