<script setup>
import { computed } from "vue";
import { MessageSquare, Sparkle } from "lucide-vue-next";
import { reviews } from "../lib/review.js";
import { agentCommand, agentName } from "../lib/agents.js";
import Spinner from "./Spinner.vue";

// Below the diffs: the review comments waiting to go to the repository's agent.
const props = defineProps({
  path: { type: String, required: true },
  sending: { type: Boolean, default: false },
});
const emit = defineEmits(["send", "clear"]);

const comments = computed(() => reviews[props.path] ?? []);
const unsent = computed(() => comments.value.filter((c) => !c.sent));
const files = computed(() => new Set(unsent.value.map((c) => c.file)).size);
const agent = computed(() => agentName(agentCommand(props.path)));

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
</script>

<template>
  <div v-if="comments.length" class="review-tray">
    <MessageSquare :size="14" class="icon" />
    <span v-if="unsent.length" class="summary">{{ plural(unsent.length, "comment", "comments") }} on {{ plural(files, "file", "files") }}</span>
    <span v-else class="summary dim">{{ plural(comments.length, "comment", "comments") }} sent</span>
    <span class="spacer" />
    <button class="secondary-button" :disabled="sending" @click="emit('clear')">Clear</button>
    <button
      v-if="unsent.length"
      class="primary-button send"
      :disabled="sending"
      :title="`Put the comments in ${agent}'s prompt, for you to add to and send`"
      @click="emit('send')"
    >
      <Spinner v-if="sending" :size="12" /><Sparkle v-else :size="13" /> Send to {{ agent }}
    </button>
  </div>
</template>

<style scoped>
.review-tray {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 7px 12px 7px 14px;
  border-top: 1px solid var(--border);
  background: var(--sidebar-bg);
  font-size: 12.5px;
}

.icon {
  color: var(--accent);
}

.dim {
  color: var(--text-tertiary);
}

.spacer {
  flex: 1;
}

.review-tray button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 11px;
  font-size: 12.5px;
}
</style>
