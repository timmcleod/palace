import { expect, test } from "vitest";
import { afterResolving, conflictCount, conflictLines, nextConflicted } from "./conflictText.js";

const text = "top\n<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> feature\n========\nend";

test("tags each line with the part of a conflict it's in, numbering each conflict", () => {
  expect(conflictLines(text).map((l) => [l.kind, l.block])).toEqual([
    [null, null],
    ["marker", 0],
    ["current", null],
    ["marker", null],
    ["base", null],
    ["marker", null],
    ["incoming", null],
    ["marker", null],
    // A Markdown underline isn't a marker.
    [null, null],
    [null, null],
  ]);
  expect(conflictLines(null)).toEqual([]);
});

test("counts the conflicts left", () => {
  expect(conflictCount(text)).toBe(1);
  expect(conflictCount(`${text}\n${text}`)).toBe(2);
  expect(conflictCount("resolved\n")).toBe(0);
});

test("the next conflicted file is the one after, or the first past the end", () => {
  const files = [
    { path: "a.js", conflicted: true },
    { path: "b.js", conflicted: false },
    { path: "c.js", conflicted: true },
    { path: "d.js", conflicted: true },
  ];
  expect(nextConflicted(files, "a.js").path).toBe("c.js");
  expect(nextConflicted(files, "c.js").path).toBe("d.js");
  expect(nextConflicted(files, "d.js").path).toBe("a.js");
  // The one resolved may be gone from the list, as a file deleted.
  expect(nextConflicted(files, "b.js").path).toBe("c.js");
  expect(nextConflicted([{ path: "a.js", conflicted: true }], "a.js")).toBeNull();
});

// In the tree, as Working Copy can show them, folders first: as it's seen, rather than
// jumping from README.md to Z.txt and back up to src/a.js.
test("the next conflicted file is the next as Working Copy lists them", () => {
  const files = ["README.md", "Z.txt", "src/a.js"].map((path) => ({ path, conflicted: true }));
  expect(nextConflicted(files, "src/a.js", true).path).toBe("README.md");
  expect(nextConflicted(files, "README.md", true).path).toBe("Z.txt");
  expect(nextConflicted(files, "Z.txt", true).path).toBe("src/a.js");
  expect(nextConflicted(files, "README.md", false).path).toBe("Z.txt");
});

test("once one's resolved, the next shows, while it's still the one shown", () => {
  const resolved = [
    { path: "a.js", conflicted: false },
    { path: "c.js", conflicted: true },
  ];
  expect(afterResolving(resolved, "a.js", "a.js").path).toBe("c.js");
  // Read before it was resolved: waits for the next read.
  expect(afterResolving([{ path: "a.js", conflicted: true }, ...resolved.slice(1)], "a.js", "a.js")).toBeUndefined();
  // Another chosen meanwhile stays.
  expect(afterResolving(resolved, "a.js", "b.js")).toBeNull();
  expect(afterResolving([{ path: "a.js", conflicted: false }], "a.js", "a.js")).toBeNull();
});
