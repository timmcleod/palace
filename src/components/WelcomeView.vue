<script setup>
import { computed, ref, watch } from "vue";
import { CircleAlert, FolderGit2, X } from "lucide-vue-next";
import Spinner from "./Spinner.vue";
import { FILTER_RECENTS } from "../lib/storage.js";

// The screen with no repository open: opening or cloning one, or one of the recent
// repositories. While the last repository reopens at startup, only a spinner.
const props = defineProps({
  // While the last repository reopens, so the screen doesn't flash up first.
  starting: { type: Boolean, default: false },
  // The recent repositories, { name, path }, most recent first.
  recents: { type: Array, required: true },
  // While a repository is opening.
  loading: { type: Boolean, default: false },
  // Why the last repository couldn't be opened.
  error: { type: String, default: "" },
});
// open-repository: choose a folder to open. clone: browse GitHub to clone one.
// open(path) and remove(path): a recent repository, opened or taken off the list.
const emit = defineEmits(["open-repository", "clone", "open", "remove"]);

// A list of more recent repositories than FILTER_RECENTS has a field to find one in,
// and shows that many, scrolling to the rest.
const recentList = ref(null);
const recentListHeight = ref("none");
watch(
  [recentList, () => props.recents.length],
  () => {
    const row = recentList.value?.querySelector(".recent");
    recentListHeight.value = props.recents.length > FILTER_RECENTS && row ? `${FILTER_RECENTS * row.offsetHeight}px` : "none";
  },
  { flush: "post" },
);
const recentQuery = ref("");
const shownRecents = computed(() => {
  const words = recentQuery.value.toLowerCase().split(/\s+/).filter(Boolean);
  return props.recents.filter((repo) => {
    const text = `${repo.name} ${repo.path}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
});

// Enter in the field opens the first match.
function openFirstRecent() {
  const repo = shownRecents.value[0];
  if (repo) emit("open", repo.path);
}
</script>

<template>
  <main class="welcome">
    <span v-if="starting" class="starting"><Spinner :size="22" /></span>
    <div v-else class="welcome-card">
      <img src="/palace.svg" alt="" class="welcome-icon" />
      <h1>Palace</h1>
      <p class="dim">Open a Git repository to get started.</p>

      <p v-if="error" class="error"><CircleAlert :size="15" /> {{ error }}</p>

      <div class="welcome-buttons">
        <button class="primary-button" :disabled="loading" @click="emit('open-repository')">
          {{ loading ? "Opening…" : "Open Repository…" }}
        </button>
        <button class="secondary-button" :disabled="loading" @click="emit('clone')">Clone Repository…</button>
      </div>

      <div v-if="recents.length" class="recents">
        <div class="recents-title">Recent</div>
        <input
          v-if="recents.length > FILTER_RECENTS"
          v-model="recentQuery"
          class="recent-filter"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="Find a repository"
          @keydown.enter="openFirstRecent"
        />
        <div ref="recentList" class="recent-list" :style="{ maxHeight: recentListHeight }">
          <div v-if="!shownRecents.length" class="recent-none">No matching repositories</div>
          <div v-for="repo in shownRecents" :key="repo.path" class="recent" @click="emit('open', repo.path)">
            <FolderGit2 :size="17" :stroke-width="1.5" class="row-icon" />
            <div class="recent-text">
              <div>{{ repo.name }}</div>
              <div class="recent-path">{{ repo.path }}</div>
            </div>
            <button class="icon-button small" title="Remove from list" @click.stop="emit('remove', repo.path)">
              <X :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.welcome {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: var(--sidebar-bg);
}

/* Only shown if reopening the last repository takes a moment. */
.starting {
  display: flex;
  color: var(--text-tertiary);
  opacity: 0;
  animation: appear 0.2s 0.5s forwards;
}

@keyframes appear {
  to {
    opacity: 1;
  }
}

.welcome-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(460px, calc(100vw - 32px));
  /* No taller than the window: a long list of recent repositories scrolls instead. */
  box-sizing: border-box;
  max-height: calc(100vh - 56px);
  padding: 36px 28px 24px;
  border-radius: 14px;
  background: var(--content-bg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 8px 30px rgba(0, 0, 0, 0.08);
  text-align: center;
}

.welcome-buttons {
  display: flex;
  gap: 10px;
}

/* Palace's icon. Its tile leaves a margin, as desktop icons do, which the negative
   margin takes back. */
.welcome-icon {
  width: 72px;
  height: 72px;
  margin: -4px;
}

.welcome h1 {
  margin: 10px 0 4px;
  font-size: 22px;
  font-weight: 600;
}

.welcome .dim {
  margin: 0 0 18px;
}

.error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 16px;
  color: var(--danger);
  text-align: left;
  word-break: break-word;
}

.error svg {
  flex-shrink: 0;
  margin-top: 3px;
}

.recents {
  display: flex;
  flex-direction: column;
  align-self: stretch;
  min-height: 0;
  margin-top: 24px;
  text-align: left;
}

.recent-filter {
  flex-shrink: 0;
  margin: 0 0 6px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  font-size: 13px;
  color: var(--text-primary);
}

.recent-filter:focus {
  border-color: var(--accent);
}

.recent-none {
  padding: 6px 8px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.recent-list {
  min-height: 0;
  overflow-y: auto;
}

.recents-title {
  padding: 0 8px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
}

.recent {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 7px;
}

.recent:hover {
  background: var(--row-hover);
}

.recent .icon-button {
  visibility: hidden;
}

.recent:hover .icon-button {
  visibility: visible;
}

.recent-text {
  flex: 1;
  min-width: 0;
}

.recent-path {
  overflow: hidden;
  font-size: 12px;
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
