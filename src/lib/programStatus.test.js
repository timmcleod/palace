import { expect, test } from "vitest";
import { applyReport, dropRunning, parseReport, summarize } from "./programStatus.js";

const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
// The records after each report in turn, as a terminal keeps them.
function recordsAfter(...bodies) {
  const records = new Map();
  for (const body of bodies) applyReport(records, parseReport(body));
  return records;
}

test("reads a report, a query, and leaves out what it can't trust", () => {
  expect(parseReport("?")).toBe("query");
  expect(parseReport(`state=blocked:kind=permission:app=claude-code:id=a/b:msg=${b64("Allow “rm”?")}`)).toEqual({
    id: "a/b",
    state: "blocked",
    kind: "permission",
    app: "claude-code",
    msg: "Allow “rm”?",
  });
  expect(parseReport("state=sleeping")).toBeNull();
  expect(parseReport("state=working:id=a//b")).toBeNull();
  // A message with a control character in it would throw what's shown about.
  expect(parseReport(`state=done:msg=${b64("a\u0007b")}`)).toBeNull();
});

test("a report replaces its own record, and clear takes it and those beneath it", () => {
  const records = recordsAfter("state=working", "state=working:id=build", "state=blocked:id=build/test", "state=done:id=other");
  expect([...records.keys()]).toEqual(["", "build", "build/test", "other"]);
  applyReport(records, parseReport("state=clear:id=build"));
  expect([...records.keys()]).toEqual(["", "other"]);
  applyReport(records, parseReport("state=clear"));
  expect(records.size).toBe(0);
});

test("shows one waiting on the user first, then one working, over one that's finished", () => {
  // Claude Code reports its background tasks apart from itself: one finished stays so
  // until it's cleared, while the session goes on working.
  const working = recordsAfter("state=done:id=task-1", "state=working");
  expect(summarize(working).state).toBe("working");
  expect(summarize(recordsAfter("state=error:id=task-1", "state=working")).state).toBe("working");
  expect(summarize(recordsAfter("state=working", "state=blocked:id=task-1")).state).toBe("blocked");
  // At the prompt, what's finished, or stopped, is what's to look at.
  expect(summarize(recordsAfter("state=done:id=task-1", "state=idle")).state).toBe("done");
  expect(summarize(recordsAfter("state=done", "state=error:id=task-1")).state).toBe("error");
  expect(summarize(new Map())).toBeNull();
});

test("what's running goes with the program, and what it finished stays", () => {
  const records = recordsAfter("state=working", "state=blocked:id=a", "state=done:id=b");
  dropRunning(records);
  expect([...records.keys()]).toEqual(["b"]);
});
