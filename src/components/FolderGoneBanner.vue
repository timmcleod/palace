<script setup>
import { FolderX } from "lucide-vue-next";

// Shown when the window's repository folder is gone: removed as a worktree, or moved or
// deleted outside Palace. What's on screen is as it was, the terminals' output with it,
// until the window is closed.
defineProps({
  name: { type: String, required: true },
  path: { type: String, required: true },
  worktree: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);
</script>

<template>
  <div class="banner" role="alert">
    <FolderX :size="16" class="icon" />
    <div class="text">
      <strong>{{ worktree ? `The worktree “${name}” was removed` : `“${name}” was moved or deleted` }}</strong>
      <span>Its folder, {{ path }}, is gone. What's shown is as it was.</span>
    </div>
    <button class="primary-button" @click="emit('close')">Close Window</button>
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
  overflow-wrap: anywhere;
}

button {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: 12.5px;
}
</style>
