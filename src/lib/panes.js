import { reactive } from "vue";
import { readJson, writeJson } from "./storage.js";

// How wide the sidebar and the history are, and how tall the terminal panel is: one set
// for every tab, which each shows its panes at, so moving one in a tab moves it in all
// of them, and what's kept is what was last moved.

const KEY = "palace.paneWidths";

export const panes = reactive({ sidebar: 300, history: 580, terminal: 300, ...readJson(KEY, {}) });

// How tall the row of tabs across the window's top is, if there is one (see styles.css).
const tabRowHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tab-row-height")) || 0;

/** The terminal panel's tallest: room left for the panes above it, under any tabs. */
export const tallestTerminal = () => Math.max(160, window.innerHeight - 200 - tabRowHeight());

/** Makes the terminal panel no taller than it can be now, as when the row of tabs comes. */
export function fitTerminal() {
  panes.terminal = Math.min(panes.terminal, tallestTerminal());
}

/** Keeps the panes' sizes as they are now, for Palace's next start. */
export const savePanes = () => writeJson(KEY, { sidebar: panes.sidebar, history: panes.history, terminal: panes.terminal });
