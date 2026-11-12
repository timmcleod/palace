<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { MessageSquarePlus } from "lucide-vue-next";
import { wordHighlights } from "../lib/wordDiff.js";
import { combine, highlightBlocks } from "../lib/highlight.js";
import { settings } from "../lib/settings.js";
import { addComment, commentsOn, deleteComment, editComment } from "../lib/review.js";
import ImageDiff from "./ImageDiff.vue";
import ReviewComment from "./ReviewComment.vue";

// Renders one file's diff. Loading it is up to the parent.
const props = defineProps({
  diff: { type: Object, required: true },
  // The file's path, which decides how its code is highlighted.
  file: { type: String, default: null },
  // Buttons shown on each hunk, as [{ id, label, verb, danger }]. With a `verb`, the
  // button acts on just the lines picked in its hunk when there are some.
  hunkActions: { type: Array, default: () => [] },
  // Disables the hunk buttons while an action is running.
  busy: { type: Boolean, default: false },
  loadingAll: { type: Boolean, default: false },
  // The repository, and which diff of the file this is (see review.js), for review
  // comments on its lines. Without them, there are none.
  repo: { type: String, default: null },
  where: { type: String, default: null },
});
const emit = defineEmits(["hunk", "show-all"]);

const LINE_CLASS = { "+": "added", "-": "removed", "\\": "marker" };
// Marks each changed line, so added and removed lines differ by more than color.
const SIGN = { "+": "+", "-": "−" };

// Each hunk's changed words, by line: see wordDiff.js.
const words = computed(() => props.diff.hunks?.map((hunk) => wordHighlights(hunk.lines)) ?? []);

// Each hunk's highlighted code, by line, once it's ready: the diff shows plain until
// then. Each hunk is highlighted as its old and new versions, so a comment or string
// that runs over several lines is read as one.
const syntax = shallowRef([]);
let highlightRun = 0;
watch(
  [() => props.diff, () => props.file, () => settings.syntaxHighlighting],
  async () => {
    const run = ++highlightRun;
    syntax.value = [];
    const hunks = props.diff.hunks;
    if (!hunks?.length || !settings.syntaxHighlighting) return;
    const sides = hunks.map((hunk) => ({
      old: hunk.lines.flatMap((line, i) => (line.kind === " " || line.kind === "-" ? [i] : [])),
      new: hunk.lines.flatMap((line, i) => (line.kind === " " || line.kind === "+" ? [i] : [])),
    }));
    const blocks = sides.flatMap((side, h) => [side.old, side.new].map((ids) => ids.map((i) => hunks[h].lines[i].text)));
    const highlighted = await highlightBlocks(props.file, blocks);
    if (run !== highlightRun || !highlighted) return;
    syntax.value = sides.map((side, h) => {
      const byLine = new Map();
      side.old.forEach((i, k) => byLine.set(i, highlighted[2 * h][k]));
      side.new.forEach((i, k) => byLine.set(i, highlighted[2 * h + 1][k]));
      return byLine;
    });
  },
  { immediate: true },
);

// What each line shows: pieces of { text, kind, changed } where it's highlighted or
// has changed words, and otherwise just its text.
const pieces = computed(() =>
  (props.diff.hunks ?? []).map((hunk, h) => {
    const byLine = new Map();
    hunk.lines.forEach((line, l) => {
      const tokens = syntax.value[h]?.get(l) ?? null;
      const changed = words.value[h]?.get(l) ?? null;
      if (tokens || changed) byLine.set(l, combine(tokens, changed));
    });
    return byLine;
  }),
);

// Side by side, each hunk is rows of { old, new }: the indexes of the lines shown on
// the left and right, or null for a gap. Removed lines are lined up with the added
// lines that follow them.
const split = computed(() => settings.diffLayout === "split");

// Wrapping, the line number columns are as wide as the longest number needs.
const numberWidth = computed(() => {
  // A loop, not Math.max(...lines): a long diff has more lines than a call takes arguments.
  let last = 0;
  for (const hunk of props.diff.hunks ?? []) {
    for (const line of hunk.lines) last = Math.max(last, line.old ?? 0, line.new ?? 0);
  }
  return `${Math.max(3, String(last).length)}ch`;
});
const splitHunks = computed(() => (split.value ? props.diff.hunks?.map((hunk) => splitRows(hunk.lines)) : null) ?? []);

function splitRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    if (!isChange(lines[i])) {
      // Context, or a "No newline" marker that applies to both sides.
      rows.push({ old: i, new: i });
      i++;
      continue;
    }
    const left = [];
    const right = [];
    let side = null;
    while (i < lines.length && (isChange(lines[i]) || (lines[i].kind === "\\" && side))) {
      // A removed line after added ones starts the next block.
      if (lines[i].kind === "-" && right.length) break;
      if (lines[i].kind !== "\\") side = lines[i].kind === "-" ? left : right;
      side.push(i++);
    }
    for (let k = 0; k < Math.max(left.length, right.length); k++) rows.push({ old: left[k] ?? null, new: right[k] ?? null });
  }
  return rows;
}

// The classes for one side of a split row.
function sideClass(h, l) {
  if (l == null) return "gap";
  const line = props.diff.hunks[h].lines[l];
  return [LINE_CLASS[line.kind], { pickable: canPick.value && pickable(line), picked: isPicked(h, l) }];
}

// Lines picked by clicking their line numbers, all in one hunk at a time: changed
// lines for the hunk buttons, and any line to comment on.
const commentable = computed(() => !!(props.repo && props.where && props.file));
const canPick = computed(() => props.hunkActions.some((a) => a.verb) || commentable.value);
const picked = ref({ hunk: null, lines: new Set() });
let anchor = null;
// While dragging over the line numbers: whether the drag picks lines or unpicks them.
let dragging = null;

watch(
  () => props.diff,
  () => {
    picked.value = { hunk: null, lines: new Set() };
    anchor = null;
  },
);

const isChange = (line) => line.kind === "+" || line.kind === "-";
const pickable = (line) => isChange(line) || (commentable.value && line.kind === " ");
const isPicked = (h, l) => picked.value.hunk === h && picked.value.lines.has(l);

function setPicked(h, lines) {
  picked.value = { hunk: lines.size ? h : null, lines };
}

function onLineDown(event, h, l) {
  if (!canPick.value || !pickable(props.diff.hunks[h].lines[l])) return;
  // Keeps the press from starting a text selection.
  event.preventDefault();
  const lines = new Set(picked.value.hunk === h ? picked.value.lines : []);
  if (event.shiftKey && anchor?.hunk === h) {
    const [from, to] = [anchor.line, l].sort((a, b) => a - b);
    for (let i = from; i <= to; i++) if (pickable(props.diff.hunks[h].lines[i])) lines.add(i);
    setPicked(h, lines);
    return;
  }
  dragging = { hunk: h, pick: !lines.has(l) };
  dragging.pick ? lines.add(l) : lines.delete(l);
  anchor = { hunk: h, line: l };
  setPicked(h, lines);
  window.addEventListener("mouseup", () => (dragging = null), { once: true });
}

function onLineEnter(h, l) {
  if (dragging?.hunk !== h || !pickable(props.diff.hunks[h].lines[l])) return;
  const lines = new Set(picked.value.lines);
  dragging.pick ? lines.add(l) : lines.delete(l);
  setPicked(h, lines);
}

// The picked lines the hunk buttons act on: only changed ones.
function pickedChanges(h) {
  if (picked.value.hunk !== h) return [];
  return [...picked.value.lines].filter((l) => isChange(props.diff.hunks[h].lines[l])).sort((a, b) => a - b);
}

function actionLabel(action, h) {
  const count = pickedChanges(h).length;
  if (!action.verb || !count) return action.label;
  return `${action.verb} ${count === 1 ? "Line" : `${count} Lines`}`;
}

function runAction(action, h) {
  const changes = pickedChanges(h);
  emit("hunk", { action: action.id, index: h, lines: action.verb && changes.length ? changes : null });
}

// --- Review comments ----------------------------------------------------------------

// The comment being written, on { lines } of the diff, or null.
const draft = ref(null);
const comments = computed(() => (commentable.value ? commentsOn(props.repo, props.file, props.where) : []));

// Where each comment goes: under the last of its lines, found again by its number and
// text as the diff changes. Those whose lines have changed since are shown above.
const placed = computed(() => {
  const index = new Map();
  (props.diff.hunks ?? []).forEach((hunk, h) =>
    hunk.lines.forEach((line, l) => index.set(`${line.kind}|${line.old ?? ""}|${line.new ?? ""}|${line.text}`, `${h}:${l}`)),
  );
  const keyOf = (lines) => {
    const last = lines.at(-1);
    return index.get(`${last.kind}|${last.old ?? ""}|${last.new ?? ""}|${last.text}`) ?? null;
  };
  const at = new Map();
  const unplaced = [];
  for (const comment of comments.value) {
    const key = keyOf(comment.lines);
    if (key) at.set(key, [...(at.get(key) ?? []), comment]);
    else unplaced.push(comment);
  }
  return { at, unplaced, draft: draft.value ? keyOf(draft.value.lines) : null };
});

const NONE = [];
const commentsAt = (h, l) => (l == null ? NONE : (placed.value.at.get(`${h}:${l}`) ?? NONE));
const draftAt = (h, l) => l != null && placed.value.draft === `${h}:${l}`;
// Side by side, a row's comments are its old line's and its new line's.
const rowComments = (h, row) => (row.old === row.new ? commentsAt(h, row.old) : [...commentsAt(h, row.old), ...commentsAt(h, row.new)]);
const rowDraft = (h, row) => draftAt(h, row.old) || draftAt(h, row.new);

// Comments on the line `l`, or on the lines picked, if it's one of them.
function startComment(h, l) {
  const hunk = props.diff.hunks[h];
  const lines = picked.value.hunk === h && picked.value.lines.has(l) ? [...picked.value.lines].sort((a, b) => a - b) : [l];
  draft.value = { lines: lines.map((i) => hunk.lines[i]) };
  setPicked(h, new Set());
}

function saveDraft(body) {
  addComment(props.repo, { file: props.file, where: props.where, lines: draft.value.lines, body });
  draft.value = null;
}

// C comments on the lines picked.
function onKey(event) {
  if (!commentable.value || picked.value.hunk == null || draft.value) return;
  if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (event.target.closest?.("input, textarea, [contenteditable], .xterm")) return;
  event.preventDefault();
  startComment(picked.value.hunk, Math.max(...picked.value.lines));
}
onMounted(() => window.addEventListener("keydown", onKey));

// When a comment's row goes, as on canceling one, WebKit can leave the table as tall as
// it was, with a gap under the last line until something else has it laid out again
// (seen in the commit details' list of many files). Taking the table out of the layout
// for a moment has it laid out afresh. The diff keeps its height meanwhile, so what's
// scrolled near the end doesn't jump.
const root = ref(null);
watch(
  [() => draft.value, () => comments.value.length],
  async () => {
    await nextTick();
    const el = root.value;
    if (!el) return;
    el.style.minHeight = `${el.offsetHeight}px`;
    for (const table of el.querySelectorAll("table")) {
      table.style.display = "none";
      void table.offsetHeight;
      table.style.display = "";
    }
    el.style.minHeight = "";
  },
);
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div ref="root" class="diff-table">
    <ImageDiff v-if="diff.images" :images="diff.images" />
    <div v-if="placed.unplaced.length || (draft && !placed.draft)" class="unplaced">
      <p class="unplaced-title">On lines that have changed since</p>
      <ReviewComment
        v-for="c in placed.unplaced"
        :key="c.id"
        :comment="c"
        quote
        @save="editComment(repo, c.id, $event)"
        @delete="deleteComment(repo, c.id)"
      />
      <ReviewComment v-if="draft && !placed.draft" :lines="draft.lines" @save="saveDraft" @cancel="draft = null" />
    </div>
    <p v-if="diff.binary" v-show="!diff.images" class="notice">Binary file not shown.</p>
    <p v-else-if="diff.truncated" class="notice">
      This diff is large ({{ diff.total_lines.toLocaleString() }} lines).
      <button class="link-button" :disabled="loadingAll" @click="emit('show-all')">
        {{ loadingAll ? "Loading…" : "Show Diff" }}
      </button>
    </p>
    <p v-else-if="!diff.hunks.length" v-show="!diff.images" class="notice">No content changes.</p>

    <div v-else-if="split" class="scroller">
      <table class="mono split">
        <colgroup>
          <col class="gutter-col" />
          <col class="sign-col" />
          <col class="text-col" />
          <col class="gutter-col" />
          <col class="sign-col" />
          <col class="text-col" />
        </colgroup>
        <tbody v-for="(hunk, h) in diff.hunks" :key="h">
          <tr class="hunk-header">
            <td colspan="6" class="text">
              <div class="hunk-bar">
                <span class="hunk-title">{{ hunk.header }}</span>
                <span v-if="hunkActions.length" class="hunk-actions">
                  <button
                    v-for="action in hunkActions"
                    :key="action.id"
                    class="hunk-action"
                    :class="{ danger: action.danger }"
                    :disabled="busy"
                    @click="runAction(action, h)"
                  >
                    {{ actionLabel(action, h) }}
                  </button>
                </span>
              </div>
            </td>
          </tr>
          <template v-for="(row, r) in splitHunks[h]" :key="r">
          <tr>
            <template v-for="side in ['old', 'new']" :key="side">
              <td
                class="gutter"
                :class="sideClass(h, row[side])"
                :title="row[side] != null && canPick && pickable(hunk.lines[row[side]]) ? 'Click to pick this line. Drag or Shift-click to pick more.' : null"
                @mousedown="row[side] != null && onLineDown($event, h, row[side])"
                @mouseenter="row[side] != null && onLineEnter(h, row[side])"
              >
                {{ row[side] != null ? (hunk.lines[row[side]][side] ?? "") : "" }}
              </td>
              <td
                class="sign"
                :class="sideClass(h, row[side])"
                @mousedown="row[side] != null && onLineDown($event, h, row[side])"
                @mouseenter="row[side] != null && onLineEnter(h, row[side])"
              >
                {{ row[side] != null ? (SIGN[hunk.lines[row[side]].kind] ?? "") : "" }}
                <button
                  v-if="commentable && row[side] != null && hunk.lines[row[side]].kind !== '\\'"
                  class="comment-button"
                  title="Comment"
                  @mousedown.stop
                  @click.stop="startComment(h, row[side])"
                >
                  <MessageSquarePlus :size="12" />
                </button>
              </td>
              <td v-if="row[side] == null" class="text gap" />
              <td v-else-if="pieces[h].has(row[side])" class="text" :class="sideClass(h, row[side])">
                <span
                  v-for="(part, p) in pieces[h].get(row[side])"
                  :key="p"
                  :class="[part.kind, { word: part.changed }]"
                  >{{ part.text }}</span
                >
              </td>
              <td v-else class="text" :class="sideClass(h, row[side])">{{ hunk.lines[row[side]].text }}</td>
            </template>
          </tr>
          <tr v-for="c in rowComments(h, row)" :key="`c${c.id}`" class="comment-row">
            <td colspan="6">
              <ReviewComment :comment="c" @save="editComment(repo, c.id, $event)" @delete="deleteComment(repo, c.id)" />
            </td>
          </tr>
          <tr v-if="rowDraft(h, row)" class="comment-row">
            <td colspan="6"><ReviewComment :lines="draft.lines" @save="saveDraft" @cancel="draft = null" /></td>
          </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div v-else class="scroller">
      <table class="mono" :class="{ wrapped: settings.wrapLines }" :style="{ '--number-width': numberWidth }">
        <colgroup v-if="settings.wrapLines">
          <col class="number-col" />
          <col class="number-col" />
          <col class="sign-col" />
          <col />
        </colgroup>
        <tbody v-for="(hunk, h) in diff.hunks" :key="h">
          <tr class="hunk-header">
            <td class="gutter" />
            <td class="gutter" />
            <td class="sign" />
            <td class="text">
              <div class="hunk-bar">
                <span class="hunk-title">{{ hunk.header }}</span>
                <span v-if="hunkActions.length" class="hunk-actions">
                  <button
                    v-for="action in hunkActions"
                    :key="action.id"
                    class="hunk-action"
                    :class="{ danger: action.danger }"
                    :disabled="busy"
                    @click="runAction(action, h)"
                  >
                    {{ actionLabel(action, h) }}
                  </button>
                </span>
              </div>
            </td>
          </tr>
          <template v-for="(line, l) in hunk.lines" :key="l">
          <tr :class="[LINE_CLASS[line.kind], { pickable: canPick && pickable(line), picked: isPicked(h, l) }]">
            <td
              v-for="side in ['old', 'new']"
              :key="side"
              class="gutter"
              :title="canPick && pickable(line) ? 'Click to pick this line. Drag or Shift-click to pick more.' : null"
              @mousedown="onLineDown($event, h, l)"
              @mouseenter="onLineEnter(h, l)"
            >
              {{ line[side] ?? "" }}
            </td>
            <td class="sign" @mousedown="onLineDown($event, h, l)" @mouseenter="onLineEnter(h, l)">
              {{ SIGN[line.kind] ?? "" }}
              <button
                v-if="commentable && line.kind !== '\\'"
                class="comment-button"
                title="Comment"
                @mousedown.stop
                @click.stop="startComment(h, l)"
              >
                <MessageSquarePlus :size="12" />
              </button>
            </td>
            <td v-if="pieces[h].has(l)" class="text">
              <span v-for="(part, p) in pieces[h].get(l)" :key="p" :class="[part.kind, { word: part.changed }]">{{
                part.text
              }}</span>
            </td>
            <td v-else class="text">{{ line.text }}</td>
          </tr>
          <tr v-for="c in commentsAt(h, l)" :key="`c${c.id}`" class="comment-row">
            <td colspan="4">
              <ReviewComment :comment="c" @save="editComment(repo, c.id, $event)" @delete="deleteComment(repo, c.id)" />
            </td>
          </tr>
          <tr v-if="draftAt(h, l)" class="comment-row">
            <td colspan="4"><ReviewComment :lines="draft.lines" @save="saveDraft" @cancel="draft = null" /></td>
          </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.diff-table {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.notice {
  margin: 0;
  padding: 10px 12px;
  color: var(--text-tertiary);
}

.link-button {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}

.scroller {
  overflow-x: auto;
}

table {
  min-width: 100%;
  border-collapse: collapse;
  font-size: var(--font-sm);
  line-height: 18px;
}

td {
  padding: 0;
  vertical-align: top;
}

.gutter {
  min-width: 40px;
  padding: 0 8px;
  text-align: right;
  color: var(--text-tertiary);
  background: var(--diff-gutter-bg);
  -webkit-user-select: none;
  user-select: none;
}

/* Left out of selections, like the line numbers, so copied code has no markers. */
.sign {
  position: relative;
  width: 1.5em;
  padding-left: 8px;
  font-weight: 700;
  text-align: center;
  -webkit-user-select: none;
  user-select: none;
}

.added .sign {
  color: var(--diff-added-text);
  background: var(--diff-added-bg);
}

.removed .sign {
  color: var(--diff-removed-text);
  background: var(--diff-removed-bg);
}

.text {
  width: 100%;
  padding: 0 10px 0 4px;
  white-space: pre;
  tab-size: var(--tab-size);
}

.hunk-header td {
  padding-top: 3px;
  padding-bottom: 3px;
  background: var(--diff-hunk-bg);
  color: var(--text-tertiary);
}

.hunk-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-right: -10px;
}

/* Stays in view at the right edge even when long lines scroll the table sideways,
   covering the header text it floats over rather than showing it through. */
.hunk-actions {
  position: sticky;
  right: 0;
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  padding: 0 8px 0 6px;
  background: var(--diff-hunk-bg);
  box-shadow: -14px 0 10px -4px var(--diff-hunk-bg);
}

.hunk-action {
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--content-bg);
  font: inherit;
  font-family: system-ui, "Ubuntu", sans-serif;
  color: var(--text-primary);
  -webkit-user-select: none;
  user-select: none;
  cursor: pointer;
}

.hunk-action:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.hunk-action.danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.hunk-action:disabled {
  opacity: 0.5;
}

.added .text {
  background: var(--diff-added-bg);
}

.added .gutter {
  background: var(--diff-added-gutter);
}

.removed .text {
  background: var(--diff-removed-bg);
}

.removed .gutter {
  background: var(--diff-removed-gutter);
}

.word {
  border-radius: var(--radius-xs);
}

.added .word {
  background: var(--diff-added-word);
}

.removed .word {
  background: var(--diff-removed-word);
}

.pickable .gutter,
.pickable .sign {
  cursor: pointer;
}

.pickable:hover .gutter {
  color: var(--text-primary);
}

.picked .gutter,
.picked .sign {
  background: var(--accent-fill);
  color: #fff;
}

.picked .text {
  box-shadow: inset 3px 0 var(--accent);
}

/* Side by side, each side's cells carry its line's classes, and long lines wrap so
   both sides stay in view. */
.split {
  table-layout: fixed;
  width: 100%;
}

.gutter-col {
  width: 48px;
}

.sign-col {
  width: 24px;
}

.text-col {
  width: 50%;
}

.split .gutter {
  min-width: 0;
}

.split .text {
  width: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Unified, long lines wrap too when Settings says so. */
.wrapped {
  table-layout: fixed;
  width: 100%;
}

.number-col {
  width: calc(var(--number-width) + 16px);
}

.wrapped .gutter {
  min-width: 0;
}

.wrapped .text {
  width: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.wrapped .hunk-title,
.split .hunk-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.split .text + .gutter {
  border-left: 1px solid var(--border);
}

.text.added,
.sign.added {
  background: var(--diff-added-bg);
}

.sign.added {
  color: var(--diff-added-text);
}

.gutter.added {
  background: var(--diff-added-gutter);
}

.text.removed,
.sign.removed {
  background: var(--diff-removed-bg);
}

.sign.removed {
  color: var(--diff-removed-text);
}

.gutter.removed {
  background: var(--diff-removed-gutter);
}

/* In a window in the background, the gutters' tints fade mostly to the gutter's own
   gray, as the accent does elsewhere (see styles.css): the lines keep theirs, to be
   read. A picked line's gutter is the accent's fill, which mutes as it is. */
:root[data-inactive] .added:not(.picked) .gutter,
:root[data-inactive] :not(.picked) > .gutter.added {
  background: color-mix(in srgb, var(--diff-added-gutter) 30%, var(--diff-gutter-bg));
}

:root[data-inactive] .removed:not(.picked) .gutter,
:root[data-inactive] :not(.picked) > .gutter.removed {
  background: color-mix(in srgb, var(--diff-removed-gutter) 30%, var(--diff-gutter-bg));
}

.gap {
  background: var(--diff-gutter-bg);
}

.gutter.pickable,
.sign.pickable {
  cursor: pointer;
}

.gutter.pickable:hover {
  color: var(--text-primary);
}

.gutter.picked,
.sign.picked {
  background: var(--accent-fill);
  color: #fff;
}

.text.picked {
  box-shadow: inset 3px 0 var(--accent);
}

/* Review comments: a button over the line's sign, shown on hovering it, and the
   comments under their lines. */
.comment-button {
  position: absolute;
  top: 0;
  left: 1px;
  display: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--accent-fill);
  color: #fff;
  cursor: pointer;
}

tr:hover > .sign > .comment-button,
.sign:hover > .comment-button {
  display: flex;
}

.comment-row td {
  padding: 0;
  background: var(--diff-gutter-bg);
}

.unplaced {
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
  background: var(--diff-gutter-bg);
}

.unplaced-title {
  margin: 4px 12px 0;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.text.marker,
.marker .text {
  color: var(--text-tertiary);
  font-style: italic;
}
</style>
