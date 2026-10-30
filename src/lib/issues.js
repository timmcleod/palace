import { invoke } from "@tauri-apps/api/core";
import { readJson, writeJson } from "./storage.js";

// What the Issues view shares between its list and the open issue: each repository's
// labels, assignable people and whether the account may triage. They're loaded again
// after a few minutes, so labels added on GitHub show up.
const FRESH_FOR = 5 * 60 * 1000;
const filters = new Map();

/** { labels, assignees, can_triage } for a repository ({ owner, repo }). */
export function issueFilters({ owner, repo }) {
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = filters.get(key);
  if (!cached || Date.now() - cached.at > FRESH_FOR) {
    const loading = invoke("github_issue_filters", { owner, repo }).catch(() => {
      filters.delete(key);
      return { labels: [], assignees: [], can_triage: false };
    });
    filters.set(key, { at: Date.now(), loading });
  }
  return filters.get(key).loading;
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

// When each repository's issues were last looked at, so newer ones can be marked new.
const SEEN_KEY = "palace.issuesSeen";

/** When the repository's issues were last looked at (an ISO time), or null if never. */
export function issuesSeenAt({ owner, repo }) {
  return readJson(SEEN_KEY, {})[`${owner}/${repo}`.toLowerCase()] ?? null;
}

/** Records that the repository's issues have been looked at, as of now. */
export function markIssuesSeen({ owner, repo }) {
  writeJson(SEEN_KEY, { ...readJson(SEEN_KEY, {}), [`${owner}/${repo}`.toLowerCase()]: new Date().toISOString() });
}
