import { expect, test } from "vitest";
import { branchForTask } from "./tasks.js";

test("a task's branch is named after its first few words", () => {
  expect(branchForTask("Fix the login redirect when the session expires")).toBe("fix-the-login-redirect-when-the");
  expect(branchForTask("Add `--dry-run` to the release script!")).toBe("add-dry-run-to-the-release");
  expect(branchForTask("Übersetzung für die Einstellungen")).toBe("übersetzung-für-die-einstellungen");
});

test("a task's branch is short, and named even with no words to name it by", () => {
  expect(branchForTask("Refactor everything in the extraordinarily complicated synchronization layer").length).toBeLessThanOrEqual(40);
  expect(branchForTask("a".repeat(60))).toBe("a".repeat(40));
  expect(branchForTask("!!! ???")).toBe("task");
  expect(branchForTask("")).toBe("task");
});

test("a task's branch isn't one the repository has", () => {
  const taken = new Set(["fix-typo", "fix-typo-2"]);
  expect(branchForTask("Fix typo", taken)).toBe("fix-typo-3");
  expect(branchForTask("Fix other typo", taken)).toBe("fix-other-typo");
});
