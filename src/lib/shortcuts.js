import { onBeforeUnmount } from "vue";
import { isMac } from "./platform.js";

/**
 * Which of Palace's window-wide shortcuts a key press is, if any, by name, or null.
 * `where` says where it was pressed and what's showing: { inTerminal, inTextField,
 * inEditor (the Files view's), dialogOpen, repository (one is open) }. On a Mac, `mac`,
 * they're Cmd; elsewhere Ctrl.
 *
 * In the order they're tried:
 *   newTab            Cmd+T opens a tab, and newWindow, Cmd+N, a window, as in a browser;
 *                     closeTab, Cmd+W, closes the tab showing; showTab, Cmd+1 to Cmd+9,
 *                     shows that tab, Cmd+9 the last. On a Mac from a terminal too, where
 *                     Cmd keys are Palace's, while on Linux, Ctrl+T, Ctrl+N, Ctrl+W and
 *                     the rest are the shell's there; and Ctrl+W in a text field is left
 *                     to it, as it deletes a word in some, rather than closing the tab and
 *                     what's being written with it. On a Mac, the menu's items take the
 *                     first three before the page sees them (see menu.rs).
 *   nextTab,          Ctrl+Tab and Ctrl+Shift+Tab, from anywhere, as in a browser, and on
 *   previousTab       a Mac, Cmd+Shift+] and Cmd+Shift+[ too.
 *   terminal          Cmd+' shows the terminal panel and goes to it, or from it, hides it.
 *                     A terminal's programs can't use it, so it's Palace's there too. By
 *                     the key, not the character, which needs Shift on some layouts.
 *   newTerminalTab    Cmd+Shift+T, or Ctrl+Shift+T on Linux, from anywhere: Cmd+T, as the
 *                     terminal apps have it, opens one of the window's tabs.
 *   (Anything else typed in a terminal is the terminal's.)
 *   undo, redo        Cmd+Z, and Cmd+Shift+Z or Cmd+Y, except in text fields and
 *                     dialogs, which keep their own.
 *   refresh           Cmd+R reloads the repository and fetches, rather than the window.
 *   findFile          Cmd+P finds a file to open in the Files view.
 *   search            / goes to the toolbar's search, as on GitHub, where it isn't typed:
 *                     not in a text field (the editor's one) or a terminal, where Claude
 *                     Code's commands start with it. So does Cmd+F, except in the editor,
 *                     which finds in the file.
 *   settings          Cmd+, opens Settings.
 *   back, forward     Alt+← and Alt+→, except in text fields, where on a Mac they move by
 *                     word.
 */
export function shortcutFor(event, where, mac = isMac) {
  const { inTerminal, inTextField, inEditor, dialogOpen, repository } = where;
  const key = event.key.toLowerCase();
  const command = mac ? event.metaKey : event.ctrlKey;
  // Cmd with a key, and no Shift or Alt.
  const alone = command && !event.shiftKey && !event.altKey;

  const palaces = (mac || !inTerminal) && !dialogOpen;
  // By the letter, as N and W are, and undo's Z and Y: by where T is on a US keyboard,
  // Ctrl+Y on Dvorak, which is redo, would open a tab.
  if (alone && key === "t" && palaces) return "newTab";
  if (alone && key === "n" && palaces) return "newWindow";
  if (alone && key === "w" && palaces && (mac || !inTextField)) return "closeTab";
  if (alone && /^Digit[1-9]$/.test(event.code) && palaces) return "showTab";
  const tab = event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab";
  const bracket = mac && event.metaKey && event.shiftKey && !event.altKey && (event.code === "BracketRight" || event.code === "BracketLeft");
  if ((tab || bracket) && !dialogOpen) return (tab ? event.shiftKey : event.code === "BracketLeft") ? "previousTab" : "nextTab";
  if (alone && event.code === "Quote" && repository && !dialogOpen) return "terminal";
  if (command && event.shiftKey && !event.altKey && key === "t" && repository && !dialogOpen) return "newTerminalTab";
  if (inTerminal) return null;

  if (command && !event.altKey && (key === "z" || key === "y") && !inTextField && !dialogOpen) {
    return key === "y" || event.shiftKey ? "redo" : "undo";
  }
  if (alone && key === "r" && repository && !dialogOpen) return "refresh";
  if (alone && key === "p" && repository && !dialogOpen) return "findFile";
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !inTextField && !dialogOpen) return "search";
  if (inEditor) return null;
  if (alone && key === "f" && !dialogOpen) return "search";
  if (alone && key === "," && repository && !dialogOpen) return "settings";
  if (event.altKey && !inTextField && !dialogOpen && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    return event.key === "ArrowLeft" ? "back" : "forward";
  }
  return null;
}

/** Whether a key pressed at `target` goes into a text field, which keeps some keys. */
export const inTextField = (target) => !!target.closest?.("input, textarea, select, [contenteditable]");

/**
 * Listens for the shortcuts in the window while the component calling it is mounted.
 * `where(event)` says where a key was pressed (see shortcutFor), and `actions` does each
 * by name, given that and the key's event; one that returns false didn't apply after
 * all, as / with no search showing, and leaves the key to whatever else takes it. Those
 * it has no action for, it leaves to another: the window's, for tabs, and its workspace's
 * own. Only while `active()`, the workspace calling it is showing, does it act on them.
 */
export function useShortcuts(where, actions, { active = () => true } = {}) {
  function onKeydown(event) {
    if (!active()) return;
    const here = where(event);
    const name = shortcutFor(event, here);
    if (name && actions[name] && actions[name](here, event) !== false) event.preventDefault();
  }
  window.addEventListener("keydown", onKeydown);
  onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
}
