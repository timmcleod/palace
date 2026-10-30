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

// "#123" in a commit message, but not "abc#123" or "&#123;".
const ISSUE_REF = /(^|[^\w&/#])#(\d+)\b/g;

/**
 * Splits text into pieces of { text } and { text, issue } (the number), for showing
 * "#123" in commit messages as links to those issues.
 */
export function splitIssueRefs(text) {
  const pieces = [];
  let at = 0;
  for (const match of text.matchAll(ISSUE_REF)) {
    const start = match.index + match[1].length;
    if (start > at) pieces.push({ text: text.slice(at, start) });
    pieces.push({ text: `#${match[2]}`, issue: Number(match[2]) });
    at = start + match[2].length + 1;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}
