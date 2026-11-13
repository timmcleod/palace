import { watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { untakenName } from "./names.js";

// Commits a branch has lost outside this window: moved back, as by `git reset --hard` in
// a terminal, or deleted, leaving commits that nothing else has. Git keeps them only for
// a while, in its reflog, so the tab says so as soon as it sees it, with a way to have
// them back as a branch. A rewrite (amend, rebase) isn't counted, as what the old
// commits held lives on (see lost.rs), nor what this tab's own operations do, which
// can be undone. Nor, so as not to take its doing for another's, what happens while one
// of them runs.

/**
 * The branches that moved or went between two overviews' `before` and `after` branch
 * lists: { name, old, new }, with `new` null for one that's gone.
 */
export function branchChanges(before, after) {
  const now = new Map(after.map((b) => [b.name, b.tip ?? null]));
  return before
    .filter((b) => b.tip && now.get(b.name) !== b.tip)
    .map((b) => ({ name: b.name, old: b.tip, new: now.has(b.name) ? now.get(b.name) : null }));
}

const commits = (count) => (count === 1 ? "a commit" : `${count >= 1000 ? "a thousand or more" : count} commits`);

/** What the tab says about `lost`, each { name, new, count }: { title, message }. */
export function describeLost(lost) {
  const [one] = lost;
  const title =
    lost.length > 1
      ? `${lost.length} branches lost commits`
      : one.new
        ? `“${one.name}” moved back, leaving ${commits(one.count)} on no branch`
        : `“${one.name}” was deleted, with ${commits(one.count)} on no other branch`;
  const lines = lost.length > 1 ? lost.map((l) => `“${l.name}” ${l.new ? "moved back, leaving" : "was deleted, with"} ${commits(l.count)}.`) : [];
  return {
    title,
    message: [
      ...lines,
      "This wasn't done in this tab: an agent, a command in a terminal, or another Palace tab or window may have done it. Git keeps lost commits for a while; restored as a branch, they're kept.",
    ].join("\n"),
  };
}

/** A name for a branch to restore `name`'s commits on, as "main-restored", not one in `taken`. */
export const restoredName = (name, taken) => untakenName(`${name}-restored`, taken);

/**
 * Watches the tab's repository for branches losing commits, outside it. `overview` is
 * its overview ref, each with `readAt`, and `loadsStarted()` how many reads have started
 * (see repository.js); `busy()` whether an operation of the tab's is running;
 * `show(card)` puts a card in the status area (see statusCard.js); and `run(titles,
 * command, args)` runs a git operation (see gitRun.js), here to restore them.
 */
export function useLostCommits({ overview, loadsStarted, busy, show, run }) {
  // Overviews read while an operation of the tab's ran, or before it ended, aren't
  // compared: the one read after is, with the next, so what the operation did is never
  // taken for a loss. By when they were read, not when they came: a slow one can come
  // after the operation's done.
  let readBefore = 0;
  // The branches last compared, of the repository at `path`, or null to start again:
  // from the one showing, if any, as watching starts.
  let baseline = overview.value ? { path: overview.value.path, branches: overview.value.branches } : null;
  // Checks take turns, so none is lost to the next; a card found while an operation
  // runs waits for it, rather than take its place: { path, card }, shown only if its
  // repository's still the one open.
  let checks = Promise.resolve();
  let waiting = null;

  watch(busy, (now) => {
    readBefore = now ? Infinity : loadsStarted();
    if (!now && waiting) {
      if (overview.value?.path === waiting.path) show(waiting.card);
      waiting = null;
    }
  });

  watch(overview, (now) => {
    const before = baseline;
    const stale = !now || (now.readAt ?? Infinity) <= readBefore;
    baseline = stale ? null : { path: now.path, branches: now.branches };
    if (stale || !before || before.path !== now.path) return;
    checks = checks.then(() => check(now.path, before.branches, now.branches));
  });

  async function check(path, before, after) {
    const lost = [];
    for (const change of branchChanges(before, after)) {
      const count = await invoke("commits_left_behind", { path, old: change.old, new: change.new }).catch(() => 0);
      if (count) lost.push({ ...change, count });
    }
    // Another repository opened meanwhile: it's about the one before.
    if (!lost.length || overview.value?.path !== path) return;
    const card = { ...describeLost(lost), state: "conflict", actions: [{ label: lost.length > 1 ? "Restore as Branches" : "Restore as Branch", run: () => restore(lost) }] };
    if (busy()) waiting = { path, card };
    else show(card);
  }

  async function restore(lost) {
    const path = overview.value.path;
    const taken = new Set(overview.value.branches.map((b) => b.name));
    for (const { name, old } of lost) {
      // Another repository opened meanwhile: the rest are this one's, not that one's.
      if (overview.value?.path !== path) return;
      const branch = restoredName(name, taken);
      taken.add(branch);
      await run(["Restoring…", `Restored as “${branch}”`, "Couldn't restore the commits"], "create_branch", { name: branch, start: old, checkout: false });
    }
  }
}
