<script setup>
import { CircleAlert, CircleCheck, MessageCircleQuestion, X } from "lucide-vue-next";

// Notices that a terminal's program, such as Claude Code, finished or needs you, from
// this window or another, shown in the window you're in. Clicking one brings its tab
// forward, in its own window.
defineProps({ notices: { type: Array, required: true } });
const emit = defineEmits(["open", "dismiss"]);

const icons = { done: CircleCheck, blocked: MessageCircleQuestion, error: CircleAlert };
</script>

<template>
  <div v-if="notices.length" class="terminal-notices">
    <div
      v-for="notice in notices"
      :key="notice.id"
      class="notice"
      :class="notice.state"
      role="status"
      title="Show the Terminal Tab"
      @click="emit('open', notice)"
    >
      <component :is="icons[notice.state] ?? CircleCheck" :size="18" :stroke-width="1.75" class="icon" />
      <div class="body">
        <strong>{{ notice.title }}</strong>
        <span v-if="notice.body" class="dim">{{ notice.body }}</span>
      </div>
      <button class="icon-button small close" title="Close" @click.stop="emit('dismiss', notice)">
        <X :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.terminal-notices {
  position: fixed;
  top: 60px;
  right: 16px;
  z-index: 16;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(340px, calc(100vw - 32px));
}

.notice {
  display: flex;
  gap: 10px;
  padding: 10px 8px 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--content-bg);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  cursor: pointer;
}

.icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--accent);
}

.notice.error .icon {
  color: var(--danger);
}

.body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  font-size: 13px;
}

.dim {
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.close {
  flex-shrink: 0;
}
</style>
