// The few places Palace differs between Linux and macOS.

export const isMac = /Mac/.test(navigator.platform || navigator.userAgent);

// Whether the platform's command key is held: Cmd on a Mac, Ctrl elsewhere.
export const commandKey = (event) => (isMac ? event.metaKey : event.ctrlKey);

// The file manager, as it's named in menus.
export const fileManager = isMac ? "Finder" : "Files";

const MAC_KEYS = { Ctrl: "⌘", Shift: "⇧", Alt: "⌥", Enter: "↩" };
// Modifiers in the order macOS writes them.
const MAC_ORDER = ["Alt", "Shift", "Ctrl"];

/**
 * A shortcut written as on Linux ("Ctrl+Shift+O"), in the platform's own style:
 * unchanged on Linux, "⇧⌘O" on a Mac.
 */
export function shortcut(keys) {
  if (!isMac) return keys;
  const parts = keys.split("+");
  const key = parts.pop();
  const modifiers = parts.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  return modifiers.map((m) => MAC_KEYS[m]).join("") + (MAC_KEYS[key] ?? key);
}
