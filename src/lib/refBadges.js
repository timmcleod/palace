// A commit's branches and tags in the history, as badges: one for each kind it has, with
// how many, and every name in full on hover (see HistoryList.vue). Names can be long, and
// several can point at one commit, so they never crowd out the message.

import { Cloud, GitBranch, Tag } from "lucide-vue-next";

/** The icon of each kind, the same wherever a branch or tag shows (see RefName.vue). */
export const REF_ICONS = { local: GitBranch, remote: Cloud, tag: Tag };

// The kinds, in the order their badges and lists show: what each is called on hover.
const KINDS = [
  { kind: "local", title: "Branches" },
  { kind: "remote", title: "Remote branches" },
  { kind: "tag", title: "Tags" },
];

// The most names of a kind the card lists; past that it says how many more.
export const CARD_NAMES = 8;

/**
 * `refs` ({ name, kind } as history.rs gives them: "head", "local", "remote", "tag") as
 * badges: [{ kind, title, names, count, head }], one for each kind it has; the branches'
 * badge has `head` where the commit is checked out. And `head`, whether it is. A
 * detached HEAD, with no branch here, still gets a branch badge, with no names, so
 * where you are shows.
 */
export function refBadges(refs) {
  const head = refs.some((r) => r.kind === "head");
  const badges = KINDS.map(({ kind, title }) => {
    const names = refs.filter((r) => r.kind === kind).map((r) => r.name);
    return {
      kind,
      title,
      names,
      count: names.length,
      head: head && kind === "local",
      // What the card lists, and how many it leaves out.
      shown: names.slice(0, CARD_NAMES),
      more: Math.max(0, names.length - CARD_NAMES),
    };
  }).filter((badge) => badge.count || (badge.kind === "local" && head));
  return { head, badges };
}
