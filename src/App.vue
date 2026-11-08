<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  ExternalLink,
  EyeOff,
  GitBranch,
  GitCommitVertical,
  GitMerge,
  Search,
  SquareTerminal,
  X,
} from "lucide-vue-next";
import CommitDetails from "./components/CommitDetails.vue";
import CompareBar from "./components/CompareBar.vue";
import ConflictView from "./components/ConflictView.vue";
import FileEditor from "./components/FileEditor.vue";
import FileTree from "./components/FileTree.vue";
import ContextMenu from "./components/ContextMenu.vue";
import CloneDialog from "./components/CloneDialog.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import GitHubView from "./components/GitHubView.vue";
import IssueDetails from "./components/IssueDetails.vue";
import IssueList from "./components/IssueList.vue";
import Spinner from "./components/Spinner.vue";
import GitMissing from "./components/GitMissing.vue";
import StashList from "./components/StashList.vue";
import FormDialog from "./components/FormDialog.vue";
import MergeDialog from "./components/MergeDialog.vue";
import PullDialog from "./components/PullDialog.vue";
import ResetDialog from "./components/ResetDialog.vue";
import HistoryList from "./components/HistoryList.vue";
import OperationBanner from "./components/OperationBanner.vue";
import FolderGoneBanner from "./components/FolderGoneBanner.vue";
import CopyText from "./components/CopyText.vue";
import SearchHint from "./components/SearchHint.vue";
import RemoteStatus from "./components/RemoteStatus.vue";
import NewPullRequestDialog from "./components/NewPullRequestDialog.vue";
import SettingsView from "./components/SettingsView.vue";
import StarNotice from "./components/StarNotice.vue";
import Sidebar from "./components/Sidebar.vue";
import TagDialog from "./components/TagDialog.vue";
import TerminalNotices from "./components/TerminalNotices.vue";
import ToolbarSearch from "./components/ToolbarSearch.vue";
import TreeView from "./components/TreeView.vue";
import UpdateNotice from "./components/UpdateNotice.vue";
import WelcomeView from "./components/WelcomeView.vue";
import WorkingCopy from "./components/WorkingCopy.vue";
import WorkingFileDiff from "./components/WorkingFileDiff.vue";
import ReviewTray from "./components/ReviewTray.vue";
import { clearComments, commentsIn, deleteComments, reviewMessage } from "./lib/review.js";
import { folderName } from "./lib/format.js";
import { FILTER_RECENTS, RECENTS_KEY, forgetGoneRepositories, forgetRepositories, lastRepository, recentRepositories, rememberRepository } from "./lib/recents.js";
import {
  onSavedElsewhere,
  readJson,
  setStoreAside,
  storeProblem,
  writeJson,
} from "./lib/storage.js";
import { useGitActions } from "./lib/gitActions.js";
import { useUndo } from "./lib/undo.js";
import { useStatusCard } from "./lib/statusCard.js";
import { useBackgroundFetch } from "./lib/backgroundFetch.js";
import { useIssueRepo } from "./lib/issueRepo.js";
import { useNavigation } from "./lib/navigation.js";
import { splitKey } from "./lib/sidebarKeys.js";
import {
  askConfirm,
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
  tell,
} from "./lib/overlays.js";
import { cloneFolder, rememberCloneFolder } from "./lib/clone.js";
import { loadAvatars } from "./lib/avatars.js";
import { settings } from "./lib/settings.js";
import { dragEdge } from "./lib/resize.js";
import { useShortcuts } from "./lib/shortcuts.js";
import { useTerminalPanel } from "./lib/terminalPanel.js";
import { useRepository } from "./lib/repository.js";
import { useAppMenu } from "./lib/appMenu.js";
import { useGitRun } from "./lib/gitRun.js";
import { useLostCommits } from "./lib/lostCommits.js";
import { allAgentStates } from "./lib/agentStates.js";
import { fileManager, isMac, shortcut } from "./lib/platform.js";
import { starRequest } from "./lib/star.js";
import { githubAccount } from "./lib/github.js";
import { finishSaving, focusOnOpen, forgetEdits, openFiles, renameEdits, unsavedFiles } from "./lib/editing.js";
import { githubRemoteOf } from "./lib/githubRemote.js";
import { issueError } from "./lib/issues.js";
import { pullRequestPlan } from "./lib/pullRequests.js";
import { updateNoticeShown } from "./lib/updates.js";

// --- State shared across views -----------------------------------------------------

const overview = ref(null);
const loading = ref(false);
const error = ref("");
const recents = ref(recentRepositories());
// While the last repository reopens at startup, so the welcome screen doesn't flash up
// first.
const starting = ref(recents.value.length > 0);
const selected = ref("workspace:history");
// The ref whose history is shown, as { kind, name }; null means HEAD.
const historyRef = ref(null);
const selectedCommit = ref(null);
const refreshKey = ref(0);
const workingFile = ref(null);
// The commit being written, kept while switching between views. While amending,
// `saved` holds the draft that was there before, to restore if amending is undone.
const draft = reactive({ subject: "", body: "", amend: false, saved: null });
// Other repositories' drafts, kept for when they're open again: path → draft.
const otherDrafts = new Map();

// --- History and commit details ----------------------------------------------------

// Set when the history shows only the commits that changed this file.
const fileFilter = ref(null);

// Whether the history shows only the mainline, each merge standing for the commits it
// brought in, as `git log --first-parent` does. Remembered for each repository.
const FIRST_PARENT_KEY = "palace.firstParent";
const firstParent = ref(false);
watch(
  () => overview.value?.path,
  (path) => (firstParent.value = !!readJson(FIRST_PARENT_KEY, {})[path]),
  { immediate: true },
);

function toggleFirstParent() {
  firstParent.value = !firstParent.value;
  const saved = readJson(FIRST_PARENT_KEY, {});
  if (firstParent.value) saved[overview.value.path] = true;
  else delete saved[overview.value.path];
  writeJson(FIRST_PARENT_KEY, saved);
}

// The detail pane shows a commit's changes, or all its files ("tree").
const detailMode = ref("changeset");
// The file open in a commit's Files tab, a file for it to open (going Back to it, say), and
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

// --- Views, and comparing ----------------------------------------------------------

const isWorkingCopy = computed(() => selected.value === "workspace:working-copy");
const isSettings = computed(() => selected.value === "workspace:settings");
const isGitHub = computed(() => selected.value === "workspace:github");
// Views that take the place of both the history and detail panes.
const isFullView = computed(() => isSettings.value || isGitHub.value);
// The GitHub view opened from the welcome screen, before any repository is open.
const browsingGitHub = ref(false);
// Settings opened from the welcome screen, as by About Palace.
const browsingSettings = ref(false);
const settingsView = ref(null);
const isStashes = computed(() => selected.value === "workspace:stashes");
const isFiles = computed(() => selected.value === "workspace:files");
// The views that list the changed files, which the overview then brings, so each
// refresh reads the status once rather than once for it and again for them.
const listsFiles = computed(() => isWorkingCopy.value || isFiles.value);
const isIssues = computed(() => selected.value === "workspace:issues");
const isPulls = computed(() => selected.value === "workspace:pulls");
// Comparing two revisions: the history lists what `head` has that `base` doesn't,
// and with no commit chosen, the detail pane shows all of `head`'s changes.
const isCompare = computed(() => selected.value === "workspace:compare");
const comparison = ref(null);
// Views without a history of their own to search or filter.
const awayFromHistory = () =>
  isWorkingCopy.value || isFiles.value || isFullView.value || isStashes.value || isIssues.value || isPulls.value || isCompare.value;

function openComparison({ base, head }) {
  comparison.value = { base, head };
  selected.value = "workspace:compare";
  selectedCommit.value = null;
  fileFilter.value = null;
  historySearch.value = "";
}

function closeComparison() {
  selected.value = headHistoryKey(overview.value);
}

// Ctrl- or Shift-clicking a branch or tag in the sidebar compares it with the one
// already selected, or while comparing, puts it in place of the newer side.
function compareWith(key) {
  const [, name] = splitKey(key);
  if (isCompare.value && comparison.value) {
    if (name !== comparison.value.base) openComparison({ base: comparison.value.base, head: name });
    return;
  }
  const [kind, first] = splitKey(selected.value);
  if (HISTORY_KINDS.includes(kind) && first !== name) {
    openComparison({ base: first, head: name });
  } else {
    selected.value = key;
  }
}

// The sidebar rows of the two sides being compared.
const comparedKeys = computed(() => {
  const c = comparison.value;
  if (!isCompare.value || !c) return [];
  const o = overview.value;
  const keyOf = (name) =>
    o.branches.some((b) => b.name === name)
      ? `branch:${name}`
      : o.tags.includes(name)
        ? `tag:${name}`
        : `remote-branch:${name}`;
  return [keyOf(c.base), keyOf(c.head)];
});

// --- Issues and Pull Requests views ------------------------------------------------

// The Issues and Pull Requests views: what's chosen and searched for in each. Which
// repository on GitHub they show, and how many are open, is issueRepo.js's.
const selectedIssue = shallowRef(null);
const issueQuery = ref("");
// The last issue changed in the issue view, for the list to show.
const updatedIssue = shallowRef(null);
// The Pull Requests view, alongside: the same repository's pull requests, read the
// way issues are.
const selectedPull = shallowRef(null);
const pullQuery = ref("");
const updatedPull = shallowRef(null);

const {
  issueRemotes,
  showsIssues,
  issueRepos,
  issueRepo,
  issueRepoMenu,
  hasIssues,
  hasPulls,
  openIssues,
  openPulls,
  freshIssues,
  issuesSeenBefore,
  countStateChange,
} = useIssueRepo({
  overview,
  isIssues,
  isPulls,
  // What was chosen in another repository's issues goes with it.
  onChange: () => {
    selectedIssue.value = null;
    selectedPull.value = null;
  },
});

// Signing out while looking at them goes back to the history.
watch(showsIssues, (shown) => {
  if (!shown && overview.value && (isIssues.value || isPulls.value)) selected.value = headHistoryKey(overview.value);
});
// Turned off while showing, it goes back to the history.
watch([hasIssues, hasPulls], ([issues, pulls]) => {
  if (overview.value && ((!issues && isIssues.value) || (!pulls && isPulls.value))) selected.value = headHistoryKey(overview.value);
});
// A repository whose GitHub remotes go away leaves the Issues and Pull Requests views.
watch(
  () => issueRemotes.value.length,
  (count) => {
    if (!count && (isIssues.value || isPulls.value)) selected.value = headHistoryKey(overview.value);
  },
);

function onIssueUpdated(issue) {
  // "#123" can open a pull request here, which counts toward the open pull requests.
  countStateChange(issue.pull_request ? "pulls" : "issues", selectedIssue.value?.state, issue.state);
  selectedIssue.value = issue;
  updatedIssue.value = issue;
}

function onIssueCreated(issue) {
  countStateChange("issues", undefined, "open");
  selectedIssue.value = issue;
}

// From "#123" in a commit message to that issue: in the Issues view, or on GitHub
// when Palace isn't signed in.
async function showIssue(number) {
  const repo = issueRepo.value ?? issueRemotes.value[0];
  if (!repo) return;
  // Signed out, or with issues off here, as for a pull request's number: on GitHub.
  if (!githubAccount.value || !hasIssues.value) {
    openUrl(`https://github.com/${repo.owner}/${repo.repo}/issues/${number}`);
    return;
  }
  try {
    const { issue } = await invoke("github_issue", { owner: repo.owner, repo: repo.repo, number });
    selected.value = "workspace:issues";
    selectedIssue.value = issue;
  } catch (e) {
    tell(`Couldn't open issue #${number}`, issueError(e).text);
  }
}

function onPullUpdated(pull) {
  countStateChange("pulls", selectedPull.value?.state, pull.state);
  selectedPull.value = pull;
  updatedPull.value = pull;
}

// After a pull request is merged here, the merge is fetched, and the local branch
// that tracked it is offered for deleting: from wherever it's checked out, by going
// to the branch it was merged into.
async function onPullMerged({ number, base, head, headRepo, headSha, branchDeleted }) {
  const remotes = overview.value.remotes;
  const headRemote = githubRemoteOf(remotes, headRepo);
  const baseRemote = githubRemoteOf(remotes, issueRepo.value && `${issueRepo.value.owner}/${issueRepo.value.repo}`);
  const local = headRemote && overview.value.branches.find((b) => b.upstream === `${headRemote.name}/${head}`);
  for (const remote of new Set([baseRemote?.name, headRemote?.name].filter(Boolean))) {
    await runGit(["Fetching…", "Fetched", "Fetch failed"], "fetch", { remote });
  }

  const offers = [];
  // Deleting is forced, since a squash or rebase leaves the branch looking unmerged,
  // so a branch with commits that weren't in the pull request is kept.
  const path = overview.value.path;
  const unpushed =
    local && !(await invoke("branch_within", { path, branch: local.name, commit: headSha }).catch(() => false));
  if (local && !unpushed && local.name !== overview.value.head.branch) {
    offers.push({ label: `Delete “${local.name}”`, run: () => actions.deleteMergedBranch(local.name, headSha) });
  } else if (local && !unpushed) {
    const into =
      overview.value.branches.find((b) => baseRemote && b.upstream === `${baseRemote.name}/${base}`) ??
      overview.value.branches.find((b) => b.name === base);
    if (into) {
      offers.push({
        label: `Switch to “${into.name}” and Delete “${local.name}”`,
        run: async () => (await actions.checkout("branch", into.name)) || actions.deleteMergedBranch(local.name, headSha),
      });
    }
  }
  showStatus(
    {
      title: `Merged pull request #${number}`,
      state: "done",
      message: [
        branchDeleted ? `Merged into ${base}, and deleted ${head} on GitHub.` : `Merged into ${base}.`,
        unpushed && `Your local “${local.name}” has commits that weren't in the pull request, so it's been kept.`,
      ]
        .filter(Boolean)
        .join(" "),
      actions: offers,
    },
    { dismissAfter: 15_000 },
  );
}

// Checks out a pull request: from the remote its branch is on, or, from a fork no
// remote points at, GitHub's copy of it in this repository.
function checkoutPull({ number, head, headRepo }) {
  const remotes = overview.value.remotes;
  const headRemote = githubRemoteOf(remotes, headRepo);
  if (headRemote) return actions.checkoutPull(headRemote.name, number, head);
  const full = issueRepo.value && `${issueRepo.value.owner}/${issueRepo.value.repo}`;
  const baseRemote = githubRemoteOf(remotes, full);
  if (baseRemote) return actions.checkoutPull(baseRemote.name, number, null);
  tell("Couldn't Check Out the Pull Request", `None of this repository's remotes is ${full ?? "on GitHub"}.`);
}

// --- Stashes, and searching the history --------------------------------------------

// The Stashes view: the chosen stash (by index) and the search for one by message.
const selectedStash = ref(null);
const stashQuery = ref("");
// The toolbar search's "Show all matching commits" narrows the history to this search.
const historySearch = ref("");
// How many commits the history lists, shown as the number of matches while searching.
const historyCount = ref(null);
const toolbarSearch = ref(null);
// The Stashes, Issues or Pull Requests view's own search, whichever is showing.
const viewSearch = ref(null);

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
  historySearch.value = "";
  selectedCommit.value = null;
  if (awayFromHistory()) selected.value = headHistoryKey(overview.value);
}

// The toolbar search looks through the history being shown, or HEAD's from elsewhere.
const searchRev = computed(() => (awayFromHistory() ? null : historyRev.value));

function showFoundCommit(commit) {
  if (awayFromHistory()) selected.value = headHistoryKey(overview.value);
  // Filters could hide the commit.
  fileFilter.value = null;
  historySearch.value = "";
  selectedCommit.value = { id: commit.id, short_id: commit.short_id, refs: [] };
  detailMode.value = "changeset";
}

function showMatchingCommits(query) {
  if (awayFromHistory()) selected.value = headHistoryKey(overview.value);
  fileFilter.value = null;
  historySearch.value = query;
}

// --- Back and Forward --------------------------------------------------------------
// See navigation.js. The Back and Forward buttons are in the toolbar; Alt+arrows, below,
// and a mouse's back and forward buttons go too.
const { nav, go, describe, forget: forgetPlaces } = useNavigation({
  overview,
  view: { selected, selectedCommit, selectedStash, fileFilter, detailMode, treeFile, treeReveal, comparison },
  fileShown: () => (isFiles.value && overview.value ? (openFiles[overview.value.path] ?? null) : null),
  showFile: (file) => (openFiles[overview.value.path] = file),
});

// --- Keyboard shortcuts ------------------------------------------------------------

// Goes to the view's search in the toolbar, its text selected to be typed over, and
// says whether there was one: files and commits, or stashes, issues or pull requests.
function focusToolbarSearch() {
  // Hidden, as with Settings filling the window, there's none to go to.
  if (isFullView.value) return false;
  if (toolbarSearch.value) {
    toolbarSearch.value.focus();
    return true;
  }
  const input = viewSearch.value;
  input?.focus();
  input?.select();
  return !!input;
}

const inTextField = (target) => !!target.closest?.("input, textarea, select, [contenteditable]");
const dialogOpen = () =>
  [formDialog, confirmDialog, contextMenu, mergeDialog, pullDialog, resetDialog, tagDialog, cloneDialog, pullRequestDialog].some((d) => d.value);

// The window's keyboard shortcuts: which key is which, and where each applies, is in
// shortcuts.js; what each does is here.
useShortcuts(
  (event) => ({
    inTerminal: !!event.target.closest?.(".terminal-panel"),
    inTextField: inTextField(event.target),
    inEditor: !!event.target.closest?.(".cm-editor"),
    dialogOpen: dialogOpen(),
    repository: !!overview.value,
  }),
  {
    newWindow: () => {
      newWindow();
    },
    terminal: ({ inTerminal }) => {
      if (inTerminal && terminalOpen.value) terminalOpen.value = false;
      else showTerminal();
    },
    newTerminalTab: () => {
      showTerminal({ newTab: true });
    },
    undo: () => {
      undo();
    },
    redo: () => {
      redo();
    },
    refresh: () => {
      refreshAndFetch();
    },
    findFile: () => {
      selected.value = "workspace:files";
      nextTick(() => toolbarSearch.value?.focus());
    },
    // With no search showing, the key is left alone.
    search: () => focusToolbarSearch(),
    settings: () => {
      selected.value = "workspace:settings";
    },
    back: () => {
      go("back");
    },
    forward: () => {
      go("forward");
    },
  },
);

// --- Running git operations --------------------------------------------------------

// The status card; see statusCard.js. remoteBusy is whether an operation is running,
// which most others wait for.
const {
  card: remoteOp,
  busy: remoteBusy,
  show: showStatus,
  dismissLater: dismissStatusLater,
  dismiss: dismissStatus,
} = useStatusCard();

// The current branch, for the toolbar's Pull and Push buttons: where they go, and how far
// behind or ahead it is.
const headBranch = computed(() => overview.value?.branches.find((b) => b.is_head) ?? null);

// Running git operations, one at a time, each shown in the status card: see gitRun.js.
// What's passed in here is used only once an operation runs, so it's looked up then:
// undo, the background fetch and refresh come later in this file, and undo runs its
// own steps through runGit.
const { runGit } = useGitRun({
  overview,
  status: { busy: remoteBusy, show: showStatus, dismissLater: dismissStatusLater, dismiss: dismissStatus },
  undo: {
    stepFor: (...args) => stepFor(...args),
    newest: () => newest(),
    undoable: (...args) => undoable(...args),
    undo: () => undo(),
  },
  stopBackgroundFetch: () => stopBackgroundFetch(),
  refresh: () => refresh(),
  // Conflicts are resolved in the Working Copy.
  onConflict() {
    selected.value = "workspace:working-copy";
  },
  onDone(op, command, args) {
    if (command === "push" || command === "publish_branch") offerPullRequest(op, args.branch ?? overview.value.head.branch);
    // Fetching and pulling can bring in commits by new authors.
    if (command === "fetch" || command === "pull") {
      loadAvatars(overview.value.path);
      markFetched(overview.value.path);
    }
  },
  pull: () => actions.pull(),
  forcePush: () => actions.forcePush(),
});

const REMOTE_TITLES = {
  fetch: ["Fetching…", "Fetched", "Fetch failed"],
  pull: ["Pulling…", "Pulled", "Pull failed"],
};

const runRemote = (kind) => runGit(REMOTE_TITLES[kind], kind);

// Fetch, and Cmd+R (Ctrl+R), reload the repository at once, then fetch from its
// remotes, which reloads it again with what came in. Otherwise Palace keeps itself
// current: the file watcher, coming back to the window and background fetches.
function refreshAndFetch() {
  refresh();
  if (overview.value?.remotes.length && !remoteBusy.value) runRemote("fetch");
}

// Branches that lose commits outside this window, as to an agent's `git reset --hard`,
// are said to have, with a way to have them back: see lostCommits.js.
useLostCommits({
  overview,
  // Looked up when it's called: useRepository, which makes it, comes later.
  loadsStarted: () => loadsStarted(),
  busy: () => remoteBusy.value,
  show: (card) => showStatus(card),
  run: (...args) => runGit(...args),
});

// --- Background fetch --------------------------------------------------------------

// See backgroundFetch.js. Whatever the user runs stops a background fetch first.
const {
  stop: stopBackgroundFetch,
  markFetched,
  fetchTitle,
} = useBackgroundFetch({
  overview,
  busy: () => remoteBusy.value,
  loading: () => loading.value,
  // Looked up when it's called: useRepository, which makes it, comes later.
  refresh: () => refresh(),
});

// --- Undo and redo -----------------------------------------------------------------

// See undo.js. Undo and redo run through runGit, and the notice for what just
// finished offers them.
const { newest, stepFor, undoable, undo, redo, switchRepository } = useUndo({
  overview,
  run: runGit,
  busy: () => remoteBusy.value,
  draft,
  settle: stopBackgroundFetch,
  offer: (label, run) => {
    if (remoteOp.value?.state === "done") remoteOp.value.actions = [{ label, run }];
  },
});

// What the Working Copy and diffs do runs through undoable directly, so it's followed by
// the notice the toolbar's operations get (see runGit), offering to undo it. Undo and
// redo are there and on Cmd+Z and Cmd+Shift+Z (Ctrl on Linux), not in the toolbar,
// where they sat greyed out beside text whose own undo they don't touch.
const DONE = { Discard: "Discarded", Commit: "Committed", Amend: "Amended", Stash: "Stashed" };
const UNDO_OFFERED_FOR = 8000;

async function undoableWithNotice(step, work) {
  const before = newest();
  const result = await undoable(step, work);
  if (newest() !== before && !remoteBusy.value) {
    showStatus(
      {
        command: "undoable",
        title: DONE[step.label] ?? `${step.label}: done`,
        line: "",
        state: "done",
        message: "",
        cancellable: false,
        actions: [{ label: "Undo", run: undo }],
      },
      { dismissAfter: UNDO_OFFERED_FOR },
    );
  }
  return result;
}

// --- Creating pull requests --------------------------------------------------------

// They go where issues do: origin's repository, or the one it was forked from.
const pullTarget = () => issueRepo.value ?? issueRemotes.value[0] ?? null;
// The Create Pull Request dialog's plan (see pullRequestPlan), while it's open.
const pullRequestDialog = shallowRef(null);

// Opens the Create Pull Request dialog for a local branch. Without a GitHub account,
// the branch is pushed if it needs to be, then GitHub's own page for it opens.
async function createPullRequest(name) {
  if (!name) {
    tell("No Branch Checked Out", "Check out the branch you want to create a pull request for, then try again.");
    return;
  }
  const plan = pullRequestPlan(overview.value, pullTarget(), name);
  if (!plan) {
    tell("Can't Create a Pull Request", `“${name}” is pushed to a remote that isn't on GitHub.`);
    return;
  }
  if (githubAccount.value) {
    pullRequestDialog.value = plan;
    return;
  }
  if (plan.push && (await pushForPullRequest(plan))) return;
  const { owner, repo } = plan.target;
  openUrl(`https://github.com/${owner}/${repo}/compare/${encodeURIComponent(plan.head)}?expand=1`);
}

// Pushes the branch a pull request is for, resolving to an error message or null.
// Toolbar pushes only go from the current branch; publishing goes from any.
function pushForPullRequest(plan) {
  if (plan.push === "push" && plan.branch === overview.value.head.branch) {
    return runGit(["Pushing…", "Pushed", "Push failed"], "push");
  }
  return runGit(["Pushing…", "Pushed", "Push failed"], "publish_branch", { branch: plan.branch, remote: plan.remote, name: plan.name });
}

function onPullRequestClosed(pull) {
  pullRequestDialog.value = null;
  if (!pull) return;
  showStatus(
    {
      title: `Created pull request #${pull.number}`,
      state: "done",
      message: pull.title,
      actions: [{ label: "Open on GitHub", run: () => openUrl(pull.html_url) }],
    },
    { dismissAfter: 10_000 },
  );
}

// After a branch is pushed, the status card offers to create a pull request for it,
// or to view the one it has. Not for the repository's main branch, or while the
// dialog is the one pushing.
async function offerPullRequest(op, branch) {
  if (!githubAccount.value || !branch || pullRequestDialog.value || !issueRemotes.value.length || !hasPulls.value) return;
  await loadRepository(overview.value.path, { quiet: true });
  const plan = pullRequestPlan(overview.value, pullTarget(), branch);
  if (!plan || plan.push) return;
  const { owner, repo } = plan.target;
  const info = await invoke("github_branch_pull", { owner, repo, head: plan.head }).catch(() => null);
  if (!info || plan.head === info.default_branch || remoteOp.value !== op) return;
  const offer = info.pull
    ? { label: "View Pull Request", run: () => openUrl(info.pull.html_url) }
    : { label: "Create Pull Request…", run: () => createPullRequest(branch) };
  op.actions = [...(op.actions ?? []), offer];
  // Long enough to be noticed.
  dismissStatusLater(op, 10_000);
}

// --- Git actions and the sidebar ---------------------------------------------------

const actions = useGitActions({
  overview,
  run: runGit,
  compare: openComparison,
  pullRequest: { available: () => issueRemotes.value.length > 0 && hasPulls.value, create: createPullRequest },
  viewedBranch: () => {
    const r = historyRef.value;
    return r?.kind === "branch" && r.name !== overview.value?.head.branch ? r.name : null;
  },
  openWorktree,
  // Looked up when it's called: the terminal panel, which makes it, comes later.
  agentReady: () => agentReady(),
});

// Context menus for sidebar rows, keyed the same way the sidebar keys them.
function sidebarMenu(row, event) {
  const [kind, name] = splitKey(row.key);
  const items = {
    branch: () => actions.branchMenu(name),
    "branch-divider": () => actions.dividerMenu(row.key, row.label),
    "remote-branch": () => actions.remoteBranchMenu(name),
    tag: () => actions.tagMenu(name),
    stash: () => actions.stashMenu(Number(name)),
    worktree: () => actions.worktreeMenu(name),
    // A remote's own row, not a folder of its branches ("origin/feature/").
    remote: () => {
      const remote = name.replace(/\/$/, "");
      return overview.value.remotes.some((r) => r.name === remote) ? actions.remoteMenu(remote) : null;
    },
  }[kind]?.();
  if (items) openMenu(event, items);
}

// Double-clicking a branch checks it out, or if it's checked out in another worktree,
// opens that. Double-clicking a worktree opens it.
function sidebarActivate(row) {
  const [kind, name] = splitKey(row.key);
  const elsewhere = kind === "branch" && overview.value.branches.find((b) => b.name === name)?.worktree;
  if (elsewhere) return openWorktree(elsewhere);
  if (kind === "worktree") return name !== overview.value.path && openWorktree(name);
  if (kind === "branch" && name !== overview.value.head.branch) switchTo(row.key, "branch", name);
  if (kind === "remote-branch") switchTo(row.key, "remote-branch", name);
}

// The sidebar row of a branch being checked out by double-clicking it: switching takes
// a moment in a large repository, so the row shows it at once, as current, with a
// spinner, until the sidebar shows the new HEAD (or the checkout fails).
const switching = ref(null);
async function switchTo(key, kind, name) {
  if (switching.value || remoteBusy.value) return;
  switching.value = key;
  const error = await actions.checkout(kind, name);
  if (error) {
    switching.value = null;
    return;
  }
  // Once the refresh after it brings the new HEAD in; if that never comes, soon anyway.
  const stop = watch(
    () => overview.value?.head?.branch,
    () => done(),
  );
  const timer = setTimeout(() => done(), 10000);
  function done() {
    stop();
    clearTimeout(timer);
    if (switching.value === key) switching.value = null;
  }
}

// --- Windows and live refresh ------------------------------------------------------

// Live refresh: the backend watches the open repository and reports changes made
// anywhere, such as saving a file in an editor or committing from a terminal.
watch(
  () => overview.value?.path,
  (path) => {
    // Other windows show this one instead of opening the repository again, and the
    // window's title names it, to tell windows apart when switching between them.
    invoke("set_window_repo", { path: path ?? null }).catch(() => {});
    thisWindow.setTitle(path ? `${folderName(path)} — Palace` : "Palace").catch(() => {});
    if (!path) return;
    invoke("watch_repo", { path }).catch(() => {});
    loadAvatars(path);
  },
);

// Recent repositories opened in other windows join the list here too.
onBeforeUnmount(onSavedElsewhere((key) => key === RECENTS_KEY && (recents.value = recentRepositories())));

// Opens the worktree at `path` in a window of its own, or
// brings forward the window it's open in.
async function openWorktree(path, { task = null } = {}) {
  if (await invoke("show_window_with", { path }).catch(() => false)) return;
  invoke("new_window", { dark: document.documentElement.dataset.theme === "dark", path, task }).catch((e) =>
    tell("Couldn't Open the Worktree", String(e)),
  );
}

/** Opens a new window, to open another repository in, side by side with this one. */
const newWindow = () =>
  invoke("new_window", { dark: document.documentElement.dataset.theme === "dark" }).catch((e) =>
    tell("Couldn't Open a Window", String(e)),
  );

// Events for this window only: each window watches its own repository.
const thisWindow = getCurrentWebviewWindow();
const unlistenChanges = thisWindow.listen("repo-changed", () => refresh());
onBeforeUnmount(() => unlistenChanges.then((unlisten) => unlisten()));

// About Palace, from the menu: the top of Settings, in the repository open, or with
// none, on its own.
useAppMenu({
  window: thisWindow,
  showAbout: async () => {
    if (overview.value) selected.value = "workspace:settings";
    else browsingSettings.value = true;
    browsingGitHub.value = false;
    await nextTick();
    settingsView.value?.scrollToTop();
  },
});

// What each repository's agents are doing, in every window, by path (see agentStates.js),
// for Worktrees to show which is busy or wants you.
const agentStates = ref({});
// Listening first, then asking: a change sent meanwhile isn't overwritten by older news.
let heardAgents = false;
const unlistenAgents = listen("agent-states", ({ payload }) => {
  heardAgents = true;
  agentStates.value = allAgentStates(payload);
});
onBeforeUnmount(() => unlistenAgents.then((unlisten) => unlisten()));
unlistenAgents
  .then(() => invoke("agent_states"))
  .then((byWindow) => heardAgents || (agentStates.value = allAgentStates(byWindow)))
  .catch(() => {});

const unlistenProgress = thisWindow.listen("remote-progress", (event) => {
  if (remoteOp.value?.state === "running") {
    remoteOp.value.line = event.payload.line;
  }
});
onBeforeUnmount(() => unlistenProgress.then((unlisten) => unlisten()));

// --- Pane widths -------------------------------------------------------------------

const PANES_KEY = "palace.paneWidths";
const panes = reactive({ sidebar: 300, history: 580, terminal: 300, ...readJson(PANES_KEY, {}) });
const savePanes = () => writeJson(PANES_KEY, { sidebar: panes.sidebar, history: panes.history, terminal: panes.terminal });

function startResize(event, pane, min, max) {
  const startWidth = panes[pane];
  dragEdge(event, {
    axis: "x",
    move: (distance) => (panes[pane] = Math.min(max, Math.max(min, startWidth + distance))),
    done: savePanes,
  });
}

// --- Files view --------------------------------------------------------------------

// The Files view's tree, whose Ignored toggle is in the subheader above it.
const fileTree = ref(null);

// Opens a file in the Files view, to edit it, as from the Working Copy.
function openInFiles(file) {
  focusOnOpen();
  openFiles[overview.value.path] = file;
  selected.value = "workspace:files";
}

// A file deleted in the Files view, or a folder, closes if it's open, once the editor
// has let it go, and takes its edits not saved with it.
async function onFileDeleted(file) {
  const path = overview.value.path;
  const open = openFiles[path];
  if (open === file || open?.startsWith(`${file}/`)) openFiles[path] = null;
  await nextTick();
  forgetEdits(path, file);
}

// A file renamed in the Files view, or the folder it's in, stays open under its new
// name, its edits not saved with it. They move once the editor has let go of the old
// name, and before it opens the new one.
async function onFileRenamed({ from, to }) {
  const path = overview.value.path;
  const open = openFiles[path];
  if (open === from) openFiles[path] = to;
  else if (open?.startsWith(`${from}/`)) openFiles[path] = to + open.slice(from.length);
  await nextTick();
  renameEdits(path, from, to);
}

// --- Terminal panel ----------------------------------------------------------------

// The terminal panel below the history and details, loaded the first time it's opened,
// and the notices that a terminal's program finished or needs you: see terminalPanel.js.
const TerminalPanel = defineAsyncComponent(() => import("./components/TerminalPanel.vue"));
const {
  open: terminalOpen,
  loaded: terminalLoaded,
  unseen: terminalUnseen,
  panel: terminalPanel,
  toggle: toggleTerminal,
  show: showTerminal,
  pasteToAgent,
  agentReady,
  startTask,
  notices: terminalNotices,
  dismissNotice,
  openNotice,
} = useTerminalPanel({ overview, loadRepository: (path) => loadRepository(path), window: thisWindow });

// --- Quitting and closing the window -----------------------------------------------

// Quitting, or closing the window, with programs still running in terminals or edits
// not saved asks first, naming them (see quit.rs).
// Closing a window asks about its own; quitting, about every window's.
let askingToQuit = false;
const unlistenQuit = thisWindow.listen("quit-requested", async ({ payload }) => {
  // Palace goes ahead anyway on a second try if the page doesn't say it's asking.
  invoke("quit_asking").catch(() => {});
  if (askingToQuit) return;
  askingToQuit = true;
  const { quitting } = payload;
  // Saving automatically, edits are saved first, and only those that couldn't be are
  // asked about.
  if (settings.autoSave) await finishSaving();
  const doing = quitting ? "Quitting" : "Closing the window";
  const lines = [];
  const edited = unsavedFiles().map((f) => `“${f.file.split("/").pop()}” in ${folderName(f.path)}`);
  if (edited.length) {
    lines.push(`Edits to ${edited.join(", ")} aren't saved. ${doing} loses them.`);
  }
  if (payload.terminals.length) {
    const { describeTerminals } = await import("./lib/terminals.js");
    const names = describeTerminals(payload.terminals).map((t) => `“${t.label}” in ${t.repository}`);
    lines.push(
      names.length === 1
        ? `${names[0]} is still running. ${doing} stops it.`
        : `${names.length} terminals are still running: ${names.join(", ")}. ${doing} stops them.`,
    );
  }
  const elsewhere = [
    ...payload.other_edits.map((file) => `edits to ${file} aren't saved`),
    ...payload.other_terminals.map((folder) => `a terminal in ${folder} is still running`),
  ];
  if (elsewhere.length) {
    const said = elsewhere.join("; ");
    lines.push(`In other windows, ${said}. Quitting ${payload.other_edits.length ? "loses" : "stops"} ${elsewhere.length === 1 ? "it" : "them"}.`);
  }
  if (!lines.length) {
    askingToQuit = false;
    invoke("quit_confirmed", { quitting }).catch(() => {});
    return;
  }
  const ok = await askConfirm({
    title: quitting ? "Quit Palace?" : "Close Window?",
    message: lines.join("\n\n"),
    confirmLabel: quitting ? "Quit" : "Close",
    danger: true,
  });
  askingToQuit = false;
  if (ok) invoke("quit_confirmed", { quitting }).catch(() => {});
});
onBeforeUnmount(() => unlistenQuit.then((unlisten) => unlisten()));

// --- Review comments for the agent -------------------------------------------------

// Sends the repository's review comments to its agent: into the prompt of its agent
// tab, or a new one, for the user to add to and send. They're in the prompt then, all
// of them, so they go from here.
const sendingReview = ref(false);
async function sendReview() {
  const path = overview.value?.path;
  const comments = path ? [...commentsIn(path)] : [];
  if (!comments.length || sendingReview.value) return;
  sendingReview.value = true;
  try {
    if (await pasteToAgent(reviewMessage(comments))) deleteComments(path, comments.map((c) => c.id));
  } finally {
    sendingReview.value = false;
  }
}

async function clearReview() {
  const path = overview.value?.path;
  if (!path) return;
  const unsent = commentsIn(path).length;
  if (unsent) {
    const ok = await askConfirm({
      title: "Clear the Comments?",
      message: `${unsent === 1 ? "A comment hasn't" : `${unsent} comments haven't`} been sent yet. Clearing deletes ${unsent === 1 ? "it" : "them"}.`,
      confirmLabel: "Clear",
      danger: true,
    });
    if (!ok) return;
  }
  clearComments(path);
}

// --- Opening and refreshing repositories -------------------------------------------

// Opening the repository, and refreshing it as it changes: see repository.js. What's
// here is what the window does around it.
const { folderGone, loadRepository, refresh, loadsStarted } = useRepository({
  overview,
  loading,
  error,
  refreshKey,
  listsFiles,
  // Another repository: its views start afresh, and the commit message and undo steps
  // being written for the one before wait for it to come back.
  onSwitch(data) {
    selected.value = headHistoryKey(data);
    historyRef.value = null;
    selectedCommit.value = null;
    workingFile.value = null;
    fileFilter.value = null;
    selectedStash.value = null;
    stashQuery.value = "";
    issueQuery.value = "";
    pullQuery.value = "";
    historySearch.value = "";
    comparison.value = null;
    forgetPlaces();
    if (overview.value && (draft.subject || draft.body || draft.amend)) otherDrafts.set(overview.value.path, { ...draft });
    Object.assign(draft, { subject: "", body: "", amend: false, saved: null }, otherDrafts.get(data.path));
    otherDrafts.delete(data.path);
    switchRepository(overview.value?.path, data.path);
  },
  onLoaded(data) {
    // A repository open, Settings from the welcome screen is done with.
    browsingSettings.value = false;
    rememberRepository(data);
    recents.value = recentRepositories();
  },
  onNotRepository: (path, options) => offerToCreateRepository(path, options),
  onOpenFailed(path, e) {
    showStatus({
      title: "Couldn't open the repository",
      state: "failed",
      message: `${path}\n${e}`,
      actions: recents.value.some((r) => r.path === path) ? [{ label: "Remove from List", run: () => removeRecent(path) }] : [],
    });
  },
});
const isWorktree = computed(() => !!overview.value?.worktrees?.some((w) => w.current && !w.main));

// A folder chosen to open that isn't a repository can become one, then open.
async function offerToCreateRepository(path, options) {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const ok = await askConfirm({
    title: "Not a Git Repository",
    message: `“${name}” isn't a Git repository yet. Create one in it?\n\n${path}`,
    confirmLabel: "Create Repository",
  });
  if (!ok) return;
  try {
    await invoke("init_repo", { path });
  } catch (e) {
    tell("Couldn't Create the Repository", String(e));
    return;
  }
  await loadRepository(path, options);
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

// Opens the repository in the file manager, saying why if it can't.
function openOutside(command, failed) {
  invoke(command, { path: overview.value.path }).catch((e) => tell(failed, String(e)));
}

function recentMenu(anchor) {
  const current = overview.value?.path;
  const tidy = (path) => (home.value && path.startsWith(`${home.value}/`) ? `~${path.slice(home.value.length)}` : path);
  openMenu(anchor, [
    { label: "New Window", detail: shortcut("Ctrl+N"), action: newWindow },
    { separator: true },
    current && { label: `Open in ${fileManager}`, action: () => openOutside("open_folder", "Couldn't Open the Folder") },
    current && { label: "Open in Terminal", action: () => showTerminal({ newTab: true }) },
    current && { separator: true },
    recents.value.length > FILTER_RECENTS && { filter: "Find a repository", empty: "No matching repositories", rows: FILTER_RECENTS },
    ...recents.value.map((repo) => ({
      label: repo.name,
      detail: tidy(repo.path),
      checked: repo.path === current,
      filterable: true,
      action: () => repo.path !== current && loadRepository(repo.path, { keepOnError: true }),
    })),
    recents.value.length && { separator: true },
    { label: "Open Repository…", action: chooseRepository },
    { label: "Clone Repository…", action: () => cloneRepository() },
  ]);
}

function removeRecent(path) {
  forgetRepositories([path]);
  recents.value = recentRepositories();
}


// --- Checks at startup -------------------------------------------------------------

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
    // The repository this window had, as when its page reloads, or in the first window
    // at startup, the last one opened. A new window starts with none, to choose one.
    const start = await invoke("window_start").catch(() => ({ repo: null, first: true }));
    const reopen = start.repo ?? (start.first ? await lastRepository() : null);
    if (reopen) await loadRepository(reopen);
    // Repositories deleted since Palace last ran are taken off the list, once, by the
    // first window, without holding up what it opens.
    if (start.first) forgetGoneRepositories().then(() => (recents.value = recentRepositories()));
    // Opened for a task (New Agent Task): its agent starts on it, or, with the worktree not
    // open after all, the task's given back, so it isn't lost.
    if (start.task && overview.value) startTask(start.task);
    else if (start.task) tell("Couldn't Start the Task", `Its worktree didn't open. The task was:\n\n${start.task}`);
  }
  starting.value = false;
}

onMounted(checkGit);

// Saved settings that couldn't be read are left alone until a restart, rather than
// replaced by whatever's changed meanwhile.
onMounted(() => {
  if (!storeProblem) return;
  const op = showStatus({
    title: "Couldn't read your saved settings",
    state: "failed",
    message:
      `${storeProblem}\n\nUntil Palace restarts, changes to settings, recent repositories and the like aren't ` +
      "saved, so what's there isn't overwritten. If restarting doesn't help, Start Fresh renames the file, " +
      "keeping it, and saves the settings in use now in its place.",
    actions: [
      { label: "Restart Palace", run: () => invoke("restart_after_update") },
      {
        label: "Start Fresh",
        run: async () => {
          try {
            await setStoreAside();
            dismissStatus();
          } catch (e) {
            op.message = String(e);
          }
        },
      },
    ],
  });
});

// --- Which history is shown --------------------------------------------------------

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

// Commits can be squashed and reordered in the current branch's own full, unsearched history,
// while nothing else is in progress.
// Whether the history shown is the current branch's own.
const ownHistory = computed(() => {
  const r = historyRef.value;
  return !r || (r.kind === "branch" && r.name === overview.value?.head.branch);
});

const rewritable = computed(() => {
  const o = overview.value;
  // Not in the mainline view, where commits next to each other in the list may not be.
  const whole = !fileFilter.value && !historySearch.value && !firstParent.value;
  return !!(o?.head.branch && ownHistory.value && !isCompare.value && whole && !o.operation);
});

// Whether the history's commits can be dragged to the current branch, in the sidebar, to
// cherry-pick them there: another branch's, a tag's or a remote branch's, while there's
// a current branch and nothing waits on the user.
const pickable = computed(() => {
  const o = overview.value;
  return !!(o?.head.branch && !ownHistory.value && !isCompare.value && !o.operation);
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

// --- Toolbar title -----------------------------------------------------------------

const subtitle = computed(() => {
  const o = overview.value;
  if (!o) return "";
  if (isStashes.value) return `Stashes (${o.stashes.length} ${o.stashes.length === 1 ? "Stash" : "Stashes"})`;
  if (isIssues.value && issueRepo.value) {
    const open = openIssues.value == null ? "" : ` (${openIssues.value.toLocaleString()} Open)`;
    return `Issues on ${issueRepo.value.owner}/${issueRepo.value.repo}${open}`;
  }
  if (isPulls.value && issueRepo.value) {
    const open = openPulls.value == null ? "" : ` (${openPulls.value.toLocaleString()} Open)`;
    return `Pull requests on ${issueRepo.value.owner}/${issueRepo.value.repo}${open}`;
  }
  const where = o.head.branch ?? `detached at ${o.head.short_id}`;
  if (o.commit_count == null) return `${where} (no commits yet)`;
  return `${where} (${o.commit_count.toLocaleString()} ${o.commit_count === 1 ? "Commit" : "Commits"})`;
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
</script>

<template>
  <div v-if="isMac && (gitMissing || !overview)" class="title-strip" />
  <GitMissing v-if="gitMissing" :status="gitStatus" :checking="checkingGit" @recheck="checkGit" />

  <div
    v-else-if="overview"
    class="window"
    :style="{ gridTemplateColumns: `${panes.sidebar}px minmax(280px, ${panes.history}px) minmax(320px, 1fr)` }"
  >
    <Sidebar
      v-model:selected="selected"
      :overview="overview"
      :compared="comparedKeys"
      :issues="showsIssues && hasIssues ? { count: openIssues, fresh: freshIssues } : null"
      :pulls="showsIssues && hasPulls ? { count: openPulls } : null"
      :agents="agentStates"
      @compare="compareWith"
      @open-repository="chooseRepository"
      @menu="sidebarMenu"
      :switching="switching"
      @activate="sidebarActivate"
      @section-menu="(section, event) => actions.sectionMenu(section) && openMenu(event, actions.sectionMenu(section))"
      @merge-into-head="(name) => actions.merge(name)"
      @rebase-head-onto="(name) => actions.rebase(name)"
      @new-branch-from="(name) => actions.newBranch(name, name)"
      @cherry-pick="(commits) => actions.cherryPick(commits)"
      @add-menu="(event) => openMenu(event, actions.addMenu())"
      @recent-menu="recentMenu"
    />

    <section v-if="isSettings" class="pane settings-pane">
      <div class="splitter" @pointerdown="startResize($event, 'sidebar', 200, 480)" />
      <SettingsView ref="settingsView" :path="overview.path" :name="overview.name" />
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
            :title="nav.back.length ? `Back to ${describe(nav.back.at(-1))} (${shortcut('Alt+←')})` : 'Back'"
            :disabled="!nav.back.length"
            @click="go('back')"
          >
            <ChevronLeft :size="20" :stroke-width="1.5" />
          </button>
          <button
            class="icon-button"
            :title="nav.forward.length ? `Forward to ${describe(nav.forward.at(-1))} (${shortcut('Alt+→')})` : 'Forward'"
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
        <template v-else-if="isFiles">
          <span>Files</span>
          <button
            class="mainline-toggle"
            :class="{ on: fileTree?.showsIgnored() }"
            :aria-pressed="!!fileTree?.showsIgnored()"
            title="Show files git ignores, such as dependencies and build output"
            @click="fileTree?.toggleIgnored()"
          >
            <EyeOff :size="14" :stroke-width="1.75" />
            Ignored
          </button>
        </template>
        <span v-else-if="isStashes">Stashes</span>
        <template v-else-if="isIssues || isPulls">
          <span>{{ isPulls ? "Pull Requests" : "Issues" }}</span>
          <button
            v-if="issueRepo && issueRepos.length > 1"
            class="remote-choice"
            :title="isPulls ? 'Show another repository\'s pull requests' : 'Show another repository\'s issues'"
            @click="issueRepoMenu"
          >
            {{ issueRepo.owner }}/{{ issueRepo.repo }} <ChevronDown :size="13" />
          </button>
        </template>
        <span v-else-if="isCompare">Compare</span>
        <span v-else class="breadcrumb">
          <template v-for="(part, i) in breadcrumb" :key="i">
            <span v-if="i > 0" class="breadcrumb-sep">›</span>
            <span :class="{ dim: i > 0 }">{{ part }}</span>
          </template>
        </span>
        <span v-if="fileFilter && !awayFromHistory()" class="file-filter" :title="`Only commits that changed ${fileFilter}`">
          <span class="file-filter-name">{{ fileFilter.slice(fileFilter.lastIndexOf("/") + 1) }}</span>
          <button class="icon-button small" title="Show all commits" @click="fileFilter = null">
            <X :size="13" />
          </button>
        </span>
        <span
          v-if="historySearch && !awayFromHistory()"
          class="file-filter"
          :title="`Only commits matching “${historySearch}”`"
        >
          <Search :size="13" :stroke-width="1.75" />
          <span class="file-filter-name">“{{ historySearch }}”</span>
          <span v-if="historyCount != null" class="match-count">{{ historyCount.toLocaleString() }}</span>
          <button class="icon-button small" title="Show all commits" @click="historySearch = ''">
            <X :size="13" />
          </button>
        </span>
        <button
          v-if="!awayFromHistory() && !fileFilter"
          class="mainline-toggle"
          :class="{ on: firstParent }"
          :aria-pressed="firstParent"
          :title="
            firstParent
              ? 'Showing only the mainline: each merge stands for the commits it brought in. Click to show every commit.'
              : 'Show only the mainline, with each merge standing for the commits it brought in'
          "
          @click="toggleFirstParent"
        >
          <GitCommitVertical :size="14" :stroke-width="1.75" />
          Mainline
        </button>
      </div>

      <FolderGoneBanner
        v-if="folderGone"
        :name="overview.name"
        :path="overview.path"
        :worktree="isWorktree"
        @close="thisWindow.close()"
      />
      <OperationBanner
        v-if="overview.operation"
        :operation="overview.operation"
        :conflicts="overview.conflicts"
        :busy="remoteBusy"
        @action="actions.controlOperation"
      />

      <CompareBar
        v-if="isCompare && comparison"
        :path="overview.path"
        :comparison="comparison"
        :choices="actions.revisionChoices()"
        :all-selected="!selectedCommit"
        :refresh-key="refreshKey"
        @change="openComparison"
        @close="closeComparison"
        @select-all="selectedCommit = null"
      />
      <WorkingCopy
        v-if="isWorkingCopy"
        :draft="draft"
        :path="overview.path"
        :refresh-key="refreshKey"
        :selected-path="workingFile?.path"
        :undoable="undoableWithNotice"
        :issue-repo="githubAccount ? issueRepo : null"
        :status-files="overview.files ?? null"
        @select="workingFile = $event"
        @changed="refresh"
        @open-file="openInFiles"
      />
      <FileTree
        v-else-if="isFiles"
        ref="fileTree"
        :path="overview.path"
        :selected="openFiles[overview.path] ?? null"
        :refresh-key="refreshKey"
        :status-files="overview.files ?? null"
        @select="openFiles[overview.path] = $event"
        @deleted="onFileDeleted"
        @renamed="onFileRenamed"
        @open-terminal="(folder) => showTerminal({ newTab: true, folder })"
      />
      <IssueList
        v-else-if="isPulls && issueRepo"
        key="pulls"
        pulls
        :repo="issueRepo"
        :query="pullQuery"
        :selected="selectedPull?.number"
        :refresh-key="refreshKey"
        :updated="updatedPull"
        @select="selectedPull = $event"
        @count="openPulls = $event"
        @create="createPullRequest(overview.head.branch)"
      />
      <IssueList
        v-else-if="isIssues && issueRepo"
        key="issues"
        :repo="issueRepo"
        :query="issueQuery"
        :selected="selectedIssue?.number"
        :refresh-key="refreshKey"
        :updated="updatedIssue"
        :seen-at="issuesSeenBefore"
        @select="selectedIssue = $event"
        @count="openIssues = $event"
        @created="onIssueCreated"
      />
      <!-- While Palace checks whether the repository is a fork. -->
      <div v-else-if="isIssues || isPulls" class="empty-state"><Spinner /></div>
      <StashList
        v-else-if="isStashes"
        :stashes="overview.stashes"
        :selected-index="selectedStash"
        :query="stashQuery"
        @select="selectedStash = $event"
        @menu="(index, event) => openMenu(event, actions.stashMenu(index))"
      />
      <!-- Hidden rather than removed, so the history keeps its scroll position. -->
      <div v-show="!isWorkingCopy && !isFiles && !isStashes && !isIssues && !isPulls" class="pane-body">
        <HistoryList
          :path="overview.path"
          :rev="isCompare ? comparison?.head : historyRev"
          :hide="isCompare ? comparison?.base : null"
          :file="isCompare ? null : fileFilter"
          :search="isCompare ? '' : historySearch"
          :first-parent="!isCompare && firstParent"
          :refresh-key="refreshKey"
          :selected-id="selectedCommit?.id"
          :editable="rewritable"
          :pickable="pickable"
          @select="selectedCommit = $event"
          @menu="(commit, event) => openMenu(event, actions.commitMenu(commit, rewritable))"
          @menu-many="(entries, event) => openMenu(event, actions.commitsMenu(entries, rewritable, pickable))"
          @move="actions.moveCommit"
          @count="historyCount = $event"
        />
      </div>
    </section>

    <section v-show="!isFullView" class="pane detail-pane">
      <div class="splitter" @pointerdown="startResize($event, 'history', 360, 1000)" />

      <header class="toolbar actions">
        <div class="action-group">
          <button
            class="icon-button"
            :class="{ active: remoteOp?.command === 'fetch' && remoteBusy }"
            :title="fetchTitle"
            :disabled="remoteBusy"
            @click="refreshAndFetch"
          >
            <CloudDownload :size="18" :stroke-width="1.5" />
          </button>
          <button
            class="icon-button"
            :class="{ active: remoteOp?.command === 'pull' && remoteBusy }"
            :title="headBranch?.upstream ? `Pull from ${headBranch.upstream}` : 'Pull'"
            :disabled="remoteBusy"
            @click="actions.pull()"
          >
            <ArrowDownToLine :size="18" :stroke-width="1.5" />
            <span v-if="headBranch?.behind" class="count-badge">{{ headBranch.behind }}</span>
          </button>
          <button
            class="icon-button"
            :class="{ active: ['push', 'publish_branch'].includes(remoteOp?.command) && remoteBusy }"
            :title="headBranch?.upstream ? `Push to ${headBranch.upstream}` : 'Publish this branch…'"
            :disabled="remoteBusy"
            @click="actions.push()"
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
          <button
            class="icon-button"
            :title="overview.head.branch ? `Rebase ${overview.head.branch} onto another branch` : 'Check out a branch to rebase it'"
            :disabled="remoteBusy || !overview.head.branch || !!overview.operation"
            @click="actions.rebase()"
          >
            <GitCommitVertical :size="18" :stroke-width="1.5" />
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
        <button
          class="icon-button terminal-toggle"
          :class="{ active: terminalOpen }"
          :title="`${terminalOpen ? 'Hide Terminal' : 'Terminal'} (${shortcut('Ctrl+\'')})`"
          @click="toggleTerminal"
        >
          <SquareTerminal :size="18" :stroke-width="1.5" />
          <span v-if="terminalUnseen && !terminalOpen" class="toggle-mark" />
        </button>
        <label v-if="isStashes" class="toolbar-search stash-search">
          <Search :size="15" :stroke-width="1.5" />
          <input ref="viewSearch" v-model="stashQuery" placeholder=" " aria-label="Search for a stash's message" spellcheck="false" @keydown.esc="stashQuery = ''" />
          <SearchHint what="stashes" />
        </label>
        <label v-else-if="isPulls" class="toolbar-search stash-search">
          <Search :size="15" :stroke-width="1.5" />
          <input
            ref="viewSearch"
            v-model="pullQuery"
            placeholder=" "
            aria-label="Search pull requests"
            title="Words to find, or GitHub search terms such as author:octocat"
            spellcheck="false"
            @keydown.esc="pullQuery = ''"
          />
          <SearchHint what="pull requests" />
        </label>
        <label v-else-if="isIssues" class="toolbar-search stash-search">
          <Search :size="15" :stroke-width="1.5" />
          <input
            ref="viewSearch"
            v-model="issueQuery"
            placeholder=" "
            aria-label="Search issues"
            title="Words to find, or GitHub search terms such as author:octocat"
            spellcheck="false"
            @keydown.esc="issueQuery = ''"
          />
          <SearchHint what="issues" />
        </label>
        <ToolbarSearch
          v-else
          ref="toolbarSearch"
          :path="overview.path"
          :rev="searchRev"
          :refresh-key="refreshKey"
          :untracked="isFiles"
          @pick="(file) => (isFiles ? (focusOnOpen(), (openFiles[overview.path] = file)) : showFileHistory(file))"
          @pick-commit="showFoundCommit"
          @filter-commits="showMatchingCommits"
        />
      </header>

      <template v-if="isWorkingCopy">
        <div class="subheader">
          <span class="file-title">{{ workingFile?.path }}</span>
        </div>
        <ConflictView v-if="workingFile?.conflicted" :path="overview.path" :file="workingFile" @changed="refresh" />
        <WorkingFileDiff v-else-if="workingFile" :path="overview.path" :file="workingFile" :undoable="undoableWithNotice" @changed="refresh" />
        <div v-else class="empty-state">
          <p>Select a file to see its changes.</p>
        </div>
      </template>

      <FileEditor
        v-else-if="isFiles"
        :path="overview.path"
        :file="openFiles[overview.path] ?? null"
        :refresh-key="refreshKey"
        @send-to-agent="pasteToAgent"
      />

      <template v-else-if="isIssues">
        <div class="subheader">
          <span class="dim">{{ selectedIssue ? `#${selectedIssue.number}` : "" }}</span>
          <button v-if="selectedIssue" class="link-button" @click="openUrl(selectedIssue.html_url)">
            Open on GitHub <ExternalLink :size="13" />
          </button>
        </div>
        <IssueDetails
          v-if="selectedIssue && issueRepo"
          :repo="issueRepo"
          :path="overview.path"
          :issue="selectedIssue"
          :refresh-key="refreshKey"
          @updated="onIssueUpdated"
          @show-commit="showFoundCommit"
          @merged="onPullMerged"
          @checkout="checkoutPull"
        />
        <div v-else class="empty-state">
          <p>Select an issue to read it.</p>
        </div>
      </template>

      <template v-else-if="isPulls">
        <div class="subheader">
          <span class="dim">{{ selectedPull ? `#${selectedPull.number}` : "" }}</span>
          <button v-if="selectedPull" class="link-button" @click="openUrl(selectedPull.html_url)">
            Open on GitHub <ExternalLink :size="13" />
          </button>
        </div>
        <IssueDetails
          v-if="selectedPull && issueRepo"
          :repo="issueRepo"
          :path="overview.path"
          :issue="selectedPull"
          :refresh-key="refreshKey"
          @updated="onPullUpdated"
          @show-commit="showFoundCommit"
          @merged="onPullMerged"
          @checkout="checkoutPull"
        />
        <div v-else class="empty-state">
          <p>Select a pull request to read it.</p>
        </div>
      </template>

      <template v-else>
        <div v-if="isCompare && !detailCommit && comparison" class="subheader">
          <span class="dim">All changes on “{{ comparison.head }}”</span>
        </div>
        <div v-else class="subheader">
          <span class="mono dim">
            <CopyText v-if="detailCommit?.id" :value="detailCommit.id" label="Copy the full commit hash">{{ detailCommit.short_id }}</CopyText>
          </span>
          <div class="segmented">
            <button :class="{ active: detailMode === 'changeset' }" @click="detailMode = 'changeset'">Changeset</button>
            <button :class="{ active: detailMode === 'tree' }" title="Every file at this commit" @click="detailMode = 'tree'">
              Files
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
            :issue-links="issueRemotes.length > 0"
            @show-issue="showIssue"
          />
        </template>
        <CommitDetails v-else-if="isCompare && comparison" :path="overview.path" :comparison="comparison" />
        <div v-else class="empty-state">
          <p>{{ isStashes ? "Select a stash to see its changes." : "Select a commit to see its details." }}</p>
        </div>
      </template>

      <ReviewTray
        v-if="!isIssues && !isPulls"
        :path="overview.path"
        :sending="sendingReview"
        @send="sendReview"
        @clear="clearReview"
      />
    </section>

    <TerminalPanel
      v-if="terminalLoaded"
      v-show="terminalOpen"
      ref="terminalPanel"
      v-model:height="panes.terminal"
      :path="overview.path"
      :name="overview.name"
      @resized="savePanes"
      @hide="terminalOpen = false"
      @unseen="terminalUnseen = $event"
    />
  </div>

  <main v-else-if="browsingGitHub" class="standalone-page">
    <GitHubView standalone @clone="cloneRepository" @back="browsingGitHub = false" />
  </main>

  <main v-else-if="browsingSettings" class="standalone-page">
    <SettingsView ref="settingsView" standalone @back="browsingSettings = false" />
  </main>

  <WelcomeView
    v-else
    :starting="starting"
    :recents="recents"
    :loading="loading"
    :error="error"
    @open-repository="chooseRepository"
    @clone="browsingGitHub = true"
    @open="(path) => loadRepository(path)"
    @remove="removeRecent"
  />

  <!-- Overlays, shown over whichever screen is up. -->
  <FormDialog v-if="formDialog" :key="formDialog.title" :dialog="formDialog" />
  <TagDialog v-if="tagDialog" :dialog="tagDialog" />
  <PullDialog v-if="pullDialog" :dialog="pullDialog" />
  <MergeDialog v-if="mergeDialog" :dialog="mergeDialog" />
  <ResetDialog v-if="resetDialog" :dialog="resetDialog" />
  <CloneDialog v-if="cloneDialog" :dialog="cloneDialog" />
  <NewPullRequestDialog
    v-if="pullRequestDialog"
    :path="overview.path"
    :plan="pullRequestDialog"
    :push="() => pushForPullRequest(pullRequestDialog)"
    @close="onPullRequestClosed"
  />
  <ConfirmDialog v-if="confirmDialog" :dialog="confirmDialog" />
  <UpdateNotice />
  <StarNotice v-if="starRequest && !updateNoticeShown" />
  <TerminalNotices :notices="terminalNotices" @open="openNotice" @dismiss="dismissNotice" />
  <ContextMenu v-if="contextMenu" :menu="contextMenu" />

  <RemoteStatus
    v-if="remoteOp"
    :operation="remoteOp"
    @cancel="invoke('cancel_remote')"
    @dismiss="dismissStatus()"
    @action="(action) => { dismissStatus(); action.run(); }"
  />
</template>

<style scoped>
.window {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  height: 100vh;
}

/* The sidebar stays full height; the terminal panel is below the other panes. */
.window > .sidebar {
  grid-row: 1 / -1;
}

.window > .pane {
  grid-row: 1;
}

.window > .terminal-panel {
  grid-row: 2;
  grid-column: 2 / -1;
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
  font-size: var(--font-sm);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Too narrow for everything, the toolbar loses its right end, the search, rather than
   the buttons at its left. */
.actions {
  justify-content: safe flex-end;
}

.actions > * {
  flex-shrink: 0;
}

.actions > .toolbar-search-box,
.actions > .stash-search {
  flex-shrink: 1;
}

/* And before that, a narrow toolbar packs its buttons closer together. */
.actions {
  container-type: inline-size;
}

@container (max-width: 460px) {
  .actions > * {
    margin-left: -6px;
  }

  .actions > :first-child {
    margin-left: -4px;
  }

  .actions .icon-button {
    width: 28px;
  }
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
  border-radius: var(--radius-lg);
  background: var(--accent);
  color: white;
  font-size: var(--font-xs);
  font-weight: 700;
  line-height: 15px;
}

.action-group {
  display: flex;
  border-radius: var(--radius-lg);
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

/* In the Issues view: whose issues they are, when the repository has more than one
   GitHub remote, and the link to the chosen one on GitHub. */
.remote-choice,
.subheader .link-button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border: 0;
  border-radius: var(--radius-md);
  background: none;
  font: inherit;
  font-size: var(--font-md);
  color: var(--text-secondary);
}

.subheader .link-button {
  color: var(--accent);
}

.remote-choice:hover,
.subheader .link-button:hover {
  background: var(--button-hover);
}

.breadcrumb {
  overflow: hidden;
  text-overflow: ellipsis;
}

.mainline-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: none;
  font: inherit;
  font-size: var(--font-ui);
  color: var(--text-secondary);
}

.mainline-toggle:hover {
  background: var(--button-hover);
}

.mainline-toggle.on {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

.file-filter + .mainline-toggle {
  margin-left: 8px;
}

.file-filter {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  margin-right: auto;
  margin-left: 10px;
  padding: 1px 2px 1px 9px;
  border-radius: var(--radius-md);
  background: var(--pill-bg);
  font-size: var(--font-ui);
}

.file-filter > svg {
  flex-shrink: 0;
  margin-right: 3px;
  color: var(--text-tertiary);
}

.file-filter-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.match-count {
  margin-left: 4px;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

/* Like the toolbar's other searches (see ToolbarSearch.vue). */
.stash-search {
  width: 220px;
  min-width: 36px;
  flex-shrink: 1;
}

.stash-search:focus-within {
  min-width: 160px;
}

.settings-pane {
  grid-column: 2 / -1;
}

.breadcrumb-sep {
  margin: 0 6px;
  color: var(--text-tertiary);
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

/* A view shown from the welcome screen, in place of it: GitHub, or Settings. */
.standalone-page {
  display: flex;
  height: 100vh;
}

/* Below the macOS window buttons and the strip that drags the window. */
:root[data-title-bar="overlay"] .standalone-page {
  box-sizing: border-box;
  padding-top: 28px;
}

.title-strip {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  z-index: 1;
  height: 28px;
}

/* The terminal button's mark: a tab in the hidden panel has finished or needs you. */
.terminal-toggle {
  position: relative;
}

.toggle-mark {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
</style>
