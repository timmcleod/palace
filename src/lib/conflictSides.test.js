import { expect, test } from "vitest";
import { deletion, namedSides } from "./conflictSides.js";

const branch = (name, ahead = 0) => ({ name, subject: null, ahead });
const commit = (name, subject) => ({ name, subject, ahead: 0 });

test("a merge names the branch checked out and the one merged in", () => {
  expect(namedSides({ operation: "merge", current: branch("main"), incoming: branch("feature") })).toEqual({
    current: { name: "main", label: "“main”", says: "the branch checked out" },
    incoming: { name: "feature", label: "“feature”", says: "being merged in" },
  });
});

test("a rebase names what it's onto, and the user's own commit as incoming", () => {
  const sides = { operation: "rebase", current: branch("main"), incoming: commit("a1b2c3d", "Fix login"), rebasing: "feature" };
  const { current, incoming } = namedSides(sides);
  expect([current.name, current.says]).toEqual(["main", "being rebased onto"]);
  expect([incoming.name, incoming.says]).toEqual(["a1b2c3d", "your commit “Fix login”, from feature"]);
  // With the user's commits before this one replayed onto it, its side has them too.
  expect(namedSides({ ...sides, current: branch("main", 2) }).current.says).toBe("being rebased onto, with 2 commits of yours on it so far");
});

test("a cherry-pick or revert says what's done with the commit", () => {
  const picked = namedSides({ operation: "cherry-pick", current: branch("main"), incoming: commit("a1b2c3d", "Fix login") });
  expect(picked.incoming.says).toBe("being cherry-picked “Fix login”");
  const reverted = namedSides({ operation: "revert", current: branch("main"), incoming: commit("a1b2c3d", "Fix login") });
  expect(reverted.incoming.says).toBe("undoing “Fix login”");
});

test("sides git didn't say keep git's names, unquoted, as they're no branch's", () => {
  expect(namedSides(null)).toEqual({
    current: { name: "Current", label: "Current", says: "HEAD" },
    incoming: { name: "Incoming", label: "Incoming", says: "the change being applied" },
  });
});

test("a side without the file keeps it by taking the side that has it", () => {
  const merge = { operation: "merge", current: branch("main"), incoming: branch("feature") };
  expect(deletion(merge)).toBeNull();
  expect(deletion({ ...merge, deleted_in: "incoming" })).toEqual({
    message: "“feature” (being merged in) deleted this file, and “main” (the branch checked out) changed it.",
    keep: "current",
  });
  expect(deletion({ ...merge, deleted_in: "current" }).keep).toBe("incoming");
  expect(deletion({ ...merge, deleted_in: "both" })).toEqual({ message: "Both sides deleted or moved this file.", keep: null });
});

test("a file one side added, as by moving one there, isn't said to be deleted by the other", () => {
  const merge = { operation: "merge", current: branch("main"), incoming: branch("feature"), deleted_in: "incoming", added: true };
  expect(deletion(merge)).toEqual({
    message: "“main” (the branch checked out) added this file, which “feature” (being merged in) doesn't have: it may have moved the file elsewhere.",
    keep: "current",
  });
});
