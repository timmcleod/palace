// A commit's branches and tags in the history, as badges: one for each kind it has, with
// how many, and every name in full on hover (see HistoryList.vue). Names can be long, and
// several can point at one commit, so they never crowd out the message. HEAD, where the
// commit is checked out, is a pill of its own beside them. With Settings › Branch and tag
// names in the history, the first few are spelled out instead (`named`).

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

// The most names a row spells out; past that it says how many more, listed on hover.
export const ROW_NAMES = 3;

/**
 * `refs` ({ name, kind } as history.rs gives them: "head", "local", "remote", "tag") as
 * badges: [{ kind, title, names, count, shown, more }], one for each kind of branch or
 * tag it has; `head`, whether the commit is checked out; and `named`, { shown, more,
 * rest }, the first names to spell out in their badges' order ({ kind, name }), how
 * many that leaves, and their names.
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
      // What the card lists, and how many it leaves out.
      shown: names.slice(0, CARD_NAMES),
      more: Math.max(0, names.length - CARD_NAMES),
    };
  }).filter((badge) => badge.count);
  const all = badges.flatMap(({ kind, names }) => names.map((name) => ({ kind, name })));
  const rest = all.slice(ROW_NAMES).map((r) => r.name);
  const named = { shown: all.slice(0, ROW_NAMES), more: rest.length, rest };
  return { head, badges, named };
}
