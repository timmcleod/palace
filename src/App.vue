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
  RefreshCw,
  Search,
  X,
} from "lucide-vue-next";
import CommitDetails from "./components/CommitDetails.vue";
import HistoryList from "./components/HistoryList.vue";
import Sidebar from "./components/Sidebar.vue";
import WorkingCopy from "./components/WorkingCopy.vue";
import WorkingFileDiff from "./components/WorkingFileDiff.vue";
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
// The ref whose history is shown, as { kind, name }; null means HEAD.
const historyRef = ref(null);
const selectedCommit = ref(null);
const refreshKey = ref(0);
const workingFile = ref(null);
// The commit message being written, kept while switching between views.
const draft = reactive({ subject: "", body: "" });

const isWorkingCopy = computed(() => selected.value === "workspace:working-copy");

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
      historyRef.value = null;
      selectedCommit.value = null;
      workingFile.value = null;
      draft.subject = "";
      draft.body = "";
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
    refreshKey.value++;
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

// Selecting a ref in the sidebar shows its history; Workspace › History goes back to
// HEAD. Other items (folders, Settings, …) leave the history pane as it is.
const HISTORY_KINDS = ["branch", "remote-branch", "tag", "stash"];

watch(selected, (key) => {
  const [kind, name] = splitKey(key);
  if (key === "workspace:history") {
    historyRef.value = null;
  } else if (HISTORY_KINDS.includes(kind)) {
    historyRef.value = { kind, name };
  }
});

const historyRev = computed(() => {
  const r = historyRef.value;
  if (!r) return null;
  return {
    branch: `refs/heads/${r.name}`,
    "remote-branch": `refs/remotes/${r.name}`,
    tag: `refs/tags/${r.name}`,
    stash: `stash@{${r.name}}`,
  }[r.kind];
});

const breadcrumb = computed(() => {
  const o = overview.value;
  if (!o) return [];
  const r = historyRef.value;

  if (r?.kind === "branch") {
    const branch = o.branches.find((b) => b.name === r.name);
    return [r.name, branch?.upstream].filter(Boolean);
  }
  if (r?.kind === "stash") {
    return [`stash@{${r.name}}`];
  }
  if (r) {
    return [r.name];
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
    :style="{ gridTemplateColumns: `${panes.sidebar}px minmax(280px, ${panes.history}px) minmax(320px, 1fr)` }"
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
        <span v-if="isWorkingCopy">Working Copy</span>
        <span v-else class="breadcrumb">
          <template v-for="(part, i) in breadcrumb" :key="i">
            <span v-if="i > 0" class="breadcrumb-sep">›</span>
            <span :class="{ dim: i > 0 }">{{ part }}</span>
          </template>
        </span>
      </div>

      <WorkingCopy
        v-if="isWorkingCopy"
        v-model:subject="draft.subject"
        v-model:body="draft.body"
        :path="overview.path"
        :refresh-key="refreshKey"
        :selected-path="workingFile?.path"
        @select="workingFile = $event"
        @changed="refresh"
      />
      <!-- Hidden rather than removed, so the history keeps its scroll position. -->
      <div v-show="!isWorkingCopy" class="pane-body">
        <HistoryList
          :path="overview.path"
          :rev="historyRev"
          :refresh-key="refreshKey"
          :selected-id="selectedCommit?.id"
          @select="selectedCommit = $event"
        />
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

      <template v-if="isWorkingCopy">
        <div class="subheader">
          <span class="file-title">{{ workingFile?.path }}</span>
        </div>
        <WorkingFileDiff v-if="workingFile" :path="overview.path" :file="workingFile" @changed="refresh" />
        <div v-else class="empty-state">
          <p>Select a file to see its changes.</p>
        </div>
      </template>

      <template v-else>
        <div class="subheader">
          <span class="mono dim">{{ selectedCommit?.short_id }}</span>
          <div class="segmented">
            <button class="active" disabled>Changeset</button>
            <button disabled title="Browsing a commit's files is coming soon">Tree</button>
          </div>
        </div>

        <CommitDetails v-if="selectedCommit" :path="overview.path" :commit="selectedCommit" />
        <div v-else class="empty-state">
          <p>Select a commit to see its details.</p>
        </div>
      </template>
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

.pane-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.file-title {
  overflow: hidden;
  text-overflow: ellipsis;
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
  overflow: hidden;
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
  min-width: 120px;
  flex-shrink: 1;
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
