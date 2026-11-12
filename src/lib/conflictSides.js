// A conflict's two sides, as the conflict view names them: not git's "current" and
// "incoming" alone, which a rebase turns around from what's expected (its "current" is
// the branch rebased onto, and "incoming" the user's own commit), but what each is.

const commits = (n) => `${n} commit${n === 1 ? "" : "s"}`;

/**
 * Each side of a conflict, from what conflict_sides says of it (see conflict.rs), as
 * { name, label, says }: `name` for its buttons, a branch or a short hash; `label`,
 * that in quotes, for a sentence; and `says`, what it is, in a few words. A side git
 * didn't say, as for a stash applied, keeps git's own name, unquoted, as it's no branch.
 */
export function namedSides(sides) {
  const op = sides?.operation;
  const subject = (side) => (side?.subject ? ` “${side.subject}”` : "");
  const { current, incoming } = sides ?? {};
  // A rebase's current side is what it's onto, with the user's commits replayed on it
  // so far, which its side of the file has too.
  const replayed = current?.ahead ? `, with ${commits(current.ahead)} of yours on it so far` : "";
  const says = {
    merge: ["the branch checked out", "being merged in"],
    rebase: [`being rebased onto${replayed}`, `your commit${subject(incoming)}${sides?.rebasing ? `, from ${sides.rebasing}` : ""}`],
    "cherry-pick": ["the branch checked out", `being cherry-picked${subject(incoming)}`],
    revert: ["the branch checked out", `undoing${subject(incoming)}`],
  }[op] ?? ["HEAD", "the change being applied"];
  const named = (side, fallback, what) =>
    side?.name ? { name: side.name, label: `“${side.name}”`, says: what } : { name: fallback, label: fallback, says: what };
  return { current: named(current, "Current", says[0]), incoming: named(incoming, "Incoming", says[1]) };
}

/**
 * What a conflict where a side doesn't have the file asks of the user, or null for one
 * where both do: `message` says what happened, and `keep` is the side to resolve it to
 * for keeping it (see resolve_conflict), null where neither has it. Deleting it is
 * resolving it as "deleted".
 */
export function deletion(sides) {
  const missing = sides?.deleted_in;
  if (!missing) return null;
  const { current, incoming } = namedSides(sides);
  if (missing === "both") return { message: "Both sides deleted or moved this file.", keep: null };
  const [without, has, keep] = missing === "current" ? [current, incoming, "incoming"] : [incoming, current, "current"];
  // Not there before either changed things: one side added it, as by moving a file
  // there, rather than the other deleting it.
  const message = sides.added
    ? `${has.label} (${has.says}) added this file, which ${without.label} (${without.says}) doesn't have: it may have moved the file elsewhere.`
    : `${without.label} (${without.says}) deleted this file, and ${has.label} (${has.says}) changed it.`;
  return { message, keep };
}
