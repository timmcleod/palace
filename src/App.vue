<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
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
import ConflictView from "./components/ConflictView.vue";
import ContextMenu from "./components/ContextMenu.vue";
import CloneDialog from "./components/CloneDialog.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import FileSearch from "./components/FileSearch.vue";
import GitHubView from "./components/GitHubView.vue";
import GitMissing from "./components/GitMissing.vue";
import StashList from "./components/StashList.vue";
import FormDialog from "./components/FormDialog.vue";
import MergeDialog from "./components/MergeDialog.vue";
import PullDialog from "./components/PullDialog.vue";
import ResetDialog from "./components/ResetDialog.vue";
import HistoryList from "./components/HistoryList.vue";
import OperationBanner from "./components/OperationBanner.vue";
import RemoteStatus from "./components/RemoteStatus.vue";
import SettingsView from "./components/SettingsView.vue";
import Sidebar from "./components/Sidebar.vue";
import TagDialog from "./components/TagDialog.vue";
import TreeView from "./components/TreeView.vue";
import UpdateNotice from "./components/UpdateNotice.vue";
import WorkingCopy from "./components/WorkingCopy.vue";
import WorkingFileDiff from "./components/WorkingFileDiff.vue";
import {
  forgetRepository,
  readJson,
  recentRepositories,
  rememberRepository,
  writeJson,
} from "./lib/storage.js";
import { useGitActions } from "./lib/gitActions.js";
import {
  cloneDialog,
  confirmDialog,
  contextMenu,
  formDialog,
  mergeDialog,
  openCloneDialog,
  openMenu,
  pullDialog,
  resetDialog,
  tagDialog,
} from "./lib/overlays.js";
import { cloneFolder, rememberCloneFolder } from "./lib/clone.js";
import { loadAvatars } from "./lib/avatars.js";

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
// The commit being written, kept while switching between views. While amending,
// `saved` holds the draft that was there before, to restore if amending is undone.
const draft = reactive({ subject: "", body: "", amend: false, saved: null });

// Set when the history shows only the commits that changed this file.
const fileFilter = ref(null);
// The detail pane shows a commit's changes, or all its files ("tree").
const detailMode = ref("changeset");
// The file open in the Tree view, a file for it to open (going Back to it, say), and
// the commit and file a blame click jumped to, whose diff opens on arrival.
const treeFile = ref(null);
const treeReveal = ref(null);
const blameFocus = ref(null);

function onTreeFileOpened(file) {
  treeFile.value = file;
  // Once another file is opened, the one to reopen has done its job.
  if (file !== treeReveal.value) treeReveal.value = null;
}

// From a line's blame to the commit that last changed it, with that file's diff open.
function showBlamedCommit(hunk) {
  if (isStashes.value) selected.value = headHistoryKey(overview.value);
  blameFocus.value = { id: hunk.id, file: hunk.file };
  selectedCommit.value = { id: hunk.id, short_id: hunk.short_id, refs: [] };
  detailMode.value = "changeset";
}

// Which file the commit details open: the file whose history is shown, or the one a
// blame click came from.
const focusFile = computed(() => {
  if (isStashes.value) return null;
  if (fileFilter.value) return fileFilter.value;
  return blameFocus.value?.id === detailCommit.value?.id ? blameFocus.value.file : null;
});

const isWorkingCopy = computed(() => selected.value === "workspace:working-copy");
const isSettings = computed(() => selected.value === "workspace:settings");
const isGitHub = computed(() => selected.value === "workspace:github");
// Views that take the place of both the history and detail panes.
const isFullView = computed(() => isSettings.value || isGitHub.value);
// The GitHub view opened from the welcome screen, before any repository is open.
const browsingGitHub = ref(false);
const isStashes = computed(() => selected.value === "workspace:stashes");

// The Stashes view: the chosen stash (by index) and the search for one by message.
const selectedStash = ref(null);
const stashQuery = ref("");
const stash = computed(() => overview.value?.stashes.find((s) => s.index === selectedStash.value) ?? null);

// Opening the view, or stashes coming and going, keeps a stash chosen while there are any.
watch(
  () => [isStashes.value, overview.value?.stashes.length],
  () => {
    if (isStashes.value && !stash.value) selectedStash.value = overview.value?.stashes[0]?.index ?? null;
  },
);

// What the detail pane shows: the chosen commit, or in the Stashes view, the stash.
const detailCommit = computed(() => {
  if (!isStashes.value) return selectedCommit.value;
  return stash.value && { id: stash.value.id, short_id: stash.value.short_id, refs: [] };
});

// Picking a file in the search shows its history, with the file opened in whichever
// view the detail pane is in.
function showFileHistory(file) {
  fileFilter.value = file;
  selectedCommit.value = null;
  if (isWorkingCopy.value || isFullView.value || isStashes.value) selected.value = headHistoryKey(overview.value);
}

// --- Back and Forward --------------------------------------------------------------
// Like a browser: each place is a sidebar item with the commit, stash and file filter
// chosen there. Choosing something new starts a new place; Back and Forward return to
// them. Places quickly replaced by others in the same view (arrowing through the
// history, say) aren't kept, so Back doesn't step through every one.

const MAX_PLACES = 100;
const QUICK_CHANGE = 800;
const nav = reactive({ back: [], forward: [] });
let here = null;
let hereSince = 0;
let restoring = false;

const placeHere = () => ({
  selected: selected.value,
  commit: selectedCommit.value,
  stash: selectedStash.value,
  fileFilter: fileFilter.value,
  detailMode: detailMode.value,
  treeFile: treeFile.value,
});

const samePlace = (a, b) =>
  a.selected === b.selected &&
  a.commit?.id === b.commit?.id &&
  a.stash === b.stash &&
  a.fileFilter === b.fileFilter &&
  a.detailMode === b.detailMode &&
  a.treeFile === b.treeFile;

watch([selected, () => selectedCommit.value?.id, selectedStash, fileFilter, detailMode, treeFile], () => {
  if (restoring || !overview.value) return;
  const place = placeHere();
  if (here && samePlace(here, place)) return;
  const quick = here && here.selected === place.selected && Date.now() - hereSince < QUICK_CHANGE;
  if (here && !quick) {
    nav.back.push(here);
    if (nav.back.length > MAX_PLACES) nav.back.shift();
  }
  here = place;
  hereSince = Date.now();
  nav.forward = [];
});

async function go(direction) {
  const [from, to] = direction === "back" ? [nav.back, nav.forward] : [nav.forward, nav.back];
  const place = from.pop();
  if (!place) return;
  if (here) to.push(here);
  here = place;
  hereSince = 0;
  restoring = true;
  selected.value = place.selected;
  selectedCommit.value = place.commit;
  selectedStash.value = place.stash;
  fileFilter.value = place.fileFilter;
  detailMode.value = place.detailMode;
  treeFile.value = place.treeFile;
  treeReveal.value = place.treeFile;
  // Let the views settle (opening a stash's view picks one, say) before recording again.
  await nextTick();
  await nextTick();
  restoring = false;
}

// A short description of a place, for the buttons' tooltips.
function describe(place) {
  if (!place) return "";
  const [kind, name] = splitKey(place.selected);
  const view = {
    "workspace:working-copy": "Working Copy",
    "workspace:stashes": "Stashes",
    "workspace:github": "GitHub",
    "workspace:settings": "Settings",
    "workspace:history": "History",
  }[place.selected] ?? name ?? kind;
  const detail = place.commit?.short_id ?? (place.selected === "workspace:stashes" && place.stash != null ? `stash@{${place.stash}}` : "");
  return [view, detail].filter(Boolean).join(" › ");
}

function onNavKeydown(event) {
  if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
  event.preventDefault();
  go(event.key === "ArrowLeft" ? "back" : "forward");
}

// Mice with back and forward buttons report them as buttons 3 and 4.
function onNavMouseup(event) {
  if (event.button === 3 || event.button === 4) {
    event.preventDefault();
    go(event.button === 3 ? "back" : "forward");
  }
}

window.addEventListener("keydown", onNavKeydown);
window.addEventListener("mouseup", onNavMouseup);
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onNavKeydown);
  window.removeEventListener("mouseup", onNavMouseup);
});

// --- Running git operations ------------------------------------------------------

// The operation shown in the status card: { command, title, line, state, message }.
const remoteOp = ref(null);
let dismissTimer;

// Only network operations report progress and can be cancelled.
const NETWORK = new Set(["fetch", "pull", "push", "clone_repo", "add_remote", "delete_remote_tag"]);

const headBranch = computed(() => overview.value?.branches.find((b) => b.is_head) ?? null);
const remoteBusy = computed(() => remoteOp.value?.state === "running");

/**
 * Runs a backend command against the open repository, showing it in the status card
 * and refreshing everything afterwards. Resolves to the error message, or null.
 *
 * titles: [while running, on success, on failure]. options.quietError(message)
 * returning true hides that failure, for callers that handle it themselves.
 * options.path runs it somewhere other than the open repository, or with none open.
 */
async function runGit([running, done, failed], command, args = {}, { quietError, path } = {}) {
  if (remoteBusy.value) return "Another operation is still running.";
  if (!overview.value && !path) return "No repository is open.";
  clearTimeout(dismissTimer);
  const op = reactive({ command, title: running, line: "", state: "running", message: "", cancellable: NETWORK.has(command) });
  remoteOp.value = op;

  try {
    op.message = await invoke(command, { path: path ?? overview.value.path, ...args });
    op.state = "done";
    op.title = done;
    // Fetching and pulling can bring in commits by new authors.
    if (command === "fetch" || command === "pull") loadAvatars(overview.value.path);
    // Successes get out of the way; failures stay until dismissed.
    dismissTimer = setTimeout(() => {
      if (remoteOp.value === op) remoteOp.value = null;
    }, 5000);
    return null;
  } catch (e) {
    const message = String(e);
    if (quietError?.(message)) {
      remoteOp.value = null;
    } else if (message.startsWith("CONFLICT: ")) {
      // The operation is under way and waiting on the user, not failed.
      op.state = "conflict";
      op.title = "Stopped for conflicts";
      op.message = message.slice("CONFLICT: ".length);
      selected.value = "workspace:working-copy";
    } else {
      op.state = "failed";
      op.title = failed;
      op.message = message;
      // A push rejected because the branch was rewritten (amend, rebase) can be
      // published by force pushing.
      if (command === "push" && message.includes("non-fast-forward")) {
        op.actions = [{ label: "Force Push…", run: () => actions.forcePush() }];
      }
    }
    return message;
  } finally {
    refresh();
  }
}

const REMOTE_TITLES = {
  fetch: ["Fetching…", "Fetched", "Fetch failed"],
  pull: ["Pulling…", "Pulled", "Pull failed"],
  push: ["Pushing…", "Pushed", "Push failed"],
};

const runRemote = (kind) => runGit(REMOTE_TITLES[kind], kind);

const actions = useGitActions({ overview, run: runGit });

// Context menus for sidebar rows, keyed the same way the sidebar keys them.
function sidebarMenu(row, event) {
  const [kind, name] = splitKey(row.key);
  const items = {
    branch: () => actions.branchMenu(name),
    "remote-branch": () => actions.remoteBranchMenu(name),
    tag: () => actions.tagMenu(name),
    stash: () => actions.stashMenu(Number(name)),
    // A remote's own row, not a folder of its branches ("origin/feature/").
    remote: () => {
      const remote = name.replace(/\/$/, "");
      return overview.value.remotes.some((r) => r.name === remote) ? actions.remoteMenu(remote) : null;
    },
  }[kind]?.();
  if (items) openMenu(event, items);
}

// Double-clicking a branch checks it out.
function sidebarActivate(row) {
  const [kind, name] = splitKey(row.key);
  if (kind === "branch" && name !== overview.value.head.branch) actions.checkout("branch", name);
  if (kind === "remote-branch") actions.checkout("remote-branch", name);
}

// Live refresh: the backend watches the open repository and reports changes made
// anywhere, such as saving a file in an editor or committing from a terminal.
watch(
  () => overview.value?.path,
  (path) => {
    if (!path) return;
    invoke("watch_repo", { path }).catch(() => {});
    loadAvatars(path);
  },
);
const unlistenChanges = listen("repo-changed", () => refresh());
onBeforeUnmount(() => unlistenChanges.then((unlisten) => unlisten()));

const unlistenProgress = listen("remote-progress", (event) => {
  if (remoteOp.value?.state === "running") {
    remoteOp.value.line = event.payload.line;
  }
});
onBeforeUnmount(() => unlistenProgress.then((unlisten) => unlisten()));

const PANES_KEY = "palace.paneWidths";
const panes = reactive({ sidebar: 300, history: 580, ...readJson(PANES_KEY, {}) });

// Each load gets a sequence number so a slow, older load can't overwrite a newer one.
let loadSeq = 0;

/**
 * Opens the repository at `path`. `quiet` refreshes the open one in the background.
 * With `keepOnError`, a repository that can't be opened leaves the current one open
 * and says why, instead of going back to the welcome screen.
 */
async function loadRepository(path, { quiet = false, keepOnError = false } = {}) {
  const seq = ++loadSeq;
  if (!quiet) {
    loading.value = true;
  }

  try {
    const data = await invoke("repo_overview", { path });
    if (seq !== loadSeq) return;
    if (data.path !== overview.value?.path) {
      selected.value = headHistoryKey(data);
      historyRef.value = null;
      selectedCommit.value = null;
      workingFile.value = null;
      fileFilter.value = null;
      selectedStash.value = null;
      stashQuery.value = "";
      // Places belong to a repository.
      nav.back = [];
      nav.forward = [];
      here = null;
      Object.assign(draft, { subject: "", body: "", amend: false, saved: null });
    }
    overview.value = data;
    error.value = "";
    rememberRepository(data);
    recents.value = recentRepositories();
  } catch (e) {
    if (seq !== loadSeq) return;
    // A failed background refresh keeps showing the last good state.
    if (quiet) return;
    if (keepOnError && overview.value) {
      clearTimeout(dismissTimer);
      remoteOp.value = reactive({
        title: "Couldn't open the repository",
        state: "failed",
        message: `${path}\n${e}`,
        actions: recents.value.some((r) => r.path === path)
          ? [{ label: "Remove from List", run: () => removeRecent(path) }]
          : [],
      });
    } else {
      overview.value = null;
      error.value = `Couldn't open ${path}: ${e}`;
    }
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

// Clones a repository (asking where to), then opens it.
async function cloneRepository(url = "") {
  const values = await openCloneDialog({ url, folder: await cloneFolder() });
  if (!values) return;
  const error = await runGit(
    ["Cloning…", "Cloned", "Clone failed"],
    "clone_repo",
    { url: values.url, dest: values.location },
    { path: values.location },
  );
  if (error) return;
  rememberCloneFolder(values.url, values.location);
  browsingGitHub.value = false;
  await loadRepository(values.location);
}

async function chooseRepository() {
  const path = await open({ directory: true, multiple: false, title: "Open Repository" });
  if (path) {
    await loadRepository(path, { keepOnError: true });
  }
}

// The recent repositories, to jump between, below the sidebar's ▾ button.
const home = ref("");
homeDir()
  .then((dir) => (home.value = dir))
  .catch(() => {});

function recentMenu(anchor) {
  const current = overview.value?.path;
  const tidy = (path) => (home.value && path.startsWith(`${home.value}/`) ? `~${path.slice(home.value.length)}` : path);
  openMenu(anchor, [
    ...recents.value.map((repo) => ({
      label: repo.name,
      detail: tidy(repo.path),
      checked: repo.path === current,
      action: () => repo.path !== current && loadRepository(repo.path, { keepOnError: true }),
    })),
    recents.value.length && { separator: true },
    { label: "Open Repository…", action: chooseRepository },
    { label: "Clone Repository…", action: () => cloneRepository() },
  ]);
}

function refresh() {
  // While a repository the user chose is still opening, a refresh would reload the one
  // on screen and, being newer, win over the switch. The window regains focus as the
  // folder picker closes, so without this, opening another repository did nothing.
  if (!overview.value || loading.value) return;
  loadRepository(overview.value.path, { quiet: true });
  refreshKey.value++;
}

function removeRecent(path) {
  forgetRepository(path);
  recents.value = recentRepositories();
}

// Until there's a file watcher, refreshing on focus catches changes made in a terminal
// or editor, which covers the common case.
window.addEventListener("focus", refresh);
onBeforeUnmount(() => window.removeEventListener("focus", refresh));

// Without a usable git, Palace shows how to install it instead of the app.
const gitStatus = ref(null);
const checkingGit = ref(false);
const gitMissing = computed(() => gitStatus.value && !gitStatus.value.supported);

async function checkGit() {
  checkingGit.value = true;
  try {
    gitStatus.value = await invoke("git_check");
  } catch {
    // Couldn't ask; carry on rather than block the app.
    gitStatus.value = null;
  } finally {
    checkingGit.value = false;
  }
  if (!gitMissing.value && !overview.value) {
    const last = recents.value[0];
    if (last) loadRepository(last.path);
  }
}

onMounted(checkGit);

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
  if (isStashes.value) return `Stashes (${o.stashes.length} ${o.stashes.length === 1 ? "Stash" : "Stashes"})`;
  const where = o.head.branch ?? `detached at ${o.head.short_id}`;
  if (o.commit_count == null) return `${where} (no commits yet)`;
  return `${where} (${o.commit_count.toLocaleString()} ${o.commit_count === 1 ? "Commit" : "Commits"})`;
});

// Selecting a ref in the sidebar shows its history; Workspace › History goes back to
// HEAD. A stash opens in the Stashes view. Other items (folders, Settings, …) leave
// the history pane as it is.
const HISTORY_KINDS = ["branch", "remote-branch", "tag"];

// The current branch's history is shown by selecting that branch in the sidebar.
// "workspace:history" is HEAD's history without a sidebar row, for a detached HEAD.
function headHistoryKey(o) {
  return o?.head.branch ? `branch:${o.head.branch}` : "workspace:history";
}

// Checking out another branch while looking at the current one follows it there.
watch(
  () => overview.value?.head.branch,
  (branch, previous) => {
    if (previous && selected.value === `branch:${previous}`) selected.value = headHistoryKey(overview.value);
  },
);

watch(selected, (key) => {
  const [kind, name] = splitKey(key);
  if (key === "workspace:history") {
    historyRef.value = null;
  } else if (kind === "stash") {
    selectedStash.value = Number(name);
    selected.value = "workspace:stashes";
  } else if (HISTORY_KINDS.includes(kind)) {
    historyRef.value = { kind, name };
  }
});

// Commits can be squashed and reordered in the current branch's own full history,
// while nothing else is in progress.
const rewritable = computed(() => {
  const o = overview.value;
  const r = historyRef.value;
  const own = !r || (r.kind === "branch" && r.name === o?.head.branch);
  return !!(o?.head.branch && own && !fileFilter.value && !o.operation);
});

const historyRev = computed(() => {
  const r = historyRef.value;
  if (!r) return null;
  return {
    branch: `refs/heads/${r.name}`,
    "remote-branch": `refs/remotes/${r.name}`,
    tag: `refs/tags/${r.name}`,
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
  <GitMissing v-if="gitMissing" :status="gitStatus" :checking="checkingGit" @recheck="checkGit" />

  <div
    v-else-if="overview"
    class="window"
    :style="{ gridTemplateColumns: `${panes.sidebar}px minmax(280px, ${panes.history}px) minmax(320px, 1fr)` }"
  >
    <Sidebar
      v-model:selected="selected"
      :overview="overview"
      @open-repository="chooseRepository"
      @menu="sidebarMenu"
      @activate="sidebarActivate"
      @section-menu="(section, event) => actions.sectionMenu(section) && openMenu(event, actions.sectionMenu(section))"
      @merge-into-head="(name) => actions.merge(name)"
      @add-menu="(event) => openMenu(event, actions.addMenu())"
      @recent-menu="recentMenu"
    />

    <section v-if="isSettings" class="pane settings-pane">
      <div class="splitter" @pointerdown="startResize($event, 'sidebar', 200, 480)" />
      <SettingsView :path="overview.path" :name="overview.name" />
    </section>

    <section v-if="isGitHub" class="pane settings-pane">
      <div class="splitter" @pointerdown="startResize($event, 'sidebar', 200, 480)" />
      <GitHubView @clone="cloneRepository" />
    </section>

    <section v-show="!isFullView" class="pane history-pane">
      <div class="splitter" @pointerdown="startResize($event, 'sidebar', 200, 480)" />

      <header class="toolbar">
        <div class="nav-buttons">
          <button
            class="icon-button"
            :title="nav.back.length ? `Back to ${describe(nav.back.at(-1))} (Alt+←)` : 'Back'"
            :disabled="!nav.back.length"
            @click="go('back')"
          >
            <ChevronLeft :size="20" :stroke-width="1.5" />
          </button>
          <button
            class="icon-button"
            :title="nav.forward.length ? `Forward to ${describe(nav.forward.at(-1))} (Alt+→)` : 'Forward'"
            :disabled="!nav.forward.length"
            @click="go('forward')"
          >
            <ChevronRight :size="20" :stroke-width="1.5" />
          </button>
        </div>
        <div class="repo-title">
          <div class="repo-name">{{ overview.name }}</div>
          <div class="repo-subtitle">{{ subtitle }}</div>
        </div>
      </header>

      <div class="subheader">
        <span v-if="isWorkingCopy">Working Copy</span>
        <span v-else-if="isStashes">Stashes</span>
        <span v-else class="breadcrumb">
          <template v-for="(part, i) in breadcrumb" :key="i">
            <span v-if="i > 0" class="breadcrumb-sep">›</span>
            <span :class="{ dim: i > 0 }">{{ part }}</span>
          </template>
        </span>
        <span v-if="fileFilter && !isWorkingCopy && !isStashes" class="file-filter" :title="`Only commits that changed ${fileFilter}`">
          <span class="file-filter-name">{{ fileFilter.slice(fileFilter.lastIndexOf("/") + 1) }}</span>
          <button class="icon-button small" title="Show all commits" @click="fileFilter = null">
            <X :size="13" />
          </button>
        </span>
      </div>

      <OperationBanner
        v-if="overview.operation"
        :operation="overview.operation"
        :conflicts="overview.conflicts"
        :busy="remoteBusy"
        @action="actions.controlOperation"
      />

      <WorkingCopy
        v-if="isWorkingCopy"
        :draft="draft"
        :path="overview.path"
        :refresh-key="refreshKey"
        :selected-path="workingFile?.path"
        @select="workingFile = $event"
        @changed="refresh"
      />
      <StashList
        v-else-if="isStashes"
        :stashes="overview.stashes"
        :selected-index="selectedStash"
        :query="stashQuery"
        @select="selectedStash = $event"
        @menu="(index, event) => openMenu(event, actions.stashMenu(index))"
      />
      <!-- Hidden rather than removed, so the history keeps its scroll position. -->
      <div v-show="!isWorkingCopy && !isStashes" class="pane-body">
        <HistoryList
          :path="overview.path"
          :rev="historyRev"
          :file="fileFilter"
          :refresh-key="refreshKey"
          :selected-id="selectedCommit?.id"
          :editable="rewritable"
          @select="selectedCommit = $event"
          @menu="(commit, event) => openMenu(event, actions.commitMenu(commit))"
          @menu-many="(entries, event) => openMenu(event, actions.commitsMenu(entries, rewritable))"
          @move="actions.moveCommit"
        />
      </div>
    </section>

    <section v-show="!isFullView" class="pane detail-pane">
      <div class="splitter" @pointerdown="startResize($event, 'history', 360, 1000)" />

      <header class="toolbar actions">
        <div class="action-group">
          <button
            class="icon-button"
            :class="{ active: remoteOp?.kind === 'fetch' && remoteBusy }"
            title="Fetch from all remotes"
            :disabled="remoteBusy"
            @click="runRemote('fetch')"
          >
            <CloudDownload :size="18" :stroke-width="1.5" />
          </button>
          <button
            class="icon-button"
            :class="{ active: remoteOp?.kind === 'pull' && remoteBusy }"
            :title="headBranch?.upstream ? `Pull from ${headBranch.upstream}` : 'Pull'"
            :disabled="remoteBusy"
            @click="actions.pull()"
          >
            <ArrowDownToLine :size="18" :stroke-width="1.5" />
            <span v-if="headBranch?.behind" class="count-badge">{{ headBranch.behind }}</span>
          </button>
          <button
            class="icon-button"
            :class="{ active: remoteOp?.kind === 'push' && remoteBusy }"
            :title="headBranch?.upstream ? `Push to ${headBranch.upstream}` : 'Publish this branch'"
            :disabled="remoteBusy"
            @click="runRemote('push')"
          >
            <ArrowUpFromLine :size="18" :stroke-width="1.5" />
            <span v-if="headBranch?.ahead" class="count-badge">{{ headBranch.ahead }}</span>
          </button>
        </div>
        <div class="action-group">
          <button class="icon-button" title="New branch" :disabled="remoteBusy" @click="actions.newBranch()">
            <GitBranch :size="18" :stroke-width="1.5" />
          </button>
          <button
            class="icon-button"
            :title="overview.head.branch ? `Merge a branch into ${overview.head.branch}` : 'Check out a branch to merge into it'"
            :disabled="remoteBusy || !overview.head.branch || !!overview.operation"
            @click="actions.mergeInto()"
          >
            <GitMerge :size="18" :stroke-width="1.5" />
          </button>
        </div>
        <div class="action-group">
          <button
            class="icon-button"
            title="Stash changes"
            :disabled="remoteBusy || !overview.changes"
            @click="actions.stashSave()"
          >
            <Archive :size="18" :stroke-width="1.5" />
          </button>
          <button
            class="icon-button"
            :title="overview.stashes.length ? `Pop ${overview.stashes[0].message}` : 'No stashes to pop'"
            :disabled="remoteBusy || !overview.stashes.length"
            @click="actions.stashApply(0, true)"
          >
            <ArchiveRestore :size="18" :stroke-width="1.5" />
          </button>
        </div>
        <button class="icon-button" title="Refresh" @click="refresh">
          <RefreshCw :size="17" :stroke-width="1.5" :class="{ spinning: loading }" />
        </button>
        <label v-if="isStashes" class="toolbar-search stash-search">
          <Search :size="15" :stroke-width="1.5" />
          <input v-model="stashQuery" placeholder="Search for Stash Message" spellcheck="false" @keydown.esc="stashQuery = ''" />
        </label>
        <FileSearch v-else :path="overview.path" :refresh-key="refreshKey" @pick="showFileHistory" />
      </header>

      <template v-if="isWorkingCopy">
        <div class="subheader">
          <span class="file-title">{{ workingFile?.path }}</span>
        </div>
        <ConflictView v-if="workingFile?.conflicted" :path="overview.path" :file="workingFile" @changed="refresh" />
        <WorkingFileDiff v-else-if="workingFile" :path="overview.path" :file="workingFile" @changed="refresh" />
        <div v-else class="empty-state">
          <p>Select a file to see its changes.</p>
        </div>
      </template>

      <template v-else>
        <div class="subheader">
          <span class="mono dim">{{ detailCommit?.short_id }}</span>
          <div class="segmented">
            <button :class="{ active: detailMode === 'changeset' }" @click="detailMode = 'changeset'">Changeset</button>
            <button :class="{ active: detailMode === 'tree' }" title="Every file at this commit" @click="detailMode = 'tree'">
              Tree
            </button>
          </div>
        </div>

        <template v-if="detailCommit">
          <TreeView
            v-if="detailMode === 'tree'"
            :path="overview.path"
            :commit="detailCommit"
            :reveal="isStashes ? null : (fileFilter ?? treeReveal)"
            @file-opened="onTreeFileOpened"
            @show-commit="showBlamedCommit"
          />
          <CommitDetails
            v-else
            :path="overview.path"
            :commit="detailCommit"
            :stash="isStashes"
            :focus-file="focusFile"
          />
        </template>
        <div v-else class="empty-state">
          <p>{{ isStashes ? "Select a stash to see its changes." : "Select a commit to see its details." }}</p>
        </div>
      </template>
    </section>

  </div>

  <main v-else-if="browsingGitHub" class="github-page">
    <GitHubView standalone @clone="cloneRepository" @back="browsingGitHub = false" />
  </main>

  <main v-else class="welcome">
    <div class="welcome-card">
      <FolderGit2 :size="44" :stroke-width="1.25" class="welcome-icon" />
      <h1>Palace</h1>
      <p class="dim">Open a Git repository to get started.</p>

      <p v-if="error" class="error"><CircleAlert :size="15" /> {{ error }}</p>

      <div class="welcome-buttons">
        <button class="primary-button" :disabled="loading" @click="chooseRepository">
          {{ loading ? "Opening…" : "Open Repository…" }}
        </button>
        <button class="secondary-button" :disabled="loading" @click="browsingGitHub = true">Clone Repository…</button>
      </div>

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

  <!-- Overlays, shown over whichever screen is up. -->
  <FormDialog v-if="formDialog" :key="formDialog.title" :dialog="formDialog" />
  <TagDialog v-if="tagDialog" :dialog="tagDialog" />
  <PullDialog v-if="pullDialog" :dialog="pullDialog" />
  <MergeDialog v-if="mergeDialog" :dialog="mergeDialog" />
  <ResetDialog v-if="resetDialog" :dialog="resetDialog" />
  <CloneDialog v-if="cloneDialog" :dialog="cloneDialog" />
  <ConfirmDialog v-if="confirmDialog" :dialog="confirmDialog" />
  <UpdateNotice />
  <ContextMenu v-if="contextMenu" :menu="contextMenu" />

  <RemoteStatus
    v-if="remoteOp"
    :operation="remoteOp"
    @cancel="invoke('cancel_remote')"
    @dismiss="remoteOp = null"
    @action="(action) => { remoteOp = null; action.run(); }"
  />
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
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.action-group .icon-button {
  position: relative;
}

.action-group .icon-button.active {
  color: var(--accent);
  opacity: 1;
}

/* How many commits there are to pull or push. */
.count-badge {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  color: white;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
}

.action-group {
  display: flex;
  border-radius: 8px;
  background: var(--toolbar-group-bg);
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

.file-filter {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  margin-right: auto;
  margin-left: 10px;
  padding: 1px 2px 1px 9px;
  border-radius: 6px;
  background: var(--pill-bg);
  font-size: 12.5px;
}

.file-filter-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.stash-search {
  width: 220px;
  min-width: 120px;
  flex-shrink: 1;
}

.settings-pane {
  grid-column: 2 / -1;
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

.welcome-buttons {
  display: flex;
  gap: 10px;
}

.github-page {
  display: flex;
  height: 100vh;
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
