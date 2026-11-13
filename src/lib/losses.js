// What closing a tab or a window, or quitting, would lose, said before it does: edits
// not saved, and programs running in terminals. One way of saying it, for each of them.

/**
 * The lines saying what `doing` ("Closing the tab", "Quitting") would lose: `edited`,
 * the files with edits not saved, and `running`, the terminals with something running
 * in them, each already quoted as it's to be said. `count` is how many terminals, when
 * it's more than those named, as one the page can't name. Empty for nothing lost.
 */
export function losses({ edited = [], running = [], count = running.length, doing }) {
  const lines = [];
  if (edited.length) lines.push(`Edits to ${edited.join(", ")} aren't saved. ${doing} loses them.`);
  if (count === 1) lines.push(`${running[0] ?? "A terminal"} is still running. ${doing} stops it.`);
  else if (count) {
    // Named only when all of them can be: otherwise some would seem left out.
    const named = running.length === count ? `: ${running.join(", ")}` : "";
    lines.push(`${count} terminals are still running${named}. ${doing} stops them.`);
  }
  return lines;
}

/** `name` quoted, as files and terminals are named in what's said. */
export const quoted = (name) => `“${name}”`;
