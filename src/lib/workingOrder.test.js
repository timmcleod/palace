import { expect, test } from "vitest";
import { listedOrder } from "./workingOrder.js";

const files = (...paths) => paths.map((path) => ({ path }));
const paths = (list) => list.map((f) => f.path);

// As git gives them: by path, capitals first.
const given = files("README.md", "Z.txt", "docs/Guide.md", "nested/", "src/b.js", "src/lib/a.js", "src/a.js");

test("as a list, the files are as git gives them", () => {
  expect(listedOrder(given, false)).toBe(given);
});

// A repository inside this one, "nested/", is a row of its own among the files.
test("as a tree, each folder's folders come first, by name whatever its case, then its files", () => {
  expect(paths(listedOrder(given, true))).toEqual(["docs/Guide.md", "src/lib/a.js", "src/b.js", "src/a.js", "README.md", "Z.txt", "nested/"]);
  expect(paths(listedOrder(files("b/x", "A/y", "a.txt"), true))).toEqual(["A/y", "b/x", "a.txt"]);
});
