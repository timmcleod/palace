// Word-level highlighting: within a block of removed lines followed by added lines,
// each removed line is paired with the added line in the same position, and the
// words that differ between the two are marked.

// Words, runs of spaces, and single other characters, so punctuation changes are
// marked on their own.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

// Past this many token comparisons a pair isn't worth the time, and lines that long
// are rarely read word by word anyway.
const MAX_WORK = 250_000;

// Pairs sharing less than this share of their text are rewrites, not edits, and
// marking nearly every word of them would only add noise.
const MIN_SIMILARITY = 0.4;

/**
 * Marks the changed words in a hunk's lines. Returns a Map from a line's index to its
 * segments, [{ text, changed }], for the lines that have any; other lines are shown
 * as they are.
 */
export function wordHighlights(lines) {
  const marked = new Map();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "-") {
      i++;
      continue;
    }
    const removed = [];
    while (i < lines.length && lines[i].kind === "-") removed.push(i++);
    // "\ No newline at end of file" can come between the two blocks.
    if (lines[i]?.kind === "\\") i++;
    const added = [];
    while (i < lines.length && lines[i].kind === "+") added.push(i++);

    for (let p = 0; p < Math.min(removed.length, added.length); p++) {
      const pair = compare(lines[removed[p]].text, lines[added[p]].text);
      if (!pair) continue;
      marked.set(removed[p], pair.old);
      marked.set(added[p], pair.new);
    }
  }
  return marked;
}

// The two lines' segments, or null when they shouldn't be marked.
function compare(oldText, newText) {
  if (oldText === newText) return null;
  const a = oldText.match(TOKEN) ?? [];
  const b = newText.match(TOKEN) ?? [];
  if (a.length * b.length > MAX_WORK) return null;

  const common = commonTokens(a, b);
  const shared = [...common.a].reduce((sum, t) => sum + a[t].length, 0);
  if ((2 * shared) / (oldText.length + newText.length) < MIN_SIMILARITY) return null;

  return { old: segments(a, common.a), new: segments(b, common.b) };
}

// The indexes of the tokens in a longest common subsequence of `a` and `b`.
function commonTokens(a, b) {
  const n = a.length;
  const m = b.length;
  // lengths[i][j]: the length of the longest common subsequence of a[i..] and b[j..].
  const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const common = { a: new Set(), b: new Set() };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      common.a.add(i++);
      common.b.add(j++);
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return common;
}

// Joins tokens into runs of changed and unchanged text. A lone space between two
// changed words is marked too, so a changed phrase reads as one.
function segments(tokens, common) {
  const changed = tokens.map((_, t) => !common.has(t));
  for (let t = 1; t < tokens.length - 1; t++) {
    if (!changed[t] && changed[t - 1] && changed[t + 1] && /^\s+$/.test(tokens[t])) changed[t] = true;
  }
  const result = [];
  tokens.forEach((text, t) => {
    const last = result.at(-1);
    if (last && last.changed === changed[t]) last.text += text;
    else result.push({ text, changed: changed[t] });
  });
  return result;
}
