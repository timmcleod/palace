// Which agent each repository's agent tabs run, and what they're called. Kept apart
// from terminals.js, which brings the terminal with it, for what only needs the name.

import { reactive } from "vue";
import { onSavedElsewhere, readJson, writeJson } from "./storage.js";

// The command an agent tab runs, for each repository that doesn't use the default:
// Claude Code, or another agent that runs in a terminal, such as Codex or Gemini.
// (Kept under its old name, from when only Claude was meant.)
const AGENT_COMMANDS_KEY = "palace.claudeCommands";
export const DEFAULT_AGENT_COMMAND = "claude";

const agentCommands = reactive(readJson(AGENT_COMMANDS_KEY, {}));
onSavedElsewhere((key, value) => {
  if (key !== AGENT_COMMANDS_KEY) return;
  for (const path of Object.keys(agentCommands)) delete agentCommands[path];
  Object.assign(agentCommands, value);
});

export const agentCommand = (path) => agentCommands[path] || DEFAULT_AGENT_COMMAND;

export function setAgentCommand(path, command) {
  if (command.trim() && command.trim() !== DEFAULT_AGENT_COMMAND) agentCommands[path] = command.trim();
  else delete agentCommands[path];
  writeJson(AGENT_COMMANDS_KEY, { ...agentCommands });
}

// The agents Palace offers by name, in the terminal panel's ⋯ menu: Claude Code first,
// the default. Each says how to install it, what Shift+Enter types in its prompt to
// start a new line rather than send (Esc then Enter for Claude Code, and Ctrl+J for
// Codex and Gemini CLI), and what its command line takes to start on a task, staying
// open after, for New Agent Task: "--" first, so a task can't be taken for an option.
export const AGENTS = [
  {
    name: "Claude",
    title: "Claude Code",
    program: "claude",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    setup: "https://code.claude.com/docs/en/setup",
    newline: "\x1b\r",
    taskArgs: "--",
    resumes: ["--resume", "-r", "--continue", "-c"],
  },
  {
    name: "Codex",
    title: "Codex CLI",
    program: "codex",
    install: "npm install -g @openai/codex",
    setup: "https://github.com/openai/codex",
    newline: "\n",
    taskArgs: "--",
    resumes: ["resume"],
  },
  {
    name: "Gemini",
    title: "Gemini CLI",
    program: "gemini",
    install: "npm install -g @google/gemini-cli",
    setup: "https://github.com/google-gemini/gemini-cli",
    newline: "\n",
    // Without -i, Gemini CLI answers it and stops.
    taskArgs: "-i",
  },
];

/** The program a command runs: its first word, after any VAR=value settings. */
export function programOf(command) {
  return command.trim().split(/\s+/).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
}

// What would make the shell run the task's part of a command elsewhere, or not at all:
// another command after it, a pipe, a redirect, a comment, a substitution.
const SHELL_SYNTAX = /[;&|#<>`]|\$\(/;

/**
 * The agent `command`, as the repository's agent command, run to start on the task in
 * $PALACE_TASK, for New Agent Task (see terminal_open): given on its command line rather than
 * typed into it, so it waits through whatever the agent asks first, such as whether to
 * trust the new worktree's folder. The task itself isn't on the command line, where the
 * shell would read it, only the variable, which it passes on as it is. Null for a command
 * whose agent Palace doesn't know how to give one to, that resumes a session (each
 * agent's `resumes`, after which a task would be taken for the session's name), or
 * that's more than one command, where the task could go to another.
 */
export function taskCommand(command) {
  const agent = AGENTS.find((a) => a.program === programOf(command));
  if (!agent?.taskArgs || SHELL_SYNTAX.test(command)) return null;
  if (command.trim().split(/\s+/).some((word) => agent.resumes?.includes(word))) return null;
  return `${command.trim()} ${agent.taskArgs} "$PALACE_TASK"`;
}

/** The agent Palace offers by that name, such as "Codex", if it's one. */
export const agentNamed = (name) => AGENTS.find((agent) => agent.name === name) ?? null;

// What the agents people run in terminals are called, by their programs' names.
const AGENT_NAMES = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  // Their npm packages, as run with npx: @anthropic-ai/claude-code, @google/gemini-cli.
  "claude-code": "Claude",
  "gemini-cli": "Gemini",
  copilot: "Copilot",
  "cursor-agent": "Cursor",
  opencode: "opencode",
  aider: "Aider",
  amp: "Amp",
  goose: "Goose",
  qwen: "Qwen",
  crush: "Crush",
};

/** The agent a program is, by its name, such as "Codex" for "codex", or null. */
export const agentOfProgram = (program) => AGENT_NAMES[program?.toLowerCase()] ?? null;

// The agents that sign commits they co-author, by the address each signs with, and its
// icon among the file icons (Material Icon Theme's, see fileIcons.js), with whether that
// has a version for the light theme. By address, not name: people are called Claude too.
// Codex signs too (noreply@openai.com), but has no icon there, so it shows as a person.
const SIGNING_AGENTS = [
  { name: "Claude", icon: "claude", light: false, signs: (email) => email === "noreply@anthropic.com" },
  // As VS Code writes it, or as GitHub's noreply address for its Copilot account.
  { name: "Copilot", icon: "copilot", light: true, signs: (email) => email === "copilot@github.com" || /^\d+\+copilot@users\.noreply\.github\.com$/.test(email) },
  // Its agent, at cursor.com, or cursor.sh as it was.
  { name: "Cursor", icon: "cursor", light: true, signs: (email) => /^cursoragent@cursor\.(com|sh)$/.test(email) },
];

/**
 * The agent a commit's author or co-author is, by their email: { name, icon, light },
 * or null for a person.
 */
export function signingAgent({ email }) {
  const address = email?.trim().toLowerCase() ?? "";
  const agent = SIGNING_AGENTS.find((a) => a.signs(address));
  return agent ? { name: agent.name, icon: agent.icon, light: agent.light } : null;
}

// Commands that run another, which isn't what to call the tab.
const LAUNCHERS = new Set(["cd", "env", "exec", "npx", "bunx", "pnpx", "uvx", "nice", "time", "&&", ";"]);

/**
 * What to call an agent tab running `command`: the agent's name, where it's one
 * Palace knows, as in "npx @openai/codex" or "cd api && claude", or else the
 * program's, capitalized.
 */
export function agentName(command) {
  const words = command.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const base = (word) => word.slice(word.lastIndexOf("/") + 1).toLowerCase();
  for (const word of words) {
    const known = AGENT_NAMES[base(word)];
    if (known) return known;
  }
  const program = words.map(base).find((word) => !LAUNCHERS.has(word) && !word.startsWith("-"));
  return program ? program[0].toUpperCase() + program.slice(1) : "Agent";
}

