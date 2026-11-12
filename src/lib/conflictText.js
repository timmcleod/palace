// A conflicted file's text, as git leaves it, read for the conflict view: which part of
// a conflict each line is in, and how many conflicts are left. And, among the working
// copy's files, which conflicted one comes next.

// Whether a line is one of git's markers: exactly seven of `char`, then the end of the
// line or, except for =======, a space and a label. A Markdown underline isn't one.
function isMarker(line, char) {
  const rest = line.replace(/\r$/, "");
  if (!rest.startsWith(char.repeat(7))) return false;
  const after = rest.slice(7);
  return after === "" || (char !== "=" && after.startsWith(" "));
}

/**
 * Each line of `text`, as { number, text, kind, block }: `kind` is the part of a
 * conflict it's in, "current", "base" or "incoming", "marker" for one of git's markers,
 * or null outside conflicts; `block` numbers each conflict, from 0, on its first line.
 * Git writes:  <<<<<<< current … ||||||| base (diff3 style only) … ======= … >>>>>>> incoming
 */
export function conflictLines(text) {
  if (text == null) return [];
  let region = null;
  let blocks = 0;
  return text.split("\n").map((line, i) => {
    let kind = region;
    let block = null;
    if (isMarker(line, "<") && !region) {
      kind = "marker";
      region = "current";
      block = blocks++;
    } else if (isMarker(line, "|") && region === "current") {
      kind = "marker";
      region = "base";
    } else if (isMarker(line, "=") && (region === "current" || region === "base")) {
      kind = "marker";
      region = "incoming";
    } else if (isMarker(line, ">") && region === "incoming") {
      kind = "marker";
      region = null;
    }
    return { number: i + 1, text: line, kind, block };
  });
}

/** How many conflicts are left in `text`. */
export const conflictCount = (text) => conflictLines(text).filter((line) => line.block != null).length;

/**
 * Where to go once the conflicted file at `from` is resolved, as the working copy's
 * `files` are read again: undefined while they still have it conflicted, as when read
 * before it was resolved, to wait for the next read; otherwise the conflicted file to
 * show next, or null to stay, with none left, or with another file chosen meanwhile,
 * `shown` no longer the one resolved.
 */
export function afterResolving(files, from, shown) {
  if (files.find((f) => f.path === from)?.conflicted) return undefined;
  return shown === from ? nextConflicted(files, from) : null;
}

/**
 * The conflicted file to go to after the one at `path`, among the working copy's
 * `files`: the next one after it, or the first, past the end; null for none left.
 */
export function nextConflicted(files, path) {
  const conflicted = (files ?? []).filter((f) => f.conflicted && f.path !== path);
  return conflicted.find((f) => f.path > path) ?? conflicted[0] ?? null;
}
