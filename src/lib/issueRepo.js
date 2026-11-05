import { computed, onBeforeUnmount, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { githubAccount, githubAccountChecked } from "./github.js";
import { githubRemotes, repoKey } from "./githubRemote.js";
import { issuesSeenAt, markIssuesSeen } from "./issues.js";
import { openMenu } from "./overlays.js";
import { settings } from "./settings.js";
import { readJson, writeJson } from "./storage.js";

// The repository on GitHub that the Issues and Pull Requests views show, for a
// repository with a remote there: which one it is, which of issues and pull requests
// it has turned on, and how many are open, for the sidebar.
//
// The issues are origin's repository's (or the first GitHub remote's), unless that's
// a fork: then they're the parent's, where a project's issues usually are. Choosing
// another in the menu is remembered for the repository.
const ISSUE_REPOS_KEY = "palace.issueRepos";

/**
 * overview: the repository overview ref. isIssues and isPulls: whether the Issues or
 * Pull Requests view is showing. onChange(): called when the issues' repository, or
 * the account looking at it, changes, before anything is asked of it, so what was
 * chosen in the views can be let go.
 */
export function useIssueRepo({ overview, isIssues, isPulls, onChange }) {
  const issueRemotes = computed(() => githubRemotes(overview.value));
  // Issues and Pull Requests are in the sidebar for repositories on GitHub, unless Palace
  // is signed out of GitHub. Until it knows, they stay, rather than flicker as it starts.
  const showsIssues = computed(() => issueRemotes.value.length > 0 && (!!githubAccount.value || !githubAccountChecked.value));
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

  function chooseIssueRepo(repo) {
    issueChoice.value = repoKey(repo);
    writeJson(ISSUE_REPOS_KEY, { ...readJson(ISSUE_REPOS_KEY, {}), [overview.value.path]: issueChoice.value });
  }

  // The menu of repositories to show issues from, below the button clicked.
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

  // Which of issues and pull requests the repository has turned on, { issues, pulls },
  // or null until GitHub has said. What's off is left out of the sidebar; until it's
  // known, or if asking fails, both stay, so nothing disappears for a network hiccup.
  const repoFeatures = ref(null);
  const hasIssues = computed(() => repoFeatures.value?.issues !== false);
  const hasPulls = computed(() => repoFeatures.value?.pulls !== false);

  // How many issues and pull requests are open, null until known, and how many of the
  // issues are new: opened since the Issues view was last looked at. They're checked
  // when the repository opens, then every few minutes in the background, as often as
  // fetching.
  const openIssues = ref(null);
  const openPulls = ref(null);
  const freshIssues = ref(0);
  // When the issues were last looked at, as of opening the Issues view, so the issues
  // newer than that can be marked new in the list.
  const issuesSeenBefore = ref(null);
  let issuesCheckedAt = 0;

  // An issue or pull request opened or closed here, from `before` to `after` ("open",
  // "closed", or none for a new one), counts toward what's open at once. `kind` is
  // "issues" or "pulls".
  function countStateChange(kind, before, after) {
    const count = kind === "pulls" ? openPulls : openIssues;
    if (count.value != null && before !== after) count.value += after === "open" ? 1 : -1;
  }

  async function checkIssues() {
    const repo = issueRepo.value;
    if (!repo || !githubAccount.value) return;
    issuesCheckedAt = Date.now();
    const features = await invoke("github_repo_features", { owner: repo.owner, repo: repo.repo }).catch(() => null);
    const stillThis = () => issueRepo.value && repoKey(issueRepo.value) === repoKey(repo);
    if (features && stillThis()) repoFeatures.value = features;
    if (hasIssues.value) await countIssues(repo);
    if (!hasPulls.value) return;
    const pulls = await invoke("github_issues", { owner: repo.owner, repo: repo.repo, filters: "is:open", page: 1, pulls: true }).catch(
      () => null,
    );
    if (pulls && stillThis()) openPulls.value = pulls.total;
  }

  async function countIssues(repo) {
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

  watch(
    [() => issueRepo.value?.owner, () => issueRepo.value?.repo, () => githubAccount.value?.login],
    () => {
      openIssues.value = null;
      freshIssues.value = 0;
      openPulls.value = null;
      repoFeatures.value = null;
      onChange();
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

  return {
    issueRemotes,
    showsIssues,
    issueRepos,
    issueRepo,
    chooseIssueRepo,
    issueRepoMenu,
    hasIssues,
    hasPulls,
    openIssues,
    openPulls,
    freshIssues,
    issuesSeenBefore,
    countStateChange,
  };
}
