<script setup>
import { onMounted } from "vue";
import { Star, X } from "lucide-vue-next";
import { dismissStarRequest, markAsked, starPalace, starRequest } from "../lib/star.js";

// Asks, once, for a star on GitHub. App shows it only while the update notice, which
// sits in the same corner, isn't showing.
onMounted(markAsked);
</script>

<template>
  <div class="star-notice" role="status">
    <Star :size="20" :stroke-width="1.75" class="icon" />
    <div class="body">
      <template v-if="starRequest === 'thanks'">
        <strong>Thanks for the star!</strong>
      </template>
      <template v-else>
        <strong>Enjoying Palace?</strong>
        <span class="dim">A star on GitHub helps other developers find it.</span>
        <div class="actions">
          <button class="primary-button" :disabled="starRequest === 'starring'" @click="starPalace">
            {{ starRequest === "starring" ? "Starring…" : "Star on GitHub" }}
          </button>
          <button class="link-button" @click="dismissStarRequest">No Thanks</button>
        </div>
      </template>
    </div>
    <button class="icon-button small close" title="Close" @click="dismissStarRequest">
      <X :size="14" />
    </button>
  </div>
</template>

<style scoped>
.star-notice {
  position: fixed;
  bottom: 16px;
  left: 16px;
  z-index: 15;
  display: flex;
  gap: 10px;
  width: min(340px, calc(100vw - 32px));
  padding: 12px 10px 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--content-bg);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
}

.icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--accent);
}

.body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dim {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
}

.actions .primary-button {
  padding: 4px 12px;
  font-size: 13px;
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--accent);
  cursor: pointer;
}

.close {
  flex-shrink: 0;
}
</style>
