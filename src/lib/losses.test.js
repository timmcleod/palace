import { expect, test } from "vitest";
import { losses, quoted } from "./losses.js";

test("says what would be lost, one or many, or nothing", () => {
  expect(losses({ doing: "Closing the tab" })).toEqual([]);
  expect(losses({ edited: ["“a.txt”", "“b.txt”"], running: ["“npm run dev”"], doing: "Closing the tab" })).toEqual([
    "Edits to “a.txt”, “b.txt” aren't saved. Closing the tab loses them.",
    "“npm run dev” is still running. Closing the tab stops it.",
  ]);
  expect(losses({ running: ["“Claude”", "“zsh”"], doing: "Quitting" })).toEqual(["2 terminals are still running: “Claude”, “zsh”. Quitting stops them."]);
});

test("counts terminals it can't name, rather than naming only some", () => {
  expect(losses({ count: 1, doing: "Quitting" })).toEqual(["A terminal is still running. Quitting stops it."]);
  expect(losses({ running: ["“zsh”"], count: 2, doing: "Quitting" })).toEqual(["2 terminals are still running. Quitting stops them."]);
});

test("quotes a name as what's said quotes it", () => {
  expect(quoted("notes.txt")).toBe("“notes.txt”");
});
