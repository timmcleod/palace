import { reactive } from "vue";
import { keepInSync, readJson, writeJson } from "./storage.js";

// Review comments: notes on lines of a diff, kept for each repository until they're
// sent to its agent (see sendToAgent), which puts them all in its prompt, and so done
// with them here.
//
// Each is { id, file, where, lines, body }: `where` is the diff it's on
// ("unstaged", "staged", "commit:<id>" or "compare:<base>..<head>"), and `lines` the
// lines it's on, as the diff had them ({ kind, old, new, text }), which place it again
// as the diff changes.

const KEY = "palace.reviewComments";

// Repository path -> its comments, oldest first.
export const reviews = reactive(withoutSent(readJson(KEY, {})));

// Comments were once kept, marked sent, after they'd gone to the agent; those are done.
function withoutSent(all) {
  for (const [path, comments] of Object.entries(all ?? {})) {
    all[path] = comments.filter((c) => !c.sent);
    if (!all[path].length) delete all[path];
  }
  return all ?? {};
}

keepInSync(KEY, reviews, withoutSent);

function save() {
  for (const [path, comments] of Object.entries(reviews)) if (!comments.length) delete reviews[path];
  writeJson(KEY, reviews);
}

// Unique across windows, which share the comments: ids counted from when a window
// opened could match another's opened the same moment.
const newId = () => crypto.randomUUID();

/** The comments on `file` in the diff `where`. */
export const commentsOn = (path, file, where) => (reviews[path] ?? []).filter((c) => c.file === file && c.where === where);

/** The repository's comments. */
export const commentsIn = (path) => reviews[path] ?? [];

export function addComment(path, { file, where, lines, body }) {
  (reviews[path] ??= []).push({
    id: newId(),
    file,
    where,
    lines: lines.map(({ kind, old, new: added, text }) => ({ kind, old: old ?? null, new: added ?? null, text })),
    body,
  });
  save();
}

export function editComment(path, id, body) {
  const comment = reviews[path]?.find((c) => c.id === id);
  if (!comment) return;
  comment.body = body;
  save();
}

export function deleteComment(path, id) {
  deleteComments(path, [id]);
}

export function deleteComments(path, ids) {
  if (!reviews[path]) return;
  reviews[path] = reviews[path].filter((c) => !ids.includes(c.id));
  save();
}

export function clearComments(path) {
  delete reviews[path];
  save();
}

/** Where on the file the lines are: "line 42", "lines 42–44", or for removed lines only, "removed lines 42–44". */
export function linesLabel(lines) {
  const added = lines.map((l) => l.new).filter((n) => n != null);
  const numbers = added.length ? added : lines.map((l) => l.old).filter((n) => n != null);
  const from = Math.min(...numbers);
  const to = Math.max(...numbers);
  const range = from === to ? `line ${from}` : `lines ${from}–${to}`;
  return added.length ? range : `removed ${range}`;
}

const SIGN = { "+": "+", "-": "-", " ": " " };
const MAX_QUOTED = 12;

function whereLabel(where) {
  if (where.startsWith("commit:")) return `, in commit ${where.slice(7, 14)}`;
  if (where.startsWith("compare:")) return `, comparing ${where.slice(8).replace("..", " with ")}`;
  return "";
}

/** The comments as one message to the agent: each with its file, lines, and the lines themselves. */
export function reviewMessage(comments) {
  const blocks = comments.map((c) => {
    const quoted = c.lines.slice(0, MAX_QUOTED).map((l) => `    ${SIGN[l.kind] ?? " "} ${l.text}`);
    if (c.lines.length > MAX_QUOTED) quoted.push("    …");
    return [`${c.file}, ${linesLabel(c.lines)}${whereLabel(c.where)}:`, ...quoted, c.body.trim()].join("\n");
  });
  return `Some review comments on your changes:\n\n${blocks.join("\n\n")}\n`;
}
