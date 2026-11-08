<script setup>
import { computed } from "vue";
import { Sparkle } from "lucide-vue-next";
import { agentIcon } from "../lib/agents.js";
import { namedIconUrl } from "../lib/fileIcons.js";

// An agent's own icon, such as Claude's, by its name (see agentIcon), or a sparkle for
// one without: on its terminal tabs, the buttons that start it or send it review
// comments, and a commit it co-authored. Drawn in the color of the text around it, as
// the other icons are: its file's exact shape, as a mask, filled with that color, so it
// suits either theme without a version for each.
const props = defineProps({
  // The agent's name, as agentName gives it: "Claude", "Codex".
  name: { type: String, default: null },
  size: { type: Number, default: 13 },
});

const url = computed(() => {
  const icon = agentIcon(props.name);
  return icon && namedIconUrl(icon);
});
</script>

<template>
  <span
    v-if="url"
    class="agent-icon"
    aria-hidden="true"
    :style="{ width: `${size}px`, height: `${size}px`, '--shape': `url(${url})` }"
  />
  <Sparkle v-else :size="size" :stroke-width="1.75" />
</template>

<style scoped>
.agent-icon {
  display: inline-block;
  flex-shrink: 0;
  background: currentColor;
  -webkit-mask: var(--shape) center / contain no-repeat;
  mask: var(--shape) center / contain no-repeat;
}
</style>
