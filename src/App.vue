<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CloudDownload,
  FolderGit2,
  GitBranch,
  GitMerge,
  History,
  RefreshCw,
  Search,
  X,
} from "lucide-vue-next";
import Sidebar from "./components/Sidebar.vue";
import {
  forgetRepository,
  readJson,
  recentRepositories,
  rememberRepository,
  writeJson,
} from "./lib/storage.js";

const overview = ref(null);
const loading = ref(false);
const error = ref("");
const recents = ref(recentRepositories());
const selected = ref("workspace:history");

const PANES_KEY = "palace.paneWidths";
const panes = reactive({ sidebar: 300, history: 580, ...readJson(PANES_KEY, {}) });

// Each load gets a sequence number so a slow, older load can't overwrite a newer one.
let loadSeq = 0;

async function loadRepository(path, { quiet = false } = {}) {
  const seq = ++loadSeq;
  if (!quiet) {
    loading.value = true;
  }

  try {
    const data = await invoke("repo_overview", { path });
    if (seq !== loadSeq) return;
    if (data.path !== overview.value?.path) {
      selected.value = "workspace:history";
    }
    overview.value = data;
    error.value = "";
    rememberRepository(data);
    recents.value = recentRepositories();
  } catch (e) {
    if (seq !== loadSeq) return;
    // A failed background refresh keeps showing the last good state.
    if (!quiet) {
      overview.value = null;
      error.value = `Couldn't open ${path}: ${e}`;
    }
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function chooseRepository() {
  const path = await open({ directory: true, multiple: false, title: "Open Repository" });
  if (path) {
    await loadRepository(path);
  }
}

function refresh() {
  if (overview.value) {
    loadRepository(overview.value.path, { quiet: true });
  }
}

function removeRecent(path) {
  forgetRepository(path);
  recents.value = recentRepositories();
}

// Until there's a file watcher, refreshing on focus catches changes made in a terminal
// or editor, which covers the common case.
window.addEventListener("focus", refresh);
onBeforeUnmount(() => window.removeEventListener("focus", refresh));

onMounted(() => {
  const last = recents.value[0];
  if (last) {
    loadRepository(last.path);
  }
});

watch(
  () => overview.value?.name,
  (name) => {
    getCurrentWindow()
      .setTitle(name ? `${name} — Palace` : "Palace")
      .catch(() => {});
  },
  { immediate: true },
);

const subtitle = computed(() => {
  const o = overview.value;
  if (!o) return "";
  const where = o.head.branch ?? `detached at ${o.head.short_id}`;
  if (o.commit_count == null) return `${where} (no commits yet)`;
  return `${where} (${o.commit_count.toLocaleString()} ${o.commit_count === 1 ? "Commit" : "Commits"})`;
});

// The ref the history pane will show: whatever ref is selected in the sidebar,
// falling back to HEAD.
const breadcrumb = computed(() => {
  const o = overview.value;
  if (!o) return [];
  const [kind, name] = splitKey(selected.value);

  if (kind === "branch") {
    const branch = o.branches.find((b) => b.name === name);
    return [name, branch?.upstream].filter(Boolean);
  }
  if (kind === "remote-branch" || kind === "tag") {
    return [name];
  }
  const head = o.branches.find((b) => b.is_head);
  return [o.head.branch ?? o.head.short_id ?? "HEAD", head?.upstream].filter(Boolean);
});

function splitKey(key) {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

function startResize(event, pane, min, max) {
  const startX = event.clientX;
  const startWidth = panes[pane];
  const target = event.currentTarget;
  target.setPointerCapture(event.pointerId);

  const move = (e) => {
    panes[pane] = Math.min(max, Math.max(min, startWidth + e.clientX - startX));
  };
  const stop = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", stop);
    writeJson(PANES_KEY, { sidebar: panes.sidebar, history: panes.history });
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", stop);
}
</script>

<template>
  <div
    v-if="overview"
    class="window"
    :style="{ gridTemplateColumns: `${panes.sidebar}px ${panes.history}px minmax(320px, 1fr)` }"
  >
    <Sidebar v-model:selected="selected" :overview="overview" @open-repository="chooseRepository" />

    <section class="pane history-pane">
      <div class="splitter" @pointerdown="startResize($event, 'sidebar', 200, 480)" />

      <header class="toolbar">
        <div class="nav-buttons">
          <button class="icon-button" title="Back" disabled><ChevronLeft :size="20" :stroke-width="1.5" /></button>
          <button class="icon-button" title="Forward" disabled><ChevronRight :size="20" :stroke-width="1.5" /></button>
        </div>
        <div class="repo-title">
          <div class="repo-name">{{ overview.name }}</div>
          <div class="repo-subtitle">{{ subtitle }}</div>
        </div>
      </header>

      <div class="subheader">
        <span class="breadcrumb">
          <template v-for="(part, i) in breadcrumb" :key="i">
            <span v-if="i > 0" class="breadcrumb-sep">›</span>
            <span :class="{ dim: i > 0 }">{{ part }}</span>
          </template>
        </span>
      </div>

      <div class="empty-state">
        <History :size="32" :stroke-width="1.25" />
        <p>Commit history is coming in the next step.</p>
      </div>
    </section>

    <section class="pane detail-pane">
      <div class="splitter" @pointerdown="startResize($event, 'history', 360, 1000)" />

      <header class="toolbar actions">
        <div class="action-group">
          <button class="icon-button" title="Fetch (coming soon)" disabled><CloudDownload :size="18" :stroke-width="1.5" /></button>
          <button class="icon-button" title="Pull (coming soon)" disabled><ArrowDownToLine :size="18" :stroke-width="1.5" /></button>
          <button class="icon-button" title="Push (coming soon)" disabled><ArrowUpFromLine :size="18" :stroke-width="1.5" /></button>
        </div>
        <div class="action-group">
          <button class="icon-button" title="Branch (coming soon)" disabled><GitBranch :size="18" :stroke-width="1.5" /></button>
          <button class="icon-button" title="Merge (coming soon)" disabled><GitMerge :size="18" :stroke-width="1.5" /></button>
        </div>
        <div class="action-group">
          <button class="icon-button" title="Stash (coming soon)" disabled><Archive :size="18" :stroke-width="1.5" /></button>
          <button class="icon-button" title="Pop Stash (coming soon)" disabled><ArchiveRestore :size="18" :stroke-width="1.5" /></button>
        </div>
        <button class="icon-button" title="Refresh" @click="refresh">
          <RefreshCw :size="17" :stroke-width="1.5" :class="{ spinning: loading }" />
        </button>
        <label class="search" title="File search (coming soon)">
          <Search :size="15" :stroke-width="1.5" />
          <input placeholder="Search for File" disabled />
        </label>
      </header>

      <div class="subheader">
        <span />
        <div class="segmented">
          <button class="active" disabled>Changeset</button>
          <button disabled>Tree</button>
        </div>
      </div>

      <div class="empty-state">
        <p>Select a commit to see its details.</p>
      </div>
    </section>
  </div>

  <main v-else class="welcome">
    <div class="welcome-card">
      <FolderGit2 :size="44" :stroke-width="1.25" class="welcome-icon" />
      <h1>Palace</h1>
      <p class="dim">Open a Git repository to get started.</p>

      <p v-if="error" class="error"><CircleAlert :size="15" /> {{ error }}</p>

      <button class="primary-button" :disabled="loading" @click="chooseRepository">
        {{ loading ? "Opening…" : "Open Repository…" }}
      </button>

      <div v-if="recents.length" class="recents">
        <div class="recents-title">Recent</div>
        <div v-for="repo in recents" :key="repo.path" class="recent" @click="loadRepository(repo.path)">
          <FolderGit2 :size="17" :stroke-width="1.5" class="row-icon" />
          <div class="recent-text">
            <div>{{ repo.name }}</div>
            <div class="recent-path">{{ repo.path }}</div>
          </div>
          <button class="icon-button small" title="Remove from list" @click.stop="removeRecent(repo.path)">
            <X :size="14" />
          </button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.window {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  height: 100vh;
}

.pane {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-left: 1px solid var(--border);
  background: var(--content-bg);
}

.splitter {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  width: 7px;
  cursor: col-resize;
  z-index: 1;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--toolbar-height);
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.nav-buttons {
  display: flex;
}

.repo-title {
  min-width: 0;
  line-height: 1.25;
}

.repo-name {
  font-weight: 600;
  color: var(--text-secondary);
}

.repo-subtitle {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.actions {
  justify-content: flex-end;
}

.action-group {
  display: flex;
  border-radius: 8px;
  background: var(--toolbar-group-bg);
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 220px;
  height: 32px;
  padding: 0 10px;
  border-radius: 8px;
  background: var(--toolbar-group-bg);
  color: var(--text-tertiary);
}

.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  font: inherit;
}

.subheader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  white-space: nowrap;
}

.breadcrumb {
  overflow: hidden;
  text-overflow: ellipsis;
}

.breadcrumb-sep {
  margin: 0 6px;
  color: var(--text-tertiary);
}

.segmented {
  display: flex;
  padding: 2px;
  border-radius: 7px;
  background: var(--toolbar-group-bg);
}

.segmented button {
  padding: 2px 12px;
  border: 0;
  border-radius: 5px;
  background: none;
  font: inherit;
  color: var(--text-primary);
}

.segmented button.active {
  background: var(--row-selected);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-tertiary);
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.welcome {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: var(--sidebar-bg);
}

.welcome-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(460px, calc(100vw - 32px));
  padding: 36px 28px 24px;
  border-radius: 14px;
  background: var(--content-bg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 8px 30px rgba(0, 0, 0, 0.08);
  text-align: center;
}

.welcome-icon {
  color: var(--accent);
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

.primary-button {
  padding: 7px 18px;
  border: 0;
  border-radius: 7px;
  background: var(--accent);
  color: white;
  font: inherit;
  font-weight: 500;
}

.primary-button:hover:not(:disabled) {
  filter: brightness(1.08);
}

.recents {
  align-self: stretch;
  margin-top: 24px;
  text-align: left;
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
