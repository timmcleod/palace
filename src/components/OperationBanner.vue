<script setup>
import { computed } from "vue";
import { TriangleAlert } from "lucide-vue-next";

// Shown while a merge, rebase, cherry-pick or revert is waiting on the user.
const props = defineProps({
  operation: { type: String, required: true },
  conflicts: { type: Number, default: 0 },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(["action"]);

const NAMES = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert" };

const status = computed(() =>
  props.conflicts
    ? `${props.conflicts} conflicted file${props.conflicts === 1 ? "" : "s"} to resolve`
    : "All conflicts resolved",
);
</script>

<template>
  <div class="banner" :class="{ resolved: !conflicts }">
    <TriangleAlert :size="16" class="icon" />
    <div class="text">
      <strong>{{ NAMES[operation] }} in progress</strong>
      <span>{{ status }}</span>
    </div>
    <button class="secondary-button" :disabled="busy" @click="emit('action', 'abort')">Abort</button>
    <button v-if="operation === 'rebase'" class="secondary-button" :disabled="busy" title="Drop this commit and continue" @click="emit('action', 'skip')">
      Skip
    </button>
    <button class="primary-button" :disabled="busy || conflicts > 0" @click="emit('action', 'continue')">
      Continue
    </button>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 8px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--banner-warning-bg);
  flex-shrink: 0;
}

.icon {
  flex-shrink: 0;
  color: var(--ref-tag);
}

.resolved .icon {
  color: var(--lane-4);
}

.text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.35;
}

.text span {
  color: var(--text-secondary);
}

button {
  padding: 4px 12px;
  font-size: 12.5px;
}
</style>
