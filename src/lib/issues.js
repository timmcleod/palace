import { invoke } from "@tauri-apps/api/core";

// What the Issues view shares between its list and the open issue: each repository's
// labels, assignable people and whether the account may triage, loaded once.
const filters = new Map();

/** { labels, assignees, can_triage } for a repository ({ owner, repo }). */
export function issueFilters({ owner, repo }) {
  const key = `${owner}/${repo}`.toLowerCase();
  if (!filters.has(key)) {
    filters.set(
      key,
      invoke("github_issue_filters", { owner, repo }).catch(() => {
        filters.delete(key);
        return { labels: [], assignees: [], can_triage: false };
      }),
    );
  }
  return filters.get(key);
}

/** Forgets what was loaded, so labels added on GitHub show up after a refresh. */
export function forgetIssueFilters() {
  filters.clear();
}

// Refusals about the token start with this (see issues.rs), for a way to change it.
const TOKEN_HELP = "TOKEN: ";
export const FINE_GRAINED_TOKENS_URL = "https://github.com/settings/personal-access-tokens";

/** An error as { text, aboutToken }. */
export function issueError(error) {
  const text = String(error);
  return text.startsWith(TOKEN_HELP) ? { text: text.slice(TOKEN_HELP.length), aboutToken: true } : { text, aboutToken: false };
}
