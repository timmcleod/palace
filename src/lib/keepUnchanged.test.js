import { expect, test } from "vitest";
import { keepUnchanged } from "./keepUnchanged.js";

test("keeps the earlier copy of what's read again unchanged", () => {
  const before = { hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "+", text: "a" }] }] };
  const again = { hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "+", text: "a" }] }] };
  expect(keepUnchanged(before, again)).toBe(before);
});

test("takes what's new when it differs, or when either is missing", () => {
  const before = { hunks: [{ lines: [{ kind: "+", text: "a" }] }] };
  const changed = { hunks: [{ lines: [{ kind: "+", text: "b" }] }] };
  expect(keepUnchanged(before, changed)).toBe(changed);
  expect(keepUnchanged(null, changed)).toBe(changed);
  expect(keepUnchanged(before, null)).toBe(null);
});
