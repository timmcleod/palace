import { onBeforeUnmount } from "vue";
import { isMac } from "./platform.js";

/**
 * Which of Palace's window-wide shortcuts a key press is, if any, by name, or null.
 * `where` says where it was pressed and what's showing: { inTerminal, inTextField,
 * inEditor (the Files view's), dialogOpen, repository (one is open) }. On a Mac, `mac`,
 * they're Cmd; elsewhere Ctrl.
 *
 * In the order they're tried:
 *   newWindow         Cmd+N; on a Mac from a terminal too, where Cmd keys are Palace's,
 *                     while Ctrl+N is the shell's on Linux.
 *   terminal          Cmd+' shows the terminal panel and goes to it, or from it, hides it.
 *                     A terminal's programs can't use it, so it's Palace's there too. By
 *                     the key, not the character, which needs Shift on some layouts.
 *   newTerminalTab    Cmd+T, or Ctrl+Shift+T on Linux, where Ctrl+T is the shell's, from
 *                     anywhere, as in the terminal apps.
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

  if (alone && key === "n" && (mac || !inTerminal) && !dialogOpen) return "newWindow";
  if (alone && event.code === "Quote" && repository && !dialogOpen) return "terminal";
  const newTab = mac ? event.metaKey && !event.ctrlKey && !event.shiftKey : event.ctrlKey && !event.metaKey && event.shiftKey;
  if (newTab && !event.altKey && event.code === "KeyT" && repository && !dialogOpen) return "newTerminalTab";
  if (inTerminal) return null;

  if (command && !event.altKey && (key === "z" || key === "y") && !inTextField && !dialogOpen) {
    return key === "y" || event.shiftKey ? "redo" : "undo";
  }
  if (alone && key === "r" && repository && !dialogOpen) return "refresh";
  if (alone && key === "p" && repository && !dialogOpen) return "findFile";
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !inTextField && !dialogOpen) return "search";
  if (inEditor) return null;
  if (alone && key === "f") return "search";
  if (alone && key === "," && repository && !dialogOpen) return "settings";
  if (event.altKey && !inTextField && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    return event.key === "ArrowLeft" ? "back" : "forward";
  }
  return null;
}

/**
 * Listens for the shortcuts in the window while the component calling it is mounted.
 * `where(event)` says where a key was pressed (see shortcutFor), and `actions` does each
 * by name, given that; one that returns false didn't apply after all, as / with no
 * search showing, and leaves the key to whatever else takes it.
 */
export function useShortcuts(where, actions) {
  function onKeydown(event) {
    const here = where(event);
    const name = shortcutFor(event, here);
    if (name && actions[name](here) !== false) event.preventDefault();
  }
  window.addEventListener("keydown", onKeydown);
  onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
}
