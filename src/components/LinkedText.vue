<script setup>
import { computed } from "vue";
import { splitIssueRefs } from "../lib/issues.js";

// Text with its issue numbers ("#42") as links to them, as in a commit's message, where
// the repository's issues show. Each link asks to show its issue ("show-issue").
const props = defineProps({
  text: { type: String, required: true },
  issueLinks: { type: Boolean, default: false },
});
const emit = defineEmits(["show-issue"]);

const pieces = computed(() => (props.issueLinks ? splitIssueRefs(props.text) : [{ text: props.text }]));
</script>

<!-- On one line, as the text may be shown keeping its whitespace. -->
<template>
  <template v-for="(piece, i) in pieces" :key="i"><a v-if="piece.issue" href="#" class="issue-ref" :title="`Show issue ${piece.text}`" @click.prevent="emit('show-issue', piece.issue)">{{ piece.text }}</a><template v-else>{{ piece.text }}</template></template>
</template>

<style scoped>
.issue-ref {
  color: var(--accent);
  text-decoration: none;
}

.issue-ref:hover {
  text-decoration: underline;
}
</style>
