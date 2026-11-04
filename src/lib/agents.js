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
// the default. Each says how to install it, and what Shift+Enter types in its prompt to
// start a new line rather than send: Esc then Enter for Claude Code, and Ctrl+J for
// Codex and Gemini CLI.
export const AGENTS = [
  {
    name: "Claude",
    title: "Claude Code",
    program: "claude",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    setup: "https://code.claude.com/docs/en/setup",
    newline: "\x1b\r",
  },
  {
    name: "Codex",
    title: "Codex CLI",
    program: "codex",
    install: "npm install -g @openai/codex",
    setup: "https://github.com/openai/codex",
    newline: "\n",
  },
  {
    name: "Gemini",
    title: "Gemini CLI",
    program: "gemini",
    install: "npm install -g @google/gemini-cli",
    setup: "https://github.com/google-gemini/gemini-cli",
    newline: "\n",
  },
];

/** The agent Palace offers by that name, such as "Codex", if it's one. */
export const agentNamed = (name) => AGENTS.find((agent) => agent.name === name) ?? null;

// What the agents people run in terminals are called, by their programs' names.
const AGENT_NAMES = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
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

