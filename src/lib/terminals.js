import { markRaw, reactive } from "vue";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { isMac } from "./platform.js";

// The terminals in the panel below the history, by repository: each tab is the user's
// shell, started in the repository's folder (see terminal.rs). They keep running
// while another repository is shown, until their tab is closed or the shell exits.

// path -> { tabs, active }: the tabs in order, and the key of the one shown.
export const terminals = reactive({});
let nextKey = 1;

/** What the tab's called: the title its program gives it, or what it is. */
export const tabLabel = (tab) => tab.title || (tab.kind === "agent" ? tab.agent : "Terminal");

/** The tabs with these terminal ids, each as { label, repository }. */
export function describeTerminals(ids) {
  return Object.entries(terminals).flatMap(([path, group]) =>
    group.tabs
      .filter((tab) => ids.includes(tab.id))
      .map((tab) => ({ label: tabLabel(tab), repository: path.split(/[\\/]/).filter(Boolean).pop() ?? path })),
  );
}

export function tabsFor(path) {
  terminals[path] ??= { tabs: [], active: null };
  // Read back, for the reactive version of what was just added.
  return terminals[path];
}

// --- Agents -----------------------------------------------------------------------

// Which agent a repository's agent tabs run, and what they're called: see agents.js.
export { agentCommand, agentName, DEFAULT_AGENT_COMMAND, setAgentCommand } from "./agents.js";
import { agentCommand, agentName } from "./agents.js";

// How Anthropic says to install Claude Code, on a Mac and on Linux, and where to read
// about other ways (https://code.claude.com/docs/en/setup).
export const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
export const CLAUDE_SETUP_URL = "https://code.claude.com/docs/en/setup";

/** The program a command runs: its first word, after any VAR=value settings. */
export function programOf(command) {
  return command.trim().split(/\s+/).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
}

// --- Colors -----------------------------------------------------------------------

// The 16 colors programs choose from, readable on Palace's light and dark backgrounds.
const ANSI = {
  light: {
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#7d4e00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
    selectionBackground: "rgba(31, 124, 242, 0.25)",
  },
  dark: {
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
    selectionBackground: "rgba(59, 143, 246, 0.35)",
  },
};

function theme() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const color = (name) => style.getPropertyValue(name).trim();
  return {
    ...ANSI[root.dataset.theme === "dark" ? "dark" : "light"],
    background: color("--content-bg"),
    foreground: color("--text-primary"),
    cursor: color("--accent"),
    cursorAccent: color("--content-bg"),
  };
}

// The terminals follow the theme as it changes.
new MutationObserver(() => {
  const colors = theme();
  for (const group of Object.values(terminals)) {
    for (const tab of group.tabs) tab.session.term.options.theme = colors;
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-diff-colors"] });

// --- Tabs -------------------------------------------------------------------------

/**
 * Adds a tab to the repository's terminals and shows it. Its shell starts once the
 * panel has shown it (see startTab), and then runs `command`, if any, as if typed.
 * `input` is typed too, but left for the user to run. The shell starts in `folder`
 * inside the repository, or at its top.
 */
export function openTerminal(path, { command = null, input = null, kind = "shell", folder = "" } = {}) {
  const group = tabsFor(path);
  const term = new Terminal({
    fontFamily: 'ui-monospace, "Ubuntu Mono", "DejaVu Sans Mono", Menlo, monospace',
    fontSize: isMac ? 12 : 14,
    cursorBlink: true,
    scrollback: 10000,
    // Trackpads on a Mac scroll the terminal slowly at xterm's usual speed, next to the
    // rest of the system. Option scrolls faster still, as everywhere.
    scrollSensitivity: isMac ? 3 : 1,
    allowProposedApi: true,
    macOptionIsMeta: true,
    // Where a program takes the mouse, as Claude Code does, dragging goes to it rather
    // than selecting. Shift+drag selects anyway on Linux, as xterm always has, and
    // Option+drag on a Mac, as in Terminal and iTerm2.
    macOptionClickForcesSelection: true,
    theme: theme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_, url) => openUrl(url)));
  const el = document.createElement("div");
  el.className = "terminal-host";

  // An agent tab is called after its agent until its program names it.
  const tab = reactive({ key: nextKey++, kind, agent: kind === "agent" ? agentName(command ?? "") : null, title: "", id: null });
  // `front` is the program in front in it, as last checked (see checkFront).
  tab.session = markRaw({ term, fit, el, command, input, folder, started: false, typed: [], front: null, checkAt: 0 });
  term.onTitleChange((title) => (tab.title = title));
  term.onData((data) => type(tab, data));
  term.onResize(({ cols, rows }) => tab.id && invoke("terminal_resize", { id: tab.id, cols, rows }).catch(() => {}));
  term.attachCustomKeyEventHandler((event) => onKey(tab, event));

  group.tabs.push(tab);
  group.active = tab.key;
  return tab;
}

/** Starts the tab's shell, once its terminal is on the page and can be measured. */
export async function startTab(path, tab) {
  const session = tab.session;
  if (session.started) return;
  session.started = true;
  session.term.open(session.el);
  fitTab(tab);

  const output = new Channel();
  output.onmessage = (data) => {
    session.lastOutput = Date.now();
    session.term.write(new Uint8Array(data));
    checkFront(tab);
  };
  const exited = new Channel();
  exited.onmessage = () => removeTab(path, tab);
  try {
    const cwd = session.folder ? `${path}/${session.folder}` : path;
    tab.id = await invoke("terminal_open", { path: cwd, cols: session.term.cols, rows: session.term.rows, output, exited });
  } catch (e) {
    session.term.write(`\r\n${e}\r\n`);
    return;
  }
  if (session.command) type(tab, `${session.command}\r`);
  // Typed but left for the user to run, as an install command is.
  if (session.input) type(tab, session.input);
  for (const data of session.typed.splice(0)) type(tab, data);
}

/**
 * Puts `text` in the prompt of the repository's agent, as if pasted, without sending
 * it: in the agent tab showing, or else the last one opened, or else a new one, once
 * its agent has started. Resolves to the tab, or null if a new agent never started.
 */
export async function sendToAgent(path, text) {
  const group = tabsFor(path);
  const agents = group.tabs.filter((tab) => tab.kind === "agent");
  let tab = agents.find((t) => t.key === group.active) ?? agents.at(-1);
  if (tab) {
    group.active = tab.key;
    pasteInto(tab, text);
    return tab;
  }
  tab = openTerminal(path, { command: agentCommand(path), kind: "agent" });
  if (!(await agentStarted(tab))) return null;
  pasteInto(tab, text);
  return tab;
}

// Pasted as a terminal pastes, marked as a paste for programs that ask, as agents do,
// so its line breaks stay in the prompt. To one that doesn't, each would be Enter and
// send the text a line at a time, so it gets the text as one line instead.
function pasteInto(tab, text) {
  const { term } = tab.session;
  term.paste(term.modes.bracketedPasteMode ? text : text.trim().replace(/\s*\n\s*/g, " "));
}

// Whether the agent a new tab runs has started and settled: something other than the
// shell is in front, and it's printed nothing for a moment. Not, after half a minute,
// as when it isn't installed, so nothing's pasted into the shell instead.
async function agentStarted(tab) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    await wait(250);
    if (!tab.session.started || tab.id == null) continue;
    if (!(await isBusy(tab))) continue;
    if (Date.now() - (tab.session.lastOutput ?? 0) > 1200) return true;
  }
  return false;
}

/** Sizes the terminal to its part of the panel, unless the panel is hidden. */
export function fitTab(tab) {
  const { el, fit } = tab.session;
  if (el.isConnected && el.clientHeight > 0 && el.clientWidth > 0) fit.fit();
}

// Which program is in front in the terminal, checked as it prints, at most twice a
// second: Claude Code prints as it starts and stops, so it's known before its keys are
// pressed, with no waiting at the key.
function checkFront(tab) {
  const session = tab.session;
  const now = Date.now();
  if (tab.id == null || now < session.checkAt) return;
  session.checkAt = now + 500;
  setTimeout(() => {
    if (tab.id == null) return;
    invoke("terminal_foreground", { id: tab.id })
      .then((name) => (session.front = name))
      .catch(() => {});
  }, 500);
}

/**
 * Whether Claude Code is what's in front in the tab, as far as Palace can tell. Not
 * knowing, or seeing only node, which Claude Code installed with npm runs as on a Mac,
 * it goes by whether the tab was opened for Claude.
 */
function inClaude(tab) {
  const front = tab.session.front;
  return front && front !== "node" ? front === "claude" : tab.agent === "Claude";
}

function type(tab, data) {
  if (tab.id == null) tab.session.typed.push(data);
  else invoke("terminal_write", { id: tab.id, data }).catch(() => {});
}

/** Whether something other than the shell is running in it, such as a dev server. */
export const isBusy = (tab) => (tab.id == null ? Promise.resolve(false) : invoke("terminal_busy", { id: tab.id }).catch(() => false));

/** Closes the tab, hanging up its shell, and shows the one beside it. */
export function removeTab(path, tab) {
  const group = tabsFor(path);
  const index = group.tabs.indexOf(tab);
  if (index < 0) return;
  group.tabs.splice(index, 1);
  if (group.active === tab.key) group.active = (group.tabs[index] ?? group.tabs[index - 1])?.key ?? null;
  if (tab.id != null) invoke("terminal_close", { id: tab.id }).catch(() => {});
  tab.session.term.dispose();
  tab.session.el.remove();
}

// The clipboard is read and written through Tauri: the web view won't let a page read
// it on Linux.
export function copySelection(tab) {
  const text = tab.session.term.getSelection();
  if (text) writeText(text).catch(() => {});
}

/** Pastes the clipboard's text. */
export async function paste(tab) {
  const text = await readText().catch(() => "");
  if (text) tab.session.term.paste(text);
}

// Keys the terminal handles as terminals on the desktop do. False keeps the key from the
// program in the terminal.
function onKey(tab, event) {
  if (event.type !== "keydown") return true;
  // Where Claude Code is running, in an agent tab or started by hand, Shift+Enter starts
  // a new line in its prompt instead of sending it, as Option+Enter does: Escape then
  // Return. Elsewhere it's Enter, as other programs expect.
  if (inClaude(tab) && event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    type(tab, "\x1b\r");
    return false;
  }
  // On Linux, as in its terminals, Ctrl+Shift+C copies and Ctrl+Shift+V pastes, in every
  // tab, leaving Ctrl+C to stop what's running and Ctrl+V to programs that use it: Vim,
  // and Claude Code, which pastes an image with it. Cmd+C and Cmd+V do on a Mac, through
  // the Edit menu.
  if (!isMac && event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.shiftKey && event.code === "KeyC") {
      event.preventDefault();
      copySelection(tab);
      return false;
    }
    if (event.shiftKey && event.code === "KeyV") {
      event.preventDefault();
      paste(tab);
      return false;
    }
  }
  return true;
}
