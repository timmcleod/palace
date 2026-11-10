import { Archive, CircleDot, Cloud, Folder, FolderGit2, FolderTree, GitBranch, GitPullRequest, History, Package, Tag } from "lucide-vue-next";
import { buildTree, flattenTree } from "./tree.js";

// The newest tags show, and the rest wait in a folder of their own, "Older", closed until
// it's opened: a repository that tags each release gathers many, a thousand or more,
// and the old ones are rarely what's wanted. Filtering finds among them all.
export const RECENT_TAGS = 5;
export const OLDER_TAGS = "tags-older:";

/**
 * The sidebar's sections, each { id, title, rows }, for the repository's `overview`, as
 * `view` has them:
 *   query          what the filter holds, trimmed and in lower case, or ""
 *   collapsed      the keys of the folders closed (a Set); while filtering, all open
 *   olderTagsOpen  whether the Older tags are showing
 *   issues         { count, fresh } for the Issues row, or null for none
 *   pulls          { count } for the Pull Requests row, or null for none
 *   agents         what each repository's agents are doing, by path, for its worktree
 *   order          the keys of the branches in the order they've been dragged into
 *   dividers       the dividers between them, as rows (see branchOrder.js)
 * A row is { key, label, depth, icon, … }: see the template in Sidebar.vue for the rest.
 * Worktrees, stashes and submodules show only when there are some.
 */
export function sidebarSections(overview, view) {
  const { query = "", collapsed = new Set(), olderTagsOpen = false, issues = null, pulls = null, agents = {}, order = [], dividers = [] } = view;
  const matches = (name) => !query || name.toLowerCase().includes(query);
  // While filtering, every folder opens so matches nested inside them stay visible.
  const isOpen = (key) => query !== "" || !collapsed.has(key);
  const views = { matches, isOpen };

  return [
    { id: "workspace", title: "Workspace", rows: workspaceRows(overview, issues, pulls) },
    { id: "branches", title: "Branches", rows: branchRows(overview, views, query ? [] : dividers, order) },
    { id: "worktrees", title: "Worktrees", rows: worktreeRows(overview, views, agents), optional: true },
    { id: "tags", title: "Tags", rows: tagRows(overview, views, query, olderTagsOpen) },
    { id: "remotes", title: "Remotes", rows: remoteRows(overview, views, query) },
    { id: "stashes", title: "Stashes", rows: stashRows(overview, views), optional: true },
    { id: "submodules", title: "Submodules", rows: submoduleRows(overview, views), optional: true },
  ].filter((s) => !s.optional || s.rows.length);
}

// Issues and pull requests only for repositories on GitHub.
function workspaceRows(overview, issues, pulls) {
  return [
    { key: "workspace:files", label: "Files", icon: FolderTree, depth: 0 },
    { key: "workspace:working-copy", label: "Working Copy", icon: Folder, depth: 0, count: overview.changes || null },
    { key: "workspace:stashes", label: "Stashes", icon: Archive, depth: 0, count: overview.stashes.length || null },
    issues && {
      key: "workspace:issues",
      label: "Issues",
      icon: CircleDot,
      depth: 0,
      count: issues.count || null,
      fresh: issues.fresh > 0,
      title: issues.fresh > 0 ? `${issues.fresh} new since you last looked` : null,
    },
    pulls && { key: "workspace:pulls", label: "Pull Requests", icon: GitPullRequest, depth: 0, count: pulls.count || null },
  ].filter(Boolean);
}

// In the order they've been dragged into, with their dividers, though those stay
// hidden while filtering.
function branchRows(overview, { matches, isOpen }, dividers, order) {
  return flattenTree(
    buildTree(
      overview.branches.filter((b) => matches(b.name)),
      (b) => b.name,
    ),
    {
      keyPrefix: "branch-folder:",
      isOpen,
      order,
      extraRows: dividers,
      leafRow: (b) => ({
        key: `branch:${b.name}`,
        icon: GitBranch,
        current: b.is_head,
        head: b.is_head,
        ahead: b.ahead,
        behind: b.behind,
        // Checked out in another worktree: double-clicking it opens that.
        elsewhere: b.worktree,
        title: [b.upstream ? `${b.name} → ${b.upstream}` : b.name, b.worktree && `Checked out in the worktree at ${b.worktree}`]
          .filter(Boolean)
          .join("\n"),
      }),
    },
  );
}

function tagRows(overview, { matches, isOpen }, query, olderTagsOpen) {
  // Folders, for tags named with slashes as "release/1.0", inside Older have keys of
  // their own, as one can be among the newest too.
  const tagTree = (tags, depth = 0, keyPrefix = "tag-folder:") =>
    flattenTree(buildTree(tags, (t) => t), {
      depth,
      keyPrefix,
      isOpen,
      leafRow: (t) => ({ key: `tag:${t}`, icon: Tag, title: t }),
    });
  const tags = overview.tags.filter(matches);
  // A folder for only one or two more would save nothing.
  if (query || tags.length <= RECENT_TAGS + 2) return tagTree(tags);
  const older = tags.slice(RECENT_TAGS);
  return [
    ...tagTree(tags.slice(0, RECENT_TAGS)),
    {
      key: OLDER_TAGS,
      label: "Older",
      icon: History,
      title: `${older.length} older tags`,
      depth: 0,
      parent: "",
      folder: true,
      open: olderTagsOpen,
      count: older.length,
      older: true,
    },
    ...(olderTagsOpen ? tagTree(older, 1, "tag-folder-older:") : []),
  ];
}

function remoteRows(overview, { matches, isOpen }, query) {
  return overview.remotes.flatMap((remote) => {
    const branches = remote.branches.filter(matches);
    if (query && !branches.length && !matches(remote.name)) return [];

    const key = `remote:${remote.name}/`;
    const open = isOpen(key);
    const rows = [{ key, label: remote.name, depth: 0, folder: true, open, icon: Cloud, title: remote.url }];
    if (open) {
      rows.push(
        ...flattenTree(buildTree(branches, (b) => b), {
          depth: 1,
          keyPrefix: key,
          isOpen,
          leafRow: (b) => ({ key: `remote-branch:${remote.name}/${b}`, icon: GitBranch, title: `${remote.name}/${b}` }),
        }),
      );
    }
    return rows;
  });
}

function stashRows(overview, { matches }) {
  return overview.stashes
    .filter((s) => matches(s.message))
    .map((s) => ({ key: `stash:${s.index}`, label: s.message, icon: Archive, depth: 0, title: `stash@{${s.index}}: ${s.message}` }));
}

function submoduleRows(overview, { matches }) {
  return overview.submodules
    .filter((s) => matches(s.name))
    .map((s) => ({ key: `submodule:${s.path}`, label: s.name, icon: Package, depth: 0, title: s.path }));
}

// What a worktree's agent doing says, in its row's tooltip.
const AGENT_SAYS = {
  working: "Its agent is working",
  blocked: "Its agent needs you",
  done: "Its agent has finished",
  error: "Its agent stopped with an error",
};

// The repository's worktrees, its own first: each named for its folder, beside the
// branch checked out in it, and what its agent is doing, in any window.
function worktreeRows(overview, { matches }, agents) {
  return (overview.worktrees ?? [])
    .filter((w) => matches(w.path) || (w.branch && matches(w.branch)))
    .map((w) => ({
      key: `worktree:${w.path}`,
      label: w.path.split("/").at(-1),
      detail: w.prunable ? "folder gone" : (w.branch ?? "detached"),
      icon: FolderGit2,
      depth: 0,
      current: w.current,
      locked: w.locked,
      gone: w.prunable,
      agent: AGENT_SAYS[agents[w.path]] ? agents[w.path] : null,
      title: [
        w.path,
        AGENT_SAYS[agents[w.path]],
        w.main && "The repository's own working copy",
        w.locked && "Locked",
        w.prunable && "Its folder is gone: Prune Worktrees forgets it",
      ]
        .filter(Boolean)
        .join("\n"),
    }));
}
