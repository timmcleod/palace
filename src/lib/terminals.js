import { markRaw, reactive } from "vue";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isMac } from "./platform.js";
import { settings } from "./settings.js";
import { OSC, SUPPORTED_REPLY, applyReport, describe, dropRunning, parseReport, summarize } from "./programStatus.js";

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
    group.tabs.filter((tab) => ids.includes(tab.id)).map((tab) => ({ label: tabLabel(tab), repository: folderName(path) })),
  );
}

const folderName = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function tabsFor(path) {
  terminals[path] ??= { tabs: [], active: null };
  // Read back, for the reactive version of what was just added.
  return terminals[path];
}

// --- Agents -----------------------------------------------------------------------

// Which agent a repository's agent tabs run, and what they're called: see agents.js.
export { AGENTS, agentCommand, agentName, DEFAULT_AGENT_COMMAND, setAgentCommand } from "./agents.js";
import { agentCommand, agentName, agentNamed, agentOfProgram } from "./agents.js";

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

  // An agent tab is called after its agent until its program names it. `status` is
  // what its program last said it's doing (see Status below), and `unseen`, that it's
  // finished or needs you since you last looked.
  const tab = reactive({
    key: nextKey++,
    kind,
    agent: kind === "agent" ? agentName(command ?? "") : null,
    title: "",
    id: null,
    status: null,
    unseen: false,
  });
  // `front` is the program in front in it, as last checked (see checkFront).
  tab.session = markRaw({
    term,
    fit,
    el,
    command,
    input,
    folder,
    started: false,
    typed: [],
    front: null,
    checkAt: 0,
    records: new Map(),
    reply: null,
    notifiedAt: 0,
    workingSince: null,
  });
  term.onTitleChange((title) => (tab.title = title));
  term.parser.registerOscHandler(OSC, (body) => onStatus(path, tab, body));
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
  const safe = withoutControls(text);
  term.paste(term.modes.bracketedPasteMode ? safe : safe.trim().replace(/\s*\n\s*/g, " "));
}

// The text, quoted from files and diffs that may be anyone's, as in a pull request,
// without control characters but line breaks and tabs: an escape sequence ending the
// paste early, or a carriage return, would otherwise press Enter partway through.
export function withoutControls(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
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
    endedRunning(tab);
  }, 500);
}

// What agents run as, rather than as themselves: Gemini CLI and Codex installed with npm
// run as node.
const RUNTIME = "node";

/**
 * Which agent Palace offers is in front in the tab, as far as it can tell, or null:
 * the one the program in front is, or where that's node, which one could run as, or
 * not known, the one the tab was opened for. Started by hand in a terminal tab, it's
 * known where it runs as itself, as Claude Code does.
 */
function agentInFront(tab) {
  const front = tab.session.front;
  if (front && front !== RUNTIME) return agentNamed(agentOfProgram(front));
  return agentNamed(tab.agent);
}

function type(tab, data) {
  // An answer to a program asking about status reports goes ahead of what's typed next,
  // in the same write, so it arrives first (see onStatus).
  const { reply } = tab.session;
  if (reply) {
    tab.session.reply = null;
    data = reply + data;
  }
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
  withdrawNotifications(tab);
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
// What Option (back and forward a word: Meta-b, Meta-f) and Cmd (start and end of the
// line: Ctrl+A, Ctrl+E; delete to its start: Ctrl+U) with these keys type on a Mac, to
// a program other than the shell (see moveAtPrompt for the shell).
const MAC_OPTION_KEYS = { ArrowLeft: "\x1bb", ArrowRight: "\x1bf" };
const MAC_CMD_KEYS = { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" };

// The shells, as the program in front: at their prompt, Option and Cmd with the arrows
// move by pressing the arrow keys (see moveAtPrompt).
const SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh", "fish"]);
const atPrompt = (tab) => {
  const front = tab.session.front?.replace(/^-/, "");
  return tab.kind !== "agent" ? !front || SHELLS.has(front) : SHELLS.has(front);
};

// At a shell's prompt, the arrow keys, pressed as many times as it takes, to go back or
// forward a word (`by` "word") or to the start or end of the line ("line"), worked out
// from the line on the screen. Ctrl+A, Ctrl+E, Meta-b and Meta-f do that only in a
// shell's emacs keys: in its vi keys, which zsh takes when EDITOR or VISUAL names vi,
// they were typed as ^A and the like. The arrows move in either. Going to the start, it
// counts the prompt too, and the shell stops at the start of what's typed.
function moveAtPrompt(tab, by, back) {
  const { term } = tab.session;
  const buffer = term.buffer.active;
  const y = buffer.baseY + buffer.cursorY;
  // The line, as typed: from the row it starts on, through the rows it wrapped onto.
  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = y;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  const chars = [];
  let cursor = null;
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    for (let col = 0; col < term.cols; col++) {
      if (row === y && col === buffer.cursorX) cursor = chars.length;
      const cell = line?.getCell(col);
      // The second half of a wide character takes no place of its own.
      if (cell && cell.getWidth() === 0) continue;
      chars.push(cell?.getChars() || " ");
    }
  }
  cursor ??= chars.length;
  const word = (ch) => /[\p{L}\p{N}_]/u.test(ch);
  let count = 0;
  if (by === "line") {
    if (back) count = cursor;
    else {
      let end = chars.length;
      while (end > cursor && chars[end - 1] === " ") end--;
      count = end - cursor;
    }
  } else if (back) {
    let at = cursor;
    while (at > 0 && !word(chars[at - 1])) at--;
    while (at > 0 && word(chars[at - 1])) at--;
    count = cursor - at;
  } else {
    let end = chars.length;
    while (end > cursor && chars[end - 1] === " ") end--;
    let at = cursor;
    while (at < end && !word(chars[at])) at++;
    while (at < end && word(chars[at])) at++;
    count = at - cursor;
  }
  if (count <= 0) return;
  const app = term.modes.applicationCursorKeysMode;
  type(tab, (app ? (back ? "\x1bOD" : "\x1bOC") : back ? "\x1b[D" : "\x1b[C").repeat(count));
}

function onKey(tab, event) {
  if (event.type !== "keydown") return true;
  // Typing in it is looking at it.
  markTabSeen(tab);
  // Where an agent Palace knows is running, Shift+Enter starts a new line in its prompt
  // instead of sending it, typing what that agent takes for one (see AGENTS). Elsewhere
  // it's Enter, as other programs expect.
  if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const agent = agentInFront(tab);
    if (agent) {
      event.preventDefault();
      type(tab, agent.newline);
      return false;
    }
  }
  // On Linux, as in its terminals, Ctrl+Shift+C copies and Ctrl+Shift+V pastes, in every
  // tab, leaving Ctrl+C to stop what's running and Ctrl+V to programs that use it: Vim,
  // and Claude Code, which pastes an image with it. Cmd+V does on a Mac, through the Edit
  // menu. Cmd+C is copied here: WebKit sees no selection in the page, since the terminal
  // draws its own, so its Copy is turned off and macOS beeps. With nothing selected, it
  // does nothing, quietly: a program like Claude Code may have selected and copied text
  // itself, with the mouse.
  if (isMac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.code === "KeyC") {
    event.preventDefault();
    if (tab.session.term.hasSelection()) copySelection(tab);
    return false;
  }
  // On a Mac, Option and Cmd with the arrows move by word and to the ends of the line,
  // and Cmd+Backspace deletes to its start, as in Terminal.app and iTerm2: these send
  // what shells take for that without any setup. Left alone, Option+Left sends
  // ESC [1;3D, which zsh and bash don't know, so a stray "D" was typed, and Cmd with an
  // arrow sent nothing.
  if (isMac && !event.ctrlKey && !event.shiftKey) {
    const keys = event.metaKey && !event.altKey ? MAC_CMD_KEYS : event.altKey && !event.metaKey ? MAC_OPTION_KEYS : null;
    const text = keys?.[event.key];
    if (text) {
      event.preventDefault();
      // At a shell's prompt, the arrows move, whichever keys the shell is set to use.
      if (event.key !== "Backspace" && atPrompt(tab)) {
        moveAtPrompt(tab, keys === MAC_CMD_KEYS ? "line" : "word", event.key === "ArrowLeft");
      } else {
        type(tab, text);
      }
      return false;
    }
  }
  // Ctrl+' (Cmd+') shows and hides the panel, in App.vue, and isn't typed.
  if ((isMac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey && event.code === "Quote") return false;
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

// --- Status -----------------------------------------------------------------------

// A program says what it's doing with the Program Status Protocol, as Claude Code does
// (see programStatus.js). It asks first whether the terminal understands, then asks the
// terminal to identify itself, and takes that answer arriving first to mean no: the
// answer here is sent with that one, ahead of it, or on its own if none follows.
function onStatus(path, tab, body) {
  const report = parseReport(body);
  if (report === "query") {
    tab.session.reply = SUPPORTED_REPLY;
    setTimeout(() => tab.session.reply && type(tab, ""));
  } else if (report) {
    applyReport(tab.session.records, report);
    updateStatus(path, tab);
  }
  return true;
}

// The states that call for the user, and so, if they're looking elsewhere, a mark on
// the tab and a notification.
const CALLS = new Set(["done", "blocked", "error"]);

function updateStatus(path, tab) {
  const record = summarize(tab.session.records);
  const before = tab.status;
  tab.status = statusOf(record);
  // When it set to work, for how long it worked: from working after anything but
  // working or waiting on the user, who answering sets it going again.
  if (record?.state === "working" && before?.state !== "working" && before?.state !== "blocked") {
    tab.session.workingSince = Date.now();
  } else if (!record || record.state === "idle") {
    tab.session.workingSince = null;
  }
  // Working again, it's been answered, or set going again, so seen. Gone idle, the
  // result's still there to look at, or the question to answer.
  if (record?.state === "working") markTabSeen(tab);
  if (!record || !CALLS.has(record.state)) return;
  if (before?.state === record.state && before?.kind === tab.status.kind) return;
  if (watched(tab)) return;
  tab.unseen = true;
  if (settings.agentNotifications) notify(path, tab, record);
}

// Whether the tab is in front of the user: shown, in the window they're using.
const watched = (tab) => document.hasFocus() && tab.session.el.isConnected && tab.session.el.clientHeight > 0;

/** Marks the tabs being looked at as seen, as when the window or the tab is shown. */
export function markSeen() {
  for (const group of Object.values(terminals)) {
    for (const tab of group.tabs) if (tab.unseen && watched(tab)) markTabSeen(tab);
  }
}

// Seen, its notifications are done with: on Linux they're withdrawn from the desktop's
// list, and so from the count on Palace's icon in the dock (see notify.rs).
function markTabSeen(tab) {
  if (!tab.unseen) return;
  tab.unseen = false;
  withdrawNotifications(tab);
}

// On Linux, takes the tab's notifications off the desktop's list (see notify.rs), as
// when it's been looked at or closed.
function withdrawNotifications(tab) {
  if (!isMac) invoke("withdraw_notifications", { key: tab.key }).catch(() => {});
}
window.addEventListener("focus", markSeen);

// A program that's ended can't still be working or waiting, whatever it last said:
// once only the shell's left, those records go.
function endedRunning(tab) {
  const { records } = tab.session;
  if (![...records.values()].some((r) => r.state === "working" || r.state === "blocked")) return;
  isBusy(tab).then((busy) => {
    if (busy || tab.id == null) return;
    dropRunning(records);
    tab.status = statusOf(summarize(records));
  });
}

// What the tab shows of a record.
const statusOf = (record) => record && { state: record.state, kind: record.kind ?? null, msg: record.msg ?? null };

// Asked for once, the first time there's something to say.
let allowed = null;

async function notify(path, tab, record) {
  const now = Date.now();
  // A program can change its state as fast as it writes: one notification a few seconds.
  // Except that it needs you, which is said whatever came just before: it waits on you.
  if (record.state !== "blocked" && now - tab.session.notifiedAt < 4000) return;
  tab.session.notifiedAt = now;
  const agent = tab.agent ?? agentOfProgram(record.app?.replace(/-code$/, ""));
  const since = tab.session.workingSince;
  const text = describe(record, agent, folderName(path), since ? now - since : null);
  if (!text) return;
  const body = text.body || tab.title;
  // In a Palace window, which may be another, it's a notice there that can bring the tab
  // forward. macOS wouldn't show the system's while Palace is in front, anyway.
  const notice = { path, key: tab.key, state: record.state, title: text.title, body };
  if (await invoke("show_notice", { notice }).catch(() => false)) return;
  allowed ??= isPermissionGranted()
    .then((granted) => granted || requestPermission().then((answer) => answer === "granted"))
    .catch(() => false);
  if (!(await allowed)) return;
  // On Linux, Palace sends it itself, to raise the window with the token the desktop
  // gives with a click (see notify.rs).
  if (!isMac && (await invoke("notify_tab", { title: text.title, body: plain(body), path, key: tab.key }).then(() => true, () => false))) return;
  // Listening first: only a notification sent while something listens reports a click.
  await listenForClicks();
  sendNotification({ title: text.title, body: plain(body), extra: { window: getCurrentWebviewWindow().label, path, key: tab.key } });
}

// Clicking one of this window's notifications brings its tab forward, as clicking a
// notice does: the window comes forward, with the repository and the tab showing. Every
// window listens, and tabs are numbered in each window, so one answers only its own.
// On macOS, clicks are reported only with notify-rust's UNUserNotificationCenter
// backend, which Cargo.toml turns on for the plugin (see there).
let listening = null;
function listenForClicks() {
  listening ??= onAction((performed) => {
    const { window: from, path, key } = performed?.notification?.extra ?? {};
    const label = getCurrentWebviewWindow().label;
    if (from !== label || typeof path !== "string" || typeof key !== "number") return;
    invoke("show_terminal_tab", { label, path, key }).catch(() => {});
  }).catch(() => null);
  return listening;
}

// What the program said is shown as it is. On Linux, notification servers read the
// body as markup, so a program could otherwise bold or link it: its <, > and & are
// escaped there. macOS shows the text as given.
const plain = (text) => (isMac ? text : text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
