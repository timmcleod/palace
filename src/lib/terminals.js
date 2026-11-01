import { markRaw, reactive } from "vue";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { readJson, writeJson } from "./storage.js";
import { isMac } from "./platform.js";

// The terminals in the panel below the history, by repository: each tab is the user's
// shell, started in the repository's folder (see terminal.rs). They keep running
// while another repository is shown, until their tab is closed or the shell exits.

// path -> { tabs, active }: the tabs in order, and the key of the one shown.
export const terminals = reactive({});
let nextKey = 1;

export function tabsFor(path) {
  terminals[path] ??= { tabs: [], active: null };
  // Read back, for the reactive version of what was just added.
  return terminals[path];
}

// --- Claude Code ------------------------------------------------------------------

// The command a Claude tab runs, for each repository that doesn't use the default.
const CLAUDE_COMMANDS_KEY = "palace.claudeCommands";
export const DEFAULT_CLAUDE_COMMAND = "claude";

export const claudeCommand = (path) => readJson(CLAUDE_COMMANDS_KEY, {})[path] || DEFAULT_CLAUDE_COMMAND;

export function setClaudeCommand(path, command) {
  const commands = readJson(CLAUDE_COMMANDS_KEY, {});
  if (command.trim() && command.trim() !== DEFAULT_CLAUDE_COMMAND) commands[path] = command.trim();
  else delete commands[path];
  writeJson(CLAUDE_COMMANDS_KEY, commands);
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
 */
export function openTerminal(path, { command = null, kind = "shell" } = {}) {
  const group = tabsFor(path);
  const term = new Terminal({
    fontFamily: 'ui-monospace, "Ubuntu Mono", "DejaVu Sans Mono", Menlo, monospace',
    fontSize: isMac ? 12 : 14,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: theme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_, url) => openUrl(url)));
  const el = document.createElement("div");
  el.className = "terminal-host";

  const tab = reactive({ key: nextKey++, kind, title: "", id: null });
  tab.session = markRaw({ term, fit, el, command, started: false, typed: [] });
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
  output.onmessage = (data) => session.term.write(new Uint8Array(data));
  const exited = new Channel();
  exited.onmessage = () => removeTab(path, tab);
  try {
    tab.id = await invoke("terminal_open", { path, cols: session.term.cols, rows: session.term.rows, output, exited });
  } catch (e) {
    session.term.write(`\r\n${e}\r\n`);
    return;
  }
  if (session.command) type(tab, `${session.command}\r`);
  for (const data of session.typed.splice(0)) type(tab, data);
}

/** Sizes the terminal to its part of the panel, unless the panel is hidden. */
export function fitTab(tab) {
  const { el, fit } = tab.session;
  if (el.isConnected && el.clientHeight > 0 && el.clientWidth > 0) fit.fit();
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

/**
 * Pastes the clipboard's text. With `orKey`, a clipboard without any, such as one
 * holding an image, passes the key on instead (Ctrl+V), for Claude Code to paste it.
 */
export async function paste(tab, { orKey = null } = {}) {
  const text = await readText().catch(() => "");
  if (text) tab.session.term.paste(text);
  else if (orKey) type(tab, orKey);
}

// Keys the terminal handles as terminals on the desktop do. False keeps the key from the
// program in the terminal.
function onKey(tab, event) {
  if (event.type !== "keydown") return true;
  // Shift+Enter starts a new line in Claude Code's prompt instead of sending it, as
  // Option+Enter does: Escape then Return.
  if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    type(tab, "\x1b\r");
    return false;
  }
  // On Linux, Ctrl+Shift+C copies, leaving Ctrl+C to stop what's running, and Ctrl+V
  // or Ctrl+Shift+V pastes. Cmd+C and Cmd+V do on a Mac, through the Edit menu.
  if (!isMac && event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.shiftKey && event.code === "KeyC") {
      event.preventDefault();
      copySelection(tab);
      return false;
    }
    if (event.code === "KeyV") {
      event.preventDefault();
      paste(tab, { orKey: event.shiftKey ? null : "\x16" });
      return false;
    }
  }
  return true;
}
