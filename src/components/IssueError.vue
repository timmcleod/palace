<script setup>
import { computed } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleAlert } from "lucide-vue-next";
import { FINE_GRAINED_TOKENS_URL, issueError } from "../lib/issues.js";

// Something GitHub refused in the Issues view, with a way to change the token when
// that's the trouble.
const props = defineProps({ error: { type: String, required: true } });
const shown = computed(() => issueError(props.error));
</script>

<template>
  <div class="issue-error">
    <p><CircleAlert :size="15" class="icon" /> {{ shown.text }}</p>
    <button v-if="shown.aboutToken" class="secondary-button" @click="openUrl(FINE_GRAINED_TOKENS_URL)">
      Change Token on GitHub
    </button>
  </div>
</template>

<style scoped>
.issue-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  color: var(--danger);
}

p {
  margin: 0;
  line-height: 1.45;
}

.icon {
  margin-right: 2px;
  vertical-align: -2px;
}

button {
  padding: 4px 12px;
  font-size: 13px;
}
</style>
