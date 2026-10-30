// Which GitHub repositories the open repository's remotes point to, for the Issues
// view. Remotes elsewhere, or behind an SSH host alias, aren't recognized.

/** The GitHub repository a remote URL points to, as { owner, repo }, or null. */
export function githubRepoOf(url) {
  const match = url?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** "owner/repo", the same however it was capitalized. */
export const repoKey = (r) => `${r.owner}/${r.repo}`.toLowerCase();

/**
 * The GitHub repositories the remotes point to, as { owner, repo, remotes }, each
 * once however many remotes share it, with origin's first.
 */
export function githubRemotes(overview) {
  const repos = new Map();
  for (const remote of overview?.remotes ?? []) {
    const found = githubRepoOf(remote.url);
    if (!found) continue;
    const key = repoKey(found);
    if (!repos.has(key)) repos.set(key, { ...found, remotes: [] });
    repos.get(key).remotes.push(remote.name);
  }
  const hasOrigin = (r) => r.remotes.includes("origin");
  return [...repos.values()].sort((a, b) => hasOrigin(b) - hasOrigin(a));
}

/** The remote that points to the GitHub repository `fullName` ("owner/repo"), if any. */
export function githubRemoteOf(remotes, fullName) {
  if (!fullName) return undefined;
  return remotes.find((remote) => {
    const found = githubRepoOf(remote.url);
    return found && repoKey(found) === fullName.toLowerCase();
  });
}
