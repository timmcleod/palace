<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
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
  CircleAlert,
  CloudDownload,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitMerge,
  Redo2,
  RefreshCw,
  Search,
  Undo2,
  X,
} from "lucide-vue-next";
import CommitDetails from "./components/CommitDetails.vue";
import CompareBar from "./components/CompareBar.vue";
import ConflictView from "./components/ConflictView.vue";
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
import RemoteStatus from "./components/RemoteStatus.vue";
import NewPullRequestDialog from "./components/NewPullRequestDialog.vue";
import SettingsView from "./components/SettingsView.vue";
import StarNotice from "./components/StarNotice.vue";
import Sidebar from "./components/Sidebar.vue";
import TagDialog from "./components/TagDialog.vue";
import ToolbarSearch from "./components/ToolbarSearch.vue";
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
import { CANCELED } from "./lib/confirm.js";
import { loadAvatars } from "./lib/avatars.js";
import { settings } from "./lib/settings.js";
import { commandKey, fileManager, isMac, shortcut } from "./lib/platform.js";
import { starRequest } from "./lib/star.js";
import { githubAccount } from "./lib/github.js";
import { githubRemoteOf, githubRemotes, repoKey } from "./lib/githubRemote.js";
import { issueError, issuesSeenAt, markIssuesSeen } from "./lib/issues.js";
import { pullRequestPlan } from "./lib/pullRequests.js";
import { updateNoticeShown } from "./lib/updates.js";

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
const isIssues = computed(() => selected.value === "workspace:issues");
const isPulls = computed(() => selected.value === "workspace:pulls");
// Comparing two revisions: the history lists what `head` has that `base` doesn't,
// and with no commit chosen, the detail pane shows all of `head`'s changes.
const isCompare = computed(() => selected.value === "workspace:compare");
const comparison = ref(null);
// Views without a history of their own to search or filter.
const awayFromHistory = () =>
  isWorkingCopy.value || isFullView.value || isStashes.value || isIssues.value || isPulls.value || isCompare.value;

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

// The Issues view, for repositories with a remote on GitHub: whose issues, the chosen
// issue, the search, and how many are open, for the sidebar.
//
// The issues are origin's repository's (or the first GitHub remote's), unless that's
// a fork: then they're the parent's, where a project's issues usually are. Choosing
// another in the menu is remembered for the repository.
const ISSUE_REPOS_KEY = "palace.issueRepos";
const issueRemotes = computed(() => githubRemotes(overview.value));
// The fork's parent as { owner, repo }; null when it isn't a fork, and undefined until
// GitHub has said.
const forkParent = ref(undefined);
// The chosen repository's key ("owner/repo"), or null for the usual one.
const issueChoice = ref(null);

const issueRepos = computed(() => {
  const repos = issueRemotes.value;
  const parent = forkParent.value;
  if (!parent || repos.some((r) => repoKey(r) === repoKey(parent))) return repos;
  return [...repos, { ...parent, remotes: [], forkedFrom: repos[0] }];
});

const issueRepo = computed(() => {
  const repos = issueRepos.value;
  const chosen = repos.find((r) => repoKey(r) === issueChoice.value);
  if (chosen) return chosen;
  // Waits for the fork check, so a fork's own issues don't show first.
  if (forkParent.value === undefined && githubAccount.value) return null;
  return (forkParent.value && repos.find((r) => repoKey(r) === repoKey(forkParent.value))) ?? repos[0] ?? null;
});

const selectedIssue = shallowRef(null);
const issueQuery = ref("");
const openIssues = ref(null);
// The last issue changed in the issue view, for the list to show.
const updatedIssue = shallowRef(null);

function onIssueUpdated(issue) {
  // "#123" can open a pull request here, which counts toward the open pull requests.
  const count = issue.pull_request ? openPulls : openIssues;
  if (count.value != null && selectedIssue.value?.state !== issue.state) {
    count.value += issue.state === "open" ? 1 : -1;
  }
  selectedIssue.value = issue;
  updatedIssue.value = issue;
}

// From "#123" in a commit message to that issue: in the Issues view, or on GitHub
// when Palace isn't signed in.
async function showIssue(number) {
  const repo = issueRepo.value ?? issueRemotes.value[0];
  if (!repo) return;
  if (!githubAccount.value) {
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

// The Pull Requests view, alongside: the same repository's pull requests, read the
// way issues are.
const selectedPull = shallowRef(null);
const pullQuery = ref("");
const openPulls = ref(null);
const updatedPull = shallowRef(null);

function onPullUpdated(pull) {
  if (openPulls.value != null && selectedPull.value?.state !== pull.state) {
    openPulls.value += pull.state === "open" ? 1 : -1;
  }
  selectedPull.value = pull;
  updatedPull.value = pull;
}

// After a pull request is merged here, the merge is fetched, and the local branch
// that tracked it is offered for deleting: from wherever it's checked out, by going
// to the branch it was merged into.
async function onPullMerged({ number, base, head, headRepo, branchDeleted }) {
  const remotes = overview.value.remotes;
  const headRemote = githubRemoteOf(remotes, headRepo);
  const baseRemote = githubRemoteOf(remotes, issueRepo.value && `${issueRepo.value.owner}/${issueRepo.value.repo}`);
  const local = headRemote && overview.value.branches.find((b) => b.upstream === `${headRemote.name}/${head}`);
  for (const remote of new Set([baseRemote?.name, headRemote?.name].filter(Boolean))) {
    await runGit(["Fetching…", "Fetched", "Fetch failed"], "fetch", { remote });
  }

  const offers = [];
  // Deleting is forced, since a squash or rebase leaves the branch looking unmerged,
  // so a branch with commits that were never pushed is kept.
  const unpushed = local?.ahead > 0;
  if (local && !unpushed && local.name !== overview.value.head.branch) {
    offers.push({ label: `Delete “${local.name}”`, run: () => actions.deleteMergedBranch(local.name) });
  } else if (local && !unpushed) {
    const into =
      overview.value.branches.find((b) => baseRemote && b.upstream === `${baseRemote.name}/${base}`) ??
      overview.value.branches.find((b) => b.name === base);
    if (into) {
      offers.push({
        label: `Switch to “${into.name}” and Delete “${local.name}”`,
        run: async () => (await actions.checkout("branch", into.name)) || actions.deleteMergedBranch(local.name),
      });
    }
  }
  clearTimeout(dismissTimer);
  const op = reactive({
    title: `Merged pull request #${number}`,
    state: "done",
    message: [
      branchDeleted ? `Merged into ${base}, and deleted ${head} on GitHub.` : `Merged into ${base}.`,
      unpushed && `Your local “${local.name}” has commits that weren't pushed, so it's been kept.`,
    ]
      .filter(Boolean)
      .join(" "),
    actions: offers,
  });
  remoteOp.value = op;
  dismissTimer = setTimeout(() => remoteOp.value === op && (remoteOp.value = null), 15_000);
}

function onIssueCreated(issue) {
  if (openIssues.value != null) openIssues.value++;
  selectedIssue.value = issue;
}

// Each repository starts with its remembered choice, and a check for a fork.
watch(
  [() => overview.value?.path, () => issueRemotes.value[0] && repoKey(issueRemotes.value[0]), () => githubAccount.value?.login],
  async ([path, first, login]) => {
    issueChoice.value = readJson(ISSUE_REPOS_KEY, {})[path] ?? null;
    forkParent.value = first && login ? undefined : null;
    if (!first || !login) return;
    const [owner, repo] = first.split("/");
    const parent = await invoke("github_fork_parent", { owner, repo }).catch(() => null);
    if (overview.value?.path !== path) return;
    const [parentOwner, parentRepo] = parent?.split("/") ?? [];
    forkParent.value = parent ? { owner: parentOwner, repo: parentRepo } : null;
  },
  { immediate: true },
);

function chooseIssueRepo(repo) {
  issueChoice.value = repoKey(repo);
  writeJson(ISSUE_REPOS_KEY, { ...readJson(ISSUE_REPOS_KEY, {}), [overview.value.path]: issueChoice.value });
}

// How many issues are open, and how many of those are new: opened since the Issues
// view was last looked at. They're checked when the repository opens, then every few
// minutes in the background, as often as fetching.
const freshIssues = ref(0);
// When the issues were last looked at, as of opening the Issues view, so the issues
// newer than that can be marked new in the list.
const issuesSeenBefore = ref(null);
let issuesCheckedAt = 0;

async function checkIssues() {
  const repo = issueRepo.value;
  if (!repo || !githubAccount.value) return;
  issuesCheckedAt = Date.now();
  const found = await invoke("github_issues", { owner: repo.owner, repo: repo.repo, filters: "is:open", page: 1 }).catch(
    () => null,
  );
  if (!found || !issueRepo.value || repoKey(issueRepo.value) !== repoKey(repo)) return;
  openIssues.value = found.total;
  // The first check sets where "new" starts; until then, nothing is new.
  const seen = issuesSeenAt(repo);
  if (!seen) markIssuesSeen(repo);
  const isNew = (i) => Date.parse(i.created_at) > Date.parse(seen);
  freshIssues.value = isIssues.value || !seen ? 0 : found.issues.filter(isNew).length;
  const pulls = await invoke("github_issues", { owner: repo.owner, repo: repo.repo, filters: "is:open", page: 1, pulls: true }).catch(
    () => null,
  );
  if (pulls && issueRepo.value && repoKey(issueRepo.value) === repoKey(repo)) openPulls.value = pulls.total;
}

watch(
  [() => issueRepo.value?.owner, () => issueRepo.value?.repo, () => githubAccount.value?.login],
  () => {
    openIssues.value = null;
    freshIssues.value = 0;
    selectedIssue.value = null;
    openPulls.value = null;
    selectedPull.value = null;
    checkIssues();
  },
  { immediate: true },
);

// Looking at the Issues view sees them: new ones are marked there until it's left.
// (By key: the repository object is made afresh on every refresh.)
const keyToRepo = (key) => key && { owner: key.split("/")[0], repo: key.split("/")[1] };
watch(
  [isIssues, () => issueRepo.value && repoKey(issueRepo.value)],
  ([viewing, key], [wasViewing, previous]) => {
    if (wasViewing && previous) markIssuesSeen(keyToRepo(previous));
    if (!viewing || !key) return;
    issuesSeenBefore.value = issuesSeenAt(keyToRepo(key));
    markIssuesSeen(keyToRepo(key));
    freshIssues.value = 0;
  },
);

// In the background, as often as fetching, while the Issues view isn't showing them.
const issuesTimer = setInterval(() => {
  const due = Date.now() - issuesCheckedAt >= settings.fetchMinutes * 60_000;
  if (due && settings.fetchInBackground && !isIssues.value && !isPulls.value && navigator.onLine) checkIssues();
}, 30_000);
onBeforeUnmount(() => clearInterval(issuesTimer));

// A repository whose GitHub remotes go away leaves the Issues and Pull Requests views.
watch(
  () => issueRemotes.value.length,
  (count) => {
    if (!count && (isIssues.value || isPulls.value)) selected.value = headHistoryKey(overview.value);
  },
);

function issueRepoMenu(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  openMenu(
    { clientX: rect.left, clientY: rect.bottom + 4, preventDefault() {} },
    issueRepos.value.map((r) => ({
      label: `${r.owner}/${r.repo}`,
      detail: r.forkedFrom ? `Forked into ${r.forkedFrom.owner}/${r.forkedFrom.repo}` : r.remotes.join(", "),
      checked: r === issueRepo.value,
      action: () => chooseIssueRepo(r),
    })),
  );
}

// The Stashes view: the chosen stash (by index) and the search for one by message.
const selectedStash = ref(null);
const stashQuery = ref("");
// The toolbar search's "Show all matching commits" narrows the history to this search.
const historySearch = ref("");
// How many commits the history lists, shown as the number of matches while searching.
const historyCount = ref(null);
const toolbarSearch = ref(null);

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
  comparison: comparison.value,
});

const samePlace = (a, b) =>
  a.selected === b.selected &&
  a.commit?.id === b.commit?.id &&
  a.stash === b.stash &&
  a.fileFilter === b.fileFilter &&
  a.detailMode === b.detailMode &&
  a.treeFile === b.treeFile &&
  a.comparison === b.comparison;

watch([selected, () => selectedCommit.value?.id, selectedStash, fileFilter, detailMode, treeFile, comparison], () => {
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
  comparison.value = place.comparison;
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
    "workspace:issues": "Issues",
    "workspace:pulls": "Pull Requests",
    "workspace:github": "GitHub",
    "workspace:settings": "Settings",
    "workspace:history": "History",
    "workspace:compare": place.comparison && `${place.comparison.head} with ${place.comparison.base}`,
  }[place.selected] ?? name ?? kind;
  const detail = place.commit?.short_id ?? (place.selected === "workspace:stashes" && place.stash != null ? `stash@{${place.stash}}` : "");
  return [view, detail].filter(Boolean).join(" › ");
}

function onNavKeydown(event) {
  // Ctrl+Z undoes and Ctrl+Shift+Z (or Ctrl+Y) redoes, except in text fields and
  // dialogs, which keep their own. On a Mac, these and the shortcuts below use Cmd.
  const key = event.key.toLowerCase();
  if (commandKey(event) && !event.altKey && (key === "z" || key === "y") && !inTextField(event.target) && !dialogOpen()) {
    event.preventDefault();
    if (key === "y" || event.shiftKey) redo();
    else undo();
    return;
  }
  // Ctrl+Shift+O opens the repository's folder.
  if (commandKey(event) && event.shiftKey && !event.altKey && key === "o" && overview.value && !dialogOpen()) {
    event.preventDefault();
    openOutside("open_folder", "Couldn't Open the Folder");
    return;
  }
  // Ctrl+F goes to the toolbar search.
  if (commandKey(event) && !event.shiftKey && !event.altKey && key === "f" && toolbarSearch.value) {
    event.preventDefault();
    toolbarSearch.value.focus();
    return;
  }
  // Ctrl+, opens Settings.
  if (commandKey(event) && !event.shiftKey && !event.altKey && key === "," && overview.value && !dialogOpen()) {
    event.preventDefault();
    selected.value = "workspace:settings";
    return;
  }
  // In text fields, Alt+arrows move by word (on a Mac) and stay theirs.
  if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight") || inTextField(event.target)) return;
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

// Only network operations report progress and can be canceled.
const NETWORK = new Set([
  "fetch",
  "pull",
  "push",
  "publish_branch",
  "clone_repo",
  "add_remote",
  "delete_remote_tag",
  "delete_remote_branch",
  "rename_remote_branch",
  "finish_remote_rename",
]);

const headBranch = computed(() => overview.value?.branches.find((b) => b.is_head) ?? null);
const remoteBusy = computed(() => remoteOp.value?.state === "running");

/**
 * Runs a backend command against the open repository, showing it in the status card
 * and refreshing everything afterwards. Resolves to the error message, or null.
 *
 * titles: [while running, on success, on failure]. options.quietError(message)
 * returning true hides that failure, for callers that handle it themselves.
 * options.path runs it somewhere other than the open repository, or with none open.
 * Commands in UNDOABLE can be undone afterwards; options.undo names the step.
 */
async function runGit([running, done, failed], command, args = {}, { quietError, path, undo: undoLabel } = {}) {
  if (remoteBusy.value) return "Another operation is still running.";
  if (!overview.value && !path) return "No repository is open.";
  clearTimeout(dismissTimer);
  const op = reactive({ command, title: running, line: "", state: "running", message: "", cancellable: NETWORK.has(command) });
  remoteOp.value = op;

  try {
    await stopBackgroundFetch();
    const work = () => invoke(command, { path: path ?? overview.value.path, ...args });
    const label = !path && (undoLabel ?? UNDOABLE[command]?.(args));
    const mode = command === "reset" && args.keepChanges ? "mixed" : "keep";
    const undone = undoStack.value.at(-1);
    op.message = await (label ? undoable({ label, mode, cover: COVER[command]?.(args) }, work) : work());
    op.state = "done";
    op.title = done;
    if (undoStack.value.at(-1) !== undone) op.actions = [{ label: "Undo", run: undo }];
    if (command === "push" || command === "publish_branch") offerPullRequest(op, args.branch ?? overview.value.head.branch);
    // Fetching and pulling can bring in commits by new authors.
    if (command === "fetch" || command === "pull") {
      loadAvatars(overview.value.path);
      fetchedAt[overview.value.path] = Date.now();
    }
    // Successes get out of the way; failures stay until dismissed.
    dismissTimer = setTimeout(() => {
      if (remoteOp.value === op) remoteOp.value = null;
    }, 5000);
    return null;
  } catch (e) {
    const message = String(e);
    if (message === CANCELED) {
      remoteOp.value = null;
    } else if (quietError?.(message)) {
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
};

const runRemote = (kind) => runGit(REMOTE_TITLES[kind], kind);

// The Refresh button reloads the repository at once, then fetches from its remotes,
// which reloads it again with what came in.
function refreshAndFetch() {
  refresh();
  if (overview.value?.remotes.length && !remoteBusy.value) runRemote("fetch");
}

// --- Background fetch --------------------------------------------------------------

// Every few minutes, the open repository's remotes are fetched quietly, so the counts
// of commits to pull and push stay current. Failures (offline, a locked key) are let
// go until the next time.
const fetchedAt = reactive({});
const triedAt = {};
let backgroundFetch = null;
const now = ref(Date.now());

function fetchIfDue() {
  now.value = Date.now();
  const o = overview.value;
  if (!settings.fetchInBackground || !o?.remotes.length || backgroundFetch || remoteBusy.value) return;
  if (loading.value || !navigator.onLine) return;
  const last = Math.max(fetchedAt[o.path] ?? 0, triedAt[o.path] ?? 0);
  if (now.value - last < settings.fetchMinutes * 60_000) return;
  triedAt[o.path] = now.value;
  backgroundFetch = invoke("fetch_in_background", { path: o.path })
    .then(() => {
      fetchedAt[o.path] = Date.now();
      if (o.path === overview.value?.path) {
        loadAvatars(o.path);
        refresh();
      }
    })
    .catch(() => {})
    .finally(() => (backgroundFetch = null));
}

// Anything the user does goes first: a background fetch still running is canceled.
// It also keeps the fetch's new tags out of an undo step's before and after.
async function stopBackgroundFetch() {
  if (!backgroundFetch) return;
  invoke("cancel_remote").catch(() => {});
  await backgroundFetch;
}

const fetchTimer = setInterval(fetchIfDue, 30_000);
onBeforeUnmount(() => clearInterval(fetchTimer));
// A repository is fetched shortly after it's opened, once it has had time to load.
watch(
  () => overview.value?.path,
  () => setTimeout(fetchIfDue, 3000),
);

const fetchTitle = computed(() => {
  const at = overview.value && fetchedAt[overview.value.path];
  if (!at) return "Fetch from all remotes";
  const minutes = Math.floor((now.value - at) / 60_000);
  const ago = minutes < 1 ? "just now" : minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  return `Fetch from all remotes (last fetched ${ago})`;
});

// --- Undo and redo -----------------------------------------------------------------

// Operations that can be undone, and what Undo calls them, from their arguments.
// Committing and discarding are undoable too, from the working copy. Network
// operations other than pull can't be: what they changed is on the remote.
const named = (label) => () => label;
const UNDOABLE = {
  checkout: named("Checkout"),
  create_branch: named("New Branch"),
  delete_branch: named("Delete Branch"),
  rename_branch: named("Rename Branch"),
  merge: named("Merge"),
  rebase: named("Rebase"),
  rebase_interactive: named("Rebase"),
  cherry_pick: named("Cherry-pick"),
  revert: named("Revert"),
  reset: named("Reset"),
  pull: named("Pull"),
  create_tag: named("New Tag"),
  delete_tag: named("Delete Tag"),
  stash_save: named("Stash"),
  stash_apply: ({ pop }) => (pop ? "Pop Stash" : "Apply Stash"),
  stash_drop: named("Drop Stash"),
};
// The files an operation can change in the working copy, which undo keeps copies of
// (see take_snapshot).
const COVER = {
  stash_save: ({ files }) => (files ? { files } : { changed: true }),
  stash_apply: ({ index }) => ({ stash: index }),
};
const MAX_UNDO = 50;

// The open repository's steps, oldest first: { label, mode, before, after, message },
// where before and after are take_snapshot's snapshots and mode is restore_snapshot's.
const undoStack = ref([]);
const redoStack = ref([]);
// Other repositories' steps, kept for when they're open again: path → [undo, redo].
const otherStacks = new Map();

/**
 * Runs `work`, and if it changed any branch, tag or stash, or the files `step.cover`
 * names, remembers how to undo it. `step` is { label, mode, cover } and, for a
 * commit, its message. cover is take_snapshot's: { files, changed, stash }.
 */
async function undoable({ cover, ...step }, work) {
  await stopBackgroundFetch();
  const path = overview.value.path;
  let reason = "";
  const snapshot = (cover) =>
    invoke("take_snapshot", { path, cover }).catch((e) => {
      reason = String(e);
      return null;
    });
  // Without a snapshot, it isn't undoable. Changes to files would then be lost for
  // good, though the confirmation said they could be undone, so it asks again.
  const before = await snapshot(cover ?? null);
  if (!before && cover) {
    const ok = await askConfirm({
      title: `${step.label} Without Undo?`,
      message: `Palace couldn't keep a copy of the changes to undo this with: ${reason}\n\nGo ahead anyway? It can't be undone.`,
      confirmLabel: step.label,
      danger: true,
    });
    if (!ok) throw CANCELED;
  }
  const result = await work();
  const after = before && (await snapshot({ files: before.files.map((f) => f.path) }));
  if (after && JSON.stringify(after) !== JSON.stringify(before) && path === overview.value?.path) {
    undoStack.value = [...undoStack.value.slice(1 - MAX_UNDO), { ...step, before, after }];
    redoStack.value = [];
  }
  return result;
}

const undo = () => replay(undoStack, redoStack, true);
const redo = () => replay(redoStack, undoStack, false);

// Undoes the newest step on `stack`, or redoes it, moving it to the other stack.
async function replay(stack, other, undoing) {
  const step = stack.value.at(-1);
  if (!step || remoteBusy.value) return;
  const [verb, did] = undoing ? ["undo", "Undid"] : ["redo", "Redid"];
  const error = await runGit(
    [undoing ? "Undoing…" : "Redoing…", `${did} “${step.label}”`, `Couldn't ${verb} “${step.label}”`],
    "restore_snapshot",
    undoing ? { from: step.after, to: step.before, mode: step.mode } : { from: step.before, to: step.after, mode: step.mode },
  );
  if (error) {
    // Something else has moved what it changed, so it can never be replayed.
    if (error.includes("changed since") || error.includes("moved since")) stack.value = stack.value.slice(0, -1);
    return;
  }
  stack.value = stack.value.slice(0, -1);
  other.value = [...other.value, step];
  // An undone commit's message comes back, ready to commit again, and goes away
  // when the commit is redone.
  if (step.message) {
    const [subject, ...rest] = step.message.split("\n");
    const body = rest.join("\n").trim();
    if (undoing && !draft.subject && !draft.body) Object.assign(draft, { subject, body });
    if (!undoing && draft.subject === subject && draft.body === body) Object.assign(draft, { subject: "", body: "" });
  }
  if (remoteOp.value?.state === "done") {
    remoteOp.value.actions = [{ label: undoing ? "Redo" : "Undo", run: undoing ? redo : undo }];
  }
}

const inTextField = (target) => !!target.closest?.("input, textarea, select, [contenteditable]");
const dialogOpen = () =>
  [formDialog, confirmDialog, contextMenu, mergeDialog, pullDialog, resetDialog, tagDialog, cloneDialog, pullRequestDialog].some((d) => d.value);

// --- Pull requests -----------------------------------------------------------------

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
  clearTimeout(dismissTimer);
  const op = reactive({
    title: `Created pull request #${pull.number}`,
    state: "done",
    message: pull.title,
    actions: [{ label: "Open on GitHub", run: () => openUrl(pull.html_url) }],
  });
  remoteOp.value = op;
  dismissTimer = setTimeout(() => remoteOp.value === op && (remoteOp.value = null), 10_000);
}

// After a branch is pushed, the status card offers to create a pull request for it,
// or to view the one it has. Not for the repository's main branch, or while the
// dialog is the one pushing.
async function offerPullRequest(op, branch) {
  if (!githubAccount.value || !branch || pullRequestDialog.value || !issueRemotes.value.length) return;
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
  clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => remoteOp.value === op && (remoteOp.value = null), 10_000);
}

const actions = useGitActions({
  overview,
  run: runGit,
  compare: openComparison,
  pullRequest: { available: () => issueRemotes.value.length > 0, create: createPullRequest },
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
      issueQuery.value = "";
      pullQuery.value = "";
      historySearch.value = "";
      comparison.value = null;
      // Places belong to a repository.
      nav.back = [];
      nav.forward = [];
      here = null;
      Object.assign(draft, { subject: "", body: "", amend: false, saved: null });
      if (overview.value) otherStacks.set(overview.value.path, [undoStack.value, redoStack.value]);
      [undoStack.value, redoStack.value] = otherStacks.get(data.path) ?? [[], []];
      otherStacks.delete(data.path);
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

// Opens the repository in the file manager or a terminal, saying why if it can't.
function openOutside(command, failed) {
  invoke(command, { path: overview.value.path }).catch((e) => tell(failed, String(e)));
}

function recentMenu(anchor) {
  const current = overview.value?.path;
  const tidy = (path) => (home.value && path.startsWith(`${home.value}/`) ? `~${path.slice(home.value.length)}` : path);
  openMenu(anchor, [
    current && { label: `Open in ${fileManager}`, detail: shortcut("Ctrl+Shift+O"), action: () => openOutside("open_folder", "Couldn't Open the Folder") },
    current && { label: "Open in Terminal", action: () => openOutside("open_terminal", "Couldn't Open a Terminal") },
    current && { separator: true },
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

// The file watcher catches most changes made elsewhere; refreshing on focus also
// catches any it misses, such as on network drives where changes aren't reported.
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
    if (last) await loadRepository(last.path);
  }
  starting.value = false;
}

onMounted(checkGit);

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
const rewritable = computed(() => {
  const o = overview.value;
  const r = historyRef.value;
  const own = !r || (r.kind === "branch" && r.name === o?.head.branch);
  return !!(o?.head.branch && own && !isCompare.value && !fileFilter.value && !historySearch.value && !o.operation);
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
      :issues="issueRemotes.length ? { count: openIssues, fresh: freshIssues } : null"
      :pulls="issueRemotes.length ? { count: openPulls } : null"
      @compare="compareWith"
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
      </div>

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
        :undoable="undoable"
        :issue-repo="githubAccount ? issueRepo : null"
        @select="workingFile = $event"
        @changed="refresh"
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
      <div v-show="!isWorkingCopy && !isStashes && !isIssues && !isPulls" class="pane-body">
        <HistoryList
          :path="overview.path"
          :rev="isCompare ? comparison?.head : historyRev"
          :hide="isCompare ? comparison?.base : null"
          :file="isCompare ? null : fileFilter"
          :search="isCompare ? '' : historySearch"
          :refresh-key="refreshKey"
          :selected-id="selectedCommit?.id"
          :editable="rewritable"
          @select="selectedCommit = $event"
          @menu="(commit, event) => openMenu(event, actions.commitMenu(commit, rewritable))"
          @menu-many="(entries, event) => openMenu(event, actions.commitsMenu(entries, rewritable))"
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
            @click="runRemote('fetch')"
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
        <div class="action-group">
          <button
            class="icon-button"
            :title="undoStack.length ? `Undo ${undoStack.at(-1).label} (${shortcut('Ctrl+Z')})` : 'Nothing to undo'"
            :disabled="remoteBusy || !undoStack.length"
            @click="undo"
          >
            <Undo2 :size="18" :stroke-width="1.5" />
          </button>
          <button
            class="icon-button"
            :title="redoStack.length ? `Redo ${redoStack.at(-1).label} (${shortcut('Ctrl+Shift+Z')})` : 'Nothing to redo'"
            :disabled="remoteBusy || !redoStack.length"
            @click="redo"
          >
            <Redo2 :size="18" :stroke-width="1.5" />
          </button>
        </div>
        <button class="icon-button" title="Refresh, and fetch from all remotes" @click="refreshAndFetch">
          <RefreshCw
            :size="17"
            :stroke-width="1.5"
            :class="{ spinning: loading || (remoteOp?.command === 'fetch' && remoteBusy) }"
          />
        </button>
        <label v-if="isStashes" class="toolbar-search stash-search">
          <Search :size="15" :stroke-width="1.5" />
          <input v-model="stashQuery" placeholder="Search for Stash Message" spellcheck="false" @keydown.esc="stashQuery = ''" />
        </label>
        <label v-else-if="isPulls" class="toolbar-search stash-search">
          <Search :size="15" :stroke-width="1.5" />
          <input
            v-model="pullQuery"
            placeholder="Search Pull Requests"
            title="Words to find, or GitHub search terms such as author:octocat"
            spellcheck="false"
            @keydown.esc="pullQuery = ''"
          />
        </label>
        <label v-else-if="isIssues" class="toolbar-search stash-search">
          <Search :size="15" :stroke-width="1.5" />
          <input
            v-model="issueQuery"
            placeholder="Search Issues"
            title="Words to find, or GitHub search terms such as author:octocat"
            spellcheck="false"
            @keydown.esc="issueQuery = ''"
          />
        </label>
        <ToolbarSearch
          v-else
          ref="toolbarSearch"
          :path="overview.path"
          :rev="searchRev"
          :refresh-key="refreshKey"
          @pick="showFileHistory"
          @pick-commit="showFoundCommit"
          @filter-commits="showMatchingCommits"
        />
      </header>

      <template v-if="isWorkingCopy">
        <div class="subheader">
          <span class="file-title">{{ workingFile?.path }}</span>
        </div>
        <ConflictView v-if="workingFile?.conflicted" :path="overview.path" :file="workingFile" @changed="refresh" />
        <WorkingFileDiff v-else-if="workingFile" :path="overview.path" :file="workingFile" :undoable="undoable" @changed="refresh" />
        <div v-else class="empty-state">
          <p>Select a file to see its changes.</p>
        </div>
      </template>

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
            :issue-links="issueRemotes.length > 0"
            @show-issue="showIssue"
          />
        </template>
        <CommitDetails v-else-if="isCompare && comparison" :path="overview.path" :comparison="comparison" />
        <div v-else class="empty-state">
          <p>{{ isStashes ? "Select a stash to see its changes." : "Select a commit to see its details." }}</p>
        </div>
      </template>
    </section>

  </div>

  <main v-else-if="browsingGitHub" class="github-page">
    <GitHubView standalone @clone="cloneRepository" @back="browsingGitHub = false" />
  </main>

  <main v-else-if="starting" class="welcome">
    <span class="starting"><Spinner :size="22" /></span>
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

/* In the Issues view: whose issues they are, when the repository has more than one
   GitHub remote, and the link to the chosen one on GitHub. */
.remote-choice,
.subheader .link-button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 13px;
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
  font-size: 12px;
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

/* Below the macOS window buttons and the strip that drags the window. */
:root[data-title-bar="overlay"] .github-page {
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
