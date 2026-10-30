<script setup>
import { computed } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDownCircle, X } from "lucide-vue-next";
import { installUpdate, releaseNotesUrl, updateNoticeShown as shown, updates } from "../lib/updates.js";

// Says a new version is out, and installs it on request.

const percent = computed(() => (updates.total ? Math.min(100, Math.round((updates.downloaded / updates.total) * 100)) : null));
</script>

<template>
  <div v-if="shown" class="update-notice" role="status">
    <ArrowDownCircle :size="20" :stroke-width="1.75" class="icon" />
    <div class="body">
      <template v-if="updates.state === 'installing'">
        <strong>Installing Palace {{ updates.version }}…</strong>
        <div class="bar"><div class="fill" :style="{ width: `${percent ?? 15}%` }" :class="{ unknown: percent == null }" /></div>
        <span class="dim">Palace restarts when it's done. You may be asked for your password.</span>
      </template>
      <template v-else-if="updates.state === 'error'">
        <strong>Couldn't install Palace {{ updates.version }}</strong>
        <span class="error">{{ updates.error }}</span>
        <div class="actions">
          <button class="secondary-button" @click="openUrl(releaseNotesUrl(updates.version))">Download It Yourself</button>
          <button class="link-button" @click="updates.dismissed = true">Dismiss</button>
        </div>
      </template>
      <template v-else>
        <strong>Palace {{ updates.version }} is available</strong>
        <span class="dim">You have {{ updates.current }}.</span>
        <div class="actions">
          <button class="primary-button" @click="installUpdate">Install and Restart</button>
          <button class="link-button" @click="openUrl(releaseNotesUrl(updates.version))">What's New</button>
        </div>
      </template>
    </div>
    <button v-if="updates.state !== 'installing'" class="icon-button small close" title="Later" @click="updates.dismissed = true">
      <X :size="14" />
    </button>
  </div>
</template>

<style scoped>
.update-notice {
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

.error {
  font-size: 12.5px;
  color: var(--danger);
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
}

.actions .primary-button,
.actions .secondary-button {
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

.bar {
  height: 4px;
  margin: 4px 0;
  overflow: hidden;
  border-radius: 2px;
  background: var(--pill-bg);
}

.fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.2s;
}

.fill.unknown {
  animation: slide 1.2s ease-in-out infinite alternate;
}

@keyframes slide {
  from {
    margin-left: 0;
  }
  to {
    margin-left: 85%;
  }
}
</style>
