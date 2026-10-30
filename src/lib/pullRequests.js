// Starting a pull request for a branch: where it would come from and go to, and a
// title and description to begin with.
import { githubRepoOf, repoKey } from "./githubRemote.js";

/**
 * How a pull request for the local branch `name` would be made, or null when it
 * can't be: the branch tracks a remote that isn't on GitHub, or there's no GitHub
 * remote to publish it to. `target` ({ owner, repo }) is where it goes.
 *
 * Resolves to { target, branch, remote, name, head, push, baseRemote }: the branch
 * goes to `remote` as `name`, which GitHub calls `head` ("name", or "owner:name" from
 * a fork). `push` is "publish" when the branch isn't on the remote yet, "push" when
 * it has commits the remote doesn't, or null. `baseRemote` is the remote that points
 * to `target`, for comparing with its branches locally, or null.
 */
export function pullRequestPlan(overview, target, name) {
  const branch = overview?.branches.find((b) => b.name === name);
  if (!branch || !target) return null;
  const remotes = overview.remotes;
  const onGitHub = (remote) => githubRepoOf(remote?.url);

  let remote = null;
  let remoteName = name;
  if (branch.upstream) {
    // The longest matching name, in case one remote's name starts another's.
    remote = remotes.filter((r) => branch.upstream.startsWith(`${r.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (!onGitHub(remote)) return null;
    remoteName = branch.upstream.slice(remote.name.length + 1);
  } else {
    const origin = remotes.find((r) => r.name === "origin");
    remote = onGitHub(origin) ? origin : remotes.find(onGitHub);
    if (!remote) return null;
  }

  const from = onGitHub(remote);
  const baseRemote = remotes.find((r) => onGitHub(r) && repoKey(onGitHub(r)) === repoKey(target))?.name ?? null;
  return {
    target,
    branch: name,
    remote: remote.name,
    name: remoteName,
    head: repoKey(from) === repoKey(target) ? remoteName : `${from.owner}:${remoteName}`,
    push: !branch.upstream ? "publish" : branch.ahead > 0 ? "push" : null,
    baseRemote,
  };
}

/**
 * A title and description to start from, as GitHub does: a single commit's subject
 * and body, or for several, the branch name in words and a list of the commits.
 * The repository's template, when it has one, is the description instead.
 * `messages` are the commits' messages, newest first.
 */
export function startingText(messages, template, branch) {
  const subject = (message) => message.split("\n")[0];
  if (messages.length === 1) {
    const [title, ...rest] = messages[0].split("\n");
    return { title, body: template ?? rest.join("\n").trim() };
  }
  const list = [...messages].reverse().map((m) => `- ${subject(m)}`).join("\n");
  return { title: titleFromBranch(branch), body: template ?? list };
}

/** "feature/add-dark-mode" as "Add dark mode". */
export function titleFromBranch(name) {
  const words = name.split("/").at(-1).replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
