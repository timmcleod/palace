import { expect, test } from "vitest";
import { programOf, taskCommand } from "./agents.js";

test("the program a command runs is its first word after any settings", () => {
  expect(programOf("claude --resume")).toBe("claude");
  expect(programOf("  FOO=1 BAR=2 codex  ")).toBe("codex");
  expect(programOf("")).toBe("");
});

test("each agent Palace knows starts on the task in $PALACE_TASK, its own way", () => {
  expect(taskCommand("claude")).toBe('claude -- "$PALACE_TASK"');
  expect(taskCommand("codex")).toBe('codex -- "$PALACE_TASK"');
  // Gemini CLI stays open after it only with -i.
  expect(taskCommand("gemini")).toBe('gemini -i "$PALACE_TASK"');
});

test("an agent command's own options stay, the task after them, not taken for one's value", () => {
  expect(taskCommand("claude --add-dir ../lib ")).toBe('claude --add-dir ../lib -- "$PALACE_TASK"');
  expect(taskCommand("ANTHROPIC_MODEL=x claude")).toBe('ANTHROPIC_MODEL=x claude -- "$PALACE_TASK"');
});

test("an option that resumes one agent's session is another's own option", () => {
  // -c is Claude Code's --continue, but Codex's --config.
  expect(taskCommand("codex -c model_reasoning_effort=high")).toBe('codex -c model_reasoning_effort=high -- "$PALACE_TASK"');
  expect(taskCommand("claude -c")).toBeNull();
});

test("a command that's more than one, where the task could go to another, takes no task", () => {
  for (const command of ["claude --model opus; say done", "claude # mine", "claude | tee log", "claude > log", "claude $(cat flags)", "claude `flags`", "claude & wait"]) {
    expect(taskCommand(command), command).toBeNull();
  }
});

test("a command that resumes a session, or that Palace doesn't know, takes no task", () => {
  expect(taskCommand("claude --resume")).toBeNull();
  expect(taskCommand("claude -c")).toBeNull();
  expect(taskCommand("codex resume")).toBeNull();
  expect(taskCommand("aider")).toBeNull();
  expect(taskCommand("cd api && claude")).toBeNull();
});
