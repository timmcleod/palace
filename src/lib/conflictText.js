// A conflicted file's text, as git leaves it, read for the conflict view: which part of
// a conflict each line is in, and how many conflicts are left. And, among the working
// copy's files, which conflicted one comes next.

import { listedOrder } from "./workingOrder.js";

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
export function afterResolving(files, from, shown, asTree) {
  if (files.find((f) => f.path === from)?.conflicted) return undefined;
  return shown === from ? nextConflicted(files, from, asTree) : null;
}

/**
 * The conflicted file to go to after the one at `path`, among the working copy's
 * `files`: the next one after it as Working Copy lists them (see listedOrder), or the
 * first, past the end; null for none left.
 */
export function nextConflicted(files, path, asTree) {
  files ??= [];
  // Gone from the list, as a file resolved to the side already checked out, which
  // leaves it unchanged, it goes on from where it was: put back where git lists it, by
  // path, for the list to place it.
  if (!files.some((f) => f.path === path)) {
    const at = files.findIndex((f) => f.path > path);
    const where = at < 0 ? files.length : at;
    files = [...files.slice(0, where), { path, conflicted: false }, ...files.slice(where)];
  }
  const listed = listedOrder(files, asTree);
  const at = listed.findIndex((f) => f.path === path);
  const after = [...listed.slice(at + 1), ...listed.slice(0, Math.max(at, 0))];
  return after.find((f) => f.conflicted && f.path !== path) ?? null;
}
