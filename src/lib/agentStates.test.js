import { expect, test } from "vitest";
import { allAgentStates, morePressing } from "./agentStates.js";

test("of two states, the one that calls for the user more", () => {
  expect(morePressing("working", "blocked")).toBe("blocked");
  expect(morePressing("error", "done")).toBe("error");
  expect(morePressing(null, "working")).toBe("working");
  expect(morePressing("done", null)).toBe("done");
});

test("every window's agents together, the most pressing for a repository two share", () => {
  const all = allAgentStates({
    main: { "/a": "working", "/b": "done" },
    "window-2": { "/a": "blocked", "/c": "working", "/d": "something new" },
  });
  expect(all).toEqual({ "/a": "blocked", "/b": "done", "/c": "working" });
  expect(allAgentStates(null)).toEqual({});
});
