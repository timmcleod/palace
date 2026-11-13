import { reactive } from "vue";
import { readJson, writeJson } from "./storage.js";

// How wide the sidebar and the history are, and how tall the terminal panel is: one set
// for every tab, which each shows its panes at, so moving one in a tab moves it in all
// of them, and what's kept is what was last moved.

const KEY = "palace.paneWidths";

export const panes = reactive({ sidebar: 300, history: 580, terminal: 300, ...readJson(KEY, {}) });

/** Keeps the panes' sizes as they are now, for Palace's next start. */
export const savePanes = () => writeJson(KEY, { sidebar: panes.sidebar, history: panes.history, terminal: panes.terminal });
