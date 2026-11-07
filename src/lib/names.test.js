import { expect, test } from "vitest";
import { untakenName } from "./names.js";

test("a name not taken is itself; a taken one is numbered, from 2, past those taken too", () => {
  expect(untakenName("fix", new Set())).toBe("fix");
  expect(untakenName("fix", new Set(["fix"]))).toBe("fix-2");
  expect(untakenName("fix", new Set(["fix", "fix-2", "fix-3"]))).toBe("fix-4");
});
