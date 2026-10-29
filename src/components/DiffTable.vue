<script setup>
import { computed, ref, watch } from "vue";
import { wordHighlights } from "../lib/wordDiff.js";
import { settings } from "../lib/settings.js";
import ImageDiff from "./ImageDiff.vue";

// Renders one file's diff. Loading it is up to the parent.
const props = defineProps({
  diff: { type: Object, required: true },
  // Buttons shown on each hunk, as [{ id, label, verb, danger }]. With a `verb`, the
  // button acts on just the lines picked in its hunk when there are some.
  hunkActions: { type: Array, default: () => [] },
  // Disables the hunk buttons while an action is running.
  busy: { type: Boolean, default: false },
  loadingAll: { type: Boolean, default: false },
});
const emit = defineEmits(["hunk", "show-all"]);

const LINE_CLASS = { "+": "added", "-": "removed", "\\": "marker" };
// Marks each changed line, so added and removed lines differ by more than color.
const SIGN = { "+": "+", "-": "−" };

// Each hunk's changed words, by line: see wordDiff.js.
const words = computed(() => props.diff.hunks?.map((hunk) => wordHighlights(hunk.lines)) ?? []);

// Side by side, each hunk is rows of { old, new }: the indexes of the lines shown on
// the left and right, or null for a gap. Removed lines are lined up with the added
// lines that follow them.
const split = computed(() => settings.diffLayout === "split");
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
  return [LINE_CLASS[line.kind], { pickable: canPick.value && isChange(line), picked: isPicked(h, l) }];
}

// Changed lines picked by clicking their line numbers, all in one hunk at a time.
const canPick = computed(() => props.hunkActions.some((a) => a.verb));
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
const isPicked = (h, l) => picked.value.hunk === h && picked.value.lines.has(l);

function setPicked(h, lines) {
  picked.value = { hunk: lines.size ? h : null, lines };
}

function onLineDown(event, h, l) {
  if (!canPick.value || !isChange(props.diff.hunks[h].lines[l])) return;
  // Keeps the press from starting a text selection.
  event.preventDefault();
  const lines = new Set(picked.value.hunk === h ? picked.value.lines : []);
  if (event.shiftKey && anchor?.hunk === h) {
    const [from, to] = [anchor.line, l].sort((a, b) => a - b);
    for (let i = from; i <= to; i++) if (isChange(props.diff.hunks[h].lines[i])) lines.add(i);
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
  if (dragging?.hunk !== h || !isChange(props.diff.hunks[h].lines[l])) return;
  const lines = new Set(picked.value.lines);
  dragging.pick ? lines.add(l) : lines.delete(l);
  setPicked(h, lines);
}

function actionLabel(action, h) {
  const count = picked.value.hunk === h ? picked.value.lines.size : 0;
  if (!action.verb || !count) return action.label;
  return `${action.verb} ${count === 1 ? "Line" : `${count} Lines`}`;
}

function runAction(action, h) {
  const lines = action.verb && picked.value.hunk === h ? [...picked.value.lines].sort((a, b) => a - b) : null;
  emit("hunk", { action: action.id, index: h, lines });
}
</script>

<template>
  <div class="diff-table">
    <ImageDiff v-if="diff.images" :images="diff.images" />
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
          <tr v-for="(row, r) in splitHunks[h]" :key="r">
            <template v-for="side in ['old', 'new']" :key="side">
              <td
                class="gutter"
                :class="sideClass(h, row[side])"
                :title="row[side] != null && canPick && isChange(hunk.lines[row[side]]) ? 'Click to pick this line. Drag or Shift-click to pick more.' : null"
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
              </td>
              <td v-if="row[side] == null" class="text gap" />
              <td v-else-if="words[h].has(row[side])" class="text" :class="sideClass(h, row[side])">
                <span v-for="(part, p) in words[h].get(row[side])" :key="p" :class="{ word: part.changed }">{{ part.text }}</span>
              </td>
              <td v-else class="text" :class="sideClass(h, row[side])">{{ hunk.lines[row[side]].text }}</td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="scroller">
      <table class="mono">
        <tbody v-for="(hunk, h) in diff.hunks" :key="h">
          <tr class="hunk-header">
            <td class="gutter" />
            <td class="gutter" />
            <td class="sign" />
            <td class="text">
              <div class="hunk-bar">
                <span>{{ hunk.header }}</span>
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
          <tr
            v-for="(line, l) in hunk.lines"
            :key="l"
            :class="[LINE_CLASS[line.kind], { pickable: canPick && isChange(line), picked: isPicked(h, l) }]"
          >
            <td
              v-for="side in ['old', 'new']"
              :key="side"
              class="gutter"
              :title="canPick && isChange(line) ? 'Click to pick this line. Drag or Shift-click to pick more.' : null"
              @mousedown="onLineDown($event, h, l)"
              @mouseenter="onLineEnter(h, l)"
            >
              {{ line[side] ?? "" }}
            </td>
            <td class="sign" @mousedown="onLineDown($event, h, l)" @mouseenter="onLineEnter(h, l)">
              {{ SIGN[line.kind] ?? "" }}
            </td>
            <td v-if="words[h].has(l)" class="text">
              <span v-for="(part, p) in words[h].get(l)" :key="p" :class="{ word: part.changed }">{{ part.text }}</span>
            </td>
            <td v-else class="text">{{ line.text }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.diff-table {
  border: 1px solid var(--border);
  border-radius: 6px;
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
  font-size: 12px;
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
  border-radius: 5px;
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
  border-radius: 2px;
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
  background: var(--accent);
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
  background: var(--accent);
  color: #fff;
}

.text.picked {
  box-shadow: inset 3px 0 var(--accent);
}

.text.marker,
.marker .text {
  color: var(--text-tertiary);
  font-style: italic;
}
</style>
