// The Markdown editor's formatting, as changes to { value, start, end }: the text and
// the selection in it. Each returns the new text and selection, or null when it
// doesn't apply, so the editor can leave the key to the browser.

const lineStart = (value, at) => value.lastIndexOf("\n", at - 1) + 1;
function lineEnd(value, at) {
  const end = value.indexOf("\n", at);
  return end === -1 ? value.length : end;
}

/** Wraps the selection in `marker` (such as "**"), or unwraps it if it's wrapped already. */
export function wrap({ value, start, end }, marker) {
  const n = marker.length;
  if (value.slice(start - n, start) === marker && value.slice(end, end + n) === marker) {
    return { value: value.slice(0, start - n) + value.slice(start, end) + value.slice(end + n), start: start - n, end: end - n };
  }
  return { value: value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end), start: start + n, end: end + n };
}

/** Code: backticks around a selection within a line, or a fenced block around lines. */
export function code(state) {
  const { value, start, end } = state;
  if (!value.slice(start, end).includes("\n")) return wrap(state, "`");
  const from = lineStart(value, start);
  const to = lineEnd(value, end);
  const block = "```\n" + value.slice(from, to) + "\n```";
  return { value: value.slice(0, from) + block + value.slice(to), start: from + 4, end: from + block.length - 4 };
}

const URL = /^https?:\/\/\S+$/;

/**
 * A link: the selected words become the link text with "url" selected to type over,
 * or a selected URL becomes the address with the text left to type.
 */
export function link({ value, start, end }) {
  const selected = value.slice(start, end);
  if (URL.test(selected)) {
    const text = `[](${selected})`;
    return { value: value.slice(0, start) + text + value.slice(end), start: start + 1, end: start + 1 };
  }
  const text = `[${selected}](url)`;
  const url = start + selected.length + 3;
  return { value: value.slice(0, start) + text + value.slice(end), start: url, end: url + 3 };
}

/** Pasting a URL over selected words links them. */
export function pasteLink({ value, start, end }, pasted) {
  if (start === end || !URL.test(pasted.trim())) return null;
  const text = `[${value.slice(start, end)}](${pasted.trim()})`;
  return { value: value.slice(0, start) + text + value.slice(end), start: start + text.length, end: start + text.length };
}

// What each kind of line starts with. Numbered lines count up.
const PREFIXES = {
  heading: () => "### ",
  quote: () => "> ",
  bullet: () => "- ",
  task: () => "- [ ] ",
  numbered: (i) => `${i + 1}. `,
};
const HAS_PREFIX = {
  heading: /^#{1,6} /,
  quote: /^> ?/,
  bullet: /^[-*+] (?!\[[ xX]\] )/,
  task: /^[-*+] \[[ xX]\] /,
  numbered: /^\d+\. /,
};

/**
 * Starts each selected line with `kind`'s prefix (heading, quote, bullet, task or
 * numbered), or takes it away if they all have it already.
 */
export function prefixLines({ value, start, end }, kind) {
  const from = lineStart(value, start);
  const to = lineEnd(value, end);
  const lines = value.slice(from, to).split("\n");
  const removing = lines.every((line) => HAS_PREFIX[kind].test(line));
  const changed = lines
    .map((line, i) => (removing ? line.replace(HAS_PREFIX[kind], "") : PREFIXES[kind](i) + line))
    .join("\n");
  const text = value.slice(0, from) + changed + value.slice(to);
  // A single line keeps its caret where it was in the text; several stay selected.
  if (lines.length === 1) {
    const shift = changed.length - (to - from);
    return { value: text, start: Math.max(from, start + shift), end: Math.max(from, end + shift) };
  }
  return { value: text, start: from, end: from + changed.length };
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;

/**
 * Enter in a list item starts the next one ("- ", "2. ", "- [ ] "), taking any text
 * after the caret with it, and Enter on an empty item ends the list.
 */
export function continueList({ value, start, end }) {
  if (start !== end) return null;
  const from = lineStart(value, start);
  const item = value.slice(from, start).match(LIST_ITEM);
  if (!item) return null;
  const [, indent, marker, space, box, text] = item;
  if (!text.trim() && start === lineEnd(value, start)) {
    return { value: value.slice(0, from) + value.slice(start), start: from, end: from };
  }
  const next = /^\d+/.test(marker) ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}` : marker;
  const insert = `\n${indent}${next}${space}${box ? "[ ] " : ""}`;
  const at = start + insert.length;
  return { value: value.slice(0, start) + insert + value.slice(end), start: at, end: at };
}

/** Tab and Shift+Tab indent and outdent the selected list items by two spaces. */
export function indentList({ value, start, end }, outdent) {
  const from = lineStart(value, start);
  const to = lineEnd(value, end);
  const lines = value.slice(from, to).split("\n");
  if (!lines.every((line) => LIST_ITEM.test(line))) return null;
  let first = 0;
  const changed = lines.map((line, i) => {
    const shifted = outdent ? line.replace(/^ {1,2}/, "") : `  ${line}`;
    if (i === 0) first = shifted.length - line.length;
    return shifted;
  });
  const text = changed.join("\n");
  return {
    value: value.slice(0, from) + text + value.slice(to),
    start: Math.max(from, start + first),
    end: end + text.length - (to - from),
  };
}
