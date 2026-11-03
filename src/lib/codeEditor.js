import { basicSetup } from "codemirror";
import { Compartment, countColumn, EditorState, Facet, Prec, RangeSet, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker, keymap, ViewPlugin, WidgetType } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { gotoLine } from "@codemirror/search";
import { Chunk } from "@codemirror/merge";
import { HighlightStyle, indentUnit, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";

// The Files view's editor: CodeMirror, in Palace's colors and fonts, loaded the first
// time a file is opened there. Each file's editor state is made here; FileEditor.vue
// shows one at a time and keeps those with edits that aren't saved.

// Palace's colors, which follow its theme, so the editor needs no theme of its own.
const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    color: "var(--text-primary)",
    backgroundColor: "var(--content-bg)",
  },
  ".cm-scroller": {
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "Ubuntu Mono", "DejaVu Sans Mono", monospace',
    lineHeight: "18px",
  },
  ".cm-content": { caretColor: "var(--accent)", padding: "6px 0" },
  ".cm-gutters": {
    border: "none",
    color: "var(--text-tertiary)",
    backgroundColor: "var(--diff-gutter-bg)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px" },
  ".cm-activeLine": { backgroundColor: "var(--row-hover)" },
  ".cm-activeLineGutter": { color: "var(--text-secondary)", backgroundColor: "var(--row-selected)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 16%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, #f5c542 40%, transparent)", outline: "none" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, #f59e0b 60%, transparent)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", outline: "none" },
  ".cm-foldPlaceholder": { border: "none", color: "var(--text-secondary)", backgroundColor: "var(--pill-bg)" },
  ".cm-tooltip": { border: "1px solid var(--border)", backgroundColor: "var(--content-bg)", color: "var(--text-primary)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { color: "#fff", backgroundColor: "var(--accent)" },
  ".cm-panels": { color: "var(--text-primary)", backgroundColor: "var(--sidebar-bg)" },
  ".cm-comment-gutter": { width: "20px" },
  ".cm-comment-gutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", padding: "0" },
  ".cm-comment-button": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    borderRadius: "4px",
    backgroundColor: "var(--accent)",
    color: "#fff",
    cursor: "pointer",
  },
  ".cm-review-note": { padding: "1px 0" },
  ".cm-changes-gutter": { width: "6px", backgroundColor: "var(--diff-gutter-bg)" },
  ".cm-changes-gutter .cm-gutterElement": { padding: "0", cursor: "pointer" },
  ".cm-change-mark": { height: "100%", width: "3px", margin: "0 1px", borderRadius: "1px" },
  ".cm-change-mark.added": { backgroundColor: "var(--diff-added-text)" },
  ".cm-change-mark.changed": { backgroundColor: "var(--ref-tag)" },
  ".cm-change-mark.removed": {
    width: "0",
    height: "0",
    margin: "0",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid var(--diff-removed-text)",
    transform: "translateY(-4px)",
  },
  ".cm-change-box": {
    margin: "2px 0 4px",
    borderTop: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
    backgroundColor: "var(--diff-removed-bg)",
    fontFamily: "system-ui, sans-serif",
  },
  ".cm-change-head": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 10px",
    fontSize: "12px",
    color: "var(--text-secondary)",
    backgroundColor: "var(--diff-hunk-bg)",
  },
  ".cm-change-head span": { flex: "1" },
  ".cm-change-head button": {
    padding: "1px 9px",
    border: "1px solid var(--border)",
    borderRadius: "5px",
    background: "var(--content-bg)",
    font: "inherit",
    color: "var(--text-primary)",
    cursor: "pointer",
  },
  ".cm-change-box pre": {
    margin: "0",
    padding: "4px 10px",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "Ubuntu Mono", monospace',
    fontSize: "12px",
    lineHeight: "18px",
    whiteSpace: "pre-wrap",
    color: "var(--text-primary)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "6px 10px", fontSize: "12.5px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": { fontSize: "12.5px" },
  ".cm-textfield": {
    padding: "2px 6px",
    border: "1px solid var(--border)",
    borderRadius: "5px",
    color: "var(--text-primary)",
    backgroundColor: "var(--input-bg)",
  },
  ".cm-button": {
    border: "1px solid var(--border)",
    borderRadius: "5px",
    color: "var(--text-primary)",
    backgroundImage: "none",
    backgroundColor: "var(--content-bg)",
  },
});

// Code in the colors the rest of Palace uses for it (see styles.css).
const highlighting = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.self], color: "var(--syntax-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syntax-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syntax-comment)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--syntax-number)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.className, t.macroName],
    color: "var(--syntax-title)",
  },
  { tag: [t.typeName, t.namespace, t.attributeName], color: "var(--syntax-type)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--syntax-tag)" },
  { tag: t.heading, fontWeight: "bold", color: "var(--syntax-title)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.url, color: "var(--syntax-string)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

const language = new Compartment();
const coloring = new Compartment();
const tabs = new Compartment();
const wrapping = new Compartment();

/** How the text indents: tabs, or the smallest run of spaces most lines start with. */
function detectIndent(text) {
  const lines = text.split("\n", 2000);
  let tabbed = 0;
  let spaced = 0;
  const widths = new Map();
  let previous = 0;
  for (const line of lines) {
    if (line.startsWith("\t")) tabbed++;
    const spaces = /^ +/.exec(line)?.[0].length ?? 0;
    if (spaces && line.trim()) {
      spaced++;
      // The step from the line before, which is the indent unit for most code.
      const step = Math.abs(spaces - previous);
      if (step >= 2 && step <= 8) widths.set(step, (widths.get(step) ?? 0) + 1);
    }
    if (line.trim()) previous = spaces;
  }
  if (tabbed > spaced) return "\t";
  const [width] = [...widths.entries()].sort((a, b) => b[1] - a[1])[0] ?? [2];
  return " ".repeat(width);
}

/**
 * A new editor state for `text` from `file`. `onSave` runs on Cmd+S (Ctrl+S) and
 * `onChange` with each change to the text.
 */
// --- Lines changed since the last commit --------------------------------------------
// A bar beside each line added or changed since the last commit, and a mark where
// lines were removed, kept up to date while typing. Clicking one shows the lines as
// they were, with Revert to put them back.

const setCommitted = StateEffect.define();
// The start of the change being shown, or null.
const showChange = StateEffect.define();

const changes = StateField.define({
  create: () => ({ committed: null, chunks: [], shown: null }),
  update(value, tr) {
    let { committed, chunks, shown } = value;
    for (const effect of tr.effects) {
      if (effect.is(setCommitted)) {
        committed = effect.value == null ? null : Text.of(effect.value.split("\n"));
        chunks = committed ? Chunk.build(committed, tr.state.doc) : [];
        shown = null;
      } else if (effect.is(showChange)) {
        shown = effect.value;
      }
    }
    if (tr.docChanged && committed) {
      chunks = Chunk.updateB(chunks, committed, tr.state.doc, tr.changes);
      if (shown != null) shown = tr.changes.mapPos(shown);
    }
    return { committed, chunks, shown };
  },
  provide: (field) => EditorView.decorations.from(field, shownChange),
});

/** The change at `line` (a line's block), if any. */
function changeAt(chunks, line) {
  return chunks.find((c) => (c.fromB === c.toB ? c.fromB === line.from : c.fromB <= line.from && line.from < c.toB));
}

class ChangeMark extends GutterMarker {
  constructor(kind) {
    super();
    this.kind = kind;
  }
  eq(other) {
    return other.kind === this.kind;
  }
  toDOM() {
    const mark = document.createElement("div");
    mark.className = `cm-change-mark ${this.kind}`;
    mark.title = {
      added: "Added since the last commit. Click to see.",
      changed: "Changed since the last commit. Click to see how it was.",
      removed: "Lines removed here since the last commit. Click to see them.",
    }[this.kind];
    return mark;
  }
}
const MARKS = { added: new ChangeMark("added"), changed: new ChangeMark("changed"), removed: new ChangeMark("removed") };

const changeGutter = gutter({
  class: "cm-changes-gutter",
  markers(view) {
    const { doc } = view.state;
    const marks = [];
    for (const chunk of view.state.field(changes).chunks) {
      if (chunk.fromB === chunk.toB) {
        marks.push(MARKS.removed.range(doc.lineAt(Math.min(chunk.fromB, doc.length)).from));
        continue;
      }
      const kind = chunk.fromA === chunk.toA ? "added" : "changed";
      for (let pos = chunk.fromB; pos < chunk.toB && pos <= doc.length; ) {
        const line = doc.lineAt(pos);
        marks.push(MARKS[kind].range(line.from));
        pos = line.to + 1;
      }
    }
    return RangeSet.of(marks, true);
  },
  domEventHandlers: {
    mousedown(view, line) {
      const { chunks, shown } = view.state.field(changes);
      const chunk = changeAt(chunks, line);
      if (!chunk) return false;
      const open = shown != null && chunk.fromB <= shown && shown <= chunk.endB;
      view.dispatch({ effects: showChange.of(open ? null : chunk.fromB) });
      return true;
    },
  },
  initialSpacer: () => MARKS.added,
});

// The lines as they were at the last commit, below the change (above it, for lines
// removed), with Revert and Close.
class ChangeWidget extends WidgetType {
  constructor(before, chunk) {
    super();
    this.before = before;
    this.chunk = chunk;
  }
  eq(other) {
    return other.before === this.before && other.chunk.fromB === this.chunk.fromB && other.chunk.toB === this.chunk.toB;
  }
  toDOM(view) {
    const box = document.createElement("div");
    box.className = "cm-change-box";
    const head = document.createElement("div");
    head.className = "cm-change-head";
    const label = document.createElement("span");
    label.textContent = this.before ? "At the last commit:" : "New since the last commit.";
    const revert = document.createElement("button");
    revert.textContent = this.before ? "Revert" : "Remove";
    revert.title = this.before ? "Put these lines back as they were" : "Remove these new lines";
    revert.onclick = () => revertChange(view, this.chunk);
    const close = document.createElement("button");
    close.textContent = "Close";
    close.onclick = () => view.dispatch({ effects: showChange.of(null) });
    head.append(label, revert, close);
    box.append(head);
    if (this.before) {
      const lines = document.createElement("pre");
      lines.textContent = this.before.replace(/\n$/, "");
      box.append(lines);
    }
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

function shownChange({ committed, chunks, shown }) {
  if (shown == null || !committed) return Decoration.none;
  const chunk = chunks.find((c) => c.fromB <= shown && shown <= c.endB);
  if (!chunk) return Decoration.none;
  const before = committed.sliceString(chunk.fromA, Math.min(chunk.toA, committed.length));
  const widget = Decoration.widget({ widget: new ChangeWidget(before, chunk), block: true, side: chunk.fromB === chunk.toB ? -1 : 1 });
  return Decoration.set([widget.range(chunk.fromB === chunk.toB ? chunk.fromB : chunk.endB)]);
}

/** Puts a change's lines back as they were at the last commit. */
function revertChange(view, chunk) {
  const { committed } = view.state.field(changes);
  const { doc } = view.state;
  // A chunk at the end may run one past it, for the line break the last line lacks.
  const pastEndA = chunk.toA > committed.length;
  const pastEndB = chunk.toB > doc.length;
  let insert = committed.sliceString(chunk.fromA, Math.min(chunk.toA, committed.length));
  if (pastEndB && !pastEndA && insert.endsWith("\n")) insert = insert.slice(0, -1);
  if (pastEndA && !pastEndB && chunk.toA > chunk.fromA) insert += "\n";
  view.dispatch({ changes: { from: chunk.fromB, to: Math.min(chunk.toB, doc.length), insert }, effects: showChange.of(null) });
  view.focus();
}

/** Marks the lines that differ from `text`, the file as of the last commit, or none if it's null. */
export function setCommittedText(view, text) {
  view.dispatch({ effects: setCommitted.of(text) });
}

// --- Review comments ----------------------------------------------------------------
// Comments for the agent under the lines they're on (see review.js), shown by the
// page's own components in boxes the editor makes room for, and a button beside the
// line under the pointer for writing one. The boxes follow their lines as the text
// changes around them.

/**
 * What the page gives the editor for comments: mount(el, data) and unmount(el) show a
 * comment's box, and comment(view, line) starts one on the line (a line number), or on
 * the lines selected, if it's one of them or null.
 */
const reviewHooks = Facet.define({ combine: (values) => values[0] ?? null });

// [{ key, version, pos, data }]: each box, after the end of its line at `pos`.
const setNotes = StateEffect.define();
const notesField = StateField.define({
  create: () => [],
  update(notes, tr) {
    for (const effect of tr.effects) if (effect.is(setNotes)) return effect.value;
    return tr.docChanged ? notes.map((note) => ({ ...note, pos: tr.changes.mapPos(note.pos, 1) })) : notes;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (notes) =>
      Decoration.set(
        notes.map((note) => Decoration.widget({ widget: new NoteWidget(note), block: true, side: 1 }).range(note.pos)),
        true,
      ),
    ),
});

class NoteWidget extends WidgetType {
  constructor(note) {
    super();
    this.note = note;
  }
  eq(other) {
    return other.note.key === this.note.key && other.note.version === this.note.version;
  }
  toDOM(view) {
    const box = document.createElement("div");
    box.className = "cm-review-note";
    const hooks = view.state.facet(reviewHooks);
    box.unmountNote = () => hooks?.unmount(box);
    hooks?.mount(box, this.note.data);
    return box;
  }
  destroy(box) {
    box.unmountNote?.();
  }
  ignoreEvent() {
    return true;
  }
}

/** Shows the comment boxes: [{ key, version, line (the line number it goes under), data }]. */
export function setReviewNotes(view, notes) {
  const { doc } = view.state;
  const placed = notes
    .filter((n) => n.line >= 1 && n.line <= doc.lines)
    .map(({ key, version, line, data }) => ({ key, version, pos: doc.line(line).to, data }));
  view.dispatch({ effects: setNotes.of(placed) });
}

// The line under the pointer, by where it starts, or null.
const setHover = StateEffect.define();
const hoverField = StateField.define({
  create: () => null,
  update(at, tr) {
    for (const effect of tr.effects) if (effect.is(setHover)) at = effect.value;
    return at != null && tr.docChanged ? tr.changes.mapPos(at) : at;
  },
});

class CommentButton extends GutterMarker {
  eq() {
    return true;
  }
  toDOM() {
    const button = document.createElement("div");
    button.className = "cm-comment-button";
    button.title = "Comment for the agent";
    button.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/></svg>';
    return button;
  }
}
const COMMENT_BUTTON = new CommentButton();

const commentGutter = gutter({
  class: "cm-comment-gutter",
  markers(view) {
    const at = view.state.field(hoverField);
    return at == null || at > view.state.doc.length ? RangeSet.empty : RangeSet.of([COMMENT_BUTTON.range(at)]);
  },
  domEventHandlers: {
    mousedown(view, line) {
      if (view.state.field(hoverField) !== line.from) return false;
      view.state.facet(reviewHooks)?.comment(view, view.state.doc.lineAt(line.from).number);
      return true;
    },
  },
});

// Over the whole editor, gutters included, so the button stays while the pointer moves
// from the line onto it. The line is found by height, which works over the gutters too.
const hoverTracking = ViewPlugin.define((view) => {
  const move = (event) => {
    const block = view.lineBlockAtHeight(event.clientY - view.documentTop);
    const from = view.state.doc.lineAt(Math.min(block.from, view.state.doc.length)).from;
    if (from !== view.state.field(hoverField)) view.dispatch({ effects: setHover.of(from) });
  };
  const leave = () => {
    if (view.state.field(hoverField) != null) view.dispatch({ effects: setHover.of(null) });
  };
  view.dom.addEventListener("mousemove", move);
  view.dom.addEventListener("mouseleave", leave);
  return {
    destroy() {
      view.dom.removeEventListener("mousemove", move);
      view.dom.removeEventListener("mouseleave", leave);
    },
  };
});

/**
 * The lines a comment started at `line` is on, as [first, last] line numbers: the
 * lines selected, if `line` is one of them or null, and otherwise just `line`.
 */
export function commentLines(state, line = null) {
  const { from, to, empty } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  // A selection ending at the start of a line leaves that line out.
  let last = state.doc.lineAt(to).number;
  if (!empty && last > first && state.doc.line(last).from === to) last--;
  if (line == null) return [first, last];
  return !empty && line >= first && line <= last ? [first, last] : [line, line];
}

/** The text of lines `first` to `last`. */
export function linesText(state, first, last) {
  const texts = [];
  for (let n = first; n <= last; n++) texts.push(state.doc.line(n).text);
  return texts;
}

const reviewExtensions = (hooks) =>
  hooks
    ? [
        reviewHooks.of(hooks),
        notesField,
        hoverField,
        commentGutter,
        hoverTracking,
        Prec.highest(keymap.of([{ key: "Mod-Shift-c", run: (view) => (hooks.comment(view, null), true), preventDefault: true }])),
      ]
    : [];

// --- Status -----------------------------------------------------------------------

/** Where the cursor is and how the text is laid out, for the status bar. */
export function statusOf(state) {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const unit = state.facet(indentUnit);
  return {
    line: line.number,
    column: countColumn(line.text.slice(0, main.head - line.from), state.tabSize) + 1,
    selected: state.selection.ranges.reduce((sum, r) => sum + (r.to - r.from), 0),
    cursors: state.selection.ranges.length,
    indent: unit === "\t" ? "Tabs" : `${unit.length} Spaces`,
  };
}

/** Asks for a line to go to. */
export function goToLine(view) {
  gotoLine(view);
}

export function createState(text, file, { tabSize, highlight, wrap, readOnly = false, onSave, onChange, onCursor, review = null }) {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      Prec.highest(
        keymap.of([
          { key: "Mod-s", run: () => (onSave(), true), preventDefault: true },
          // As in most editors; Mod-Alt-g works too.
          { key: "Ctrl-g", run: gotoLine, preventDefault: true },
        ]),
      ),
      reviewExtensions(review),
      changes,
      changeGutter,
      theme,
      coloring.of(highlight ? syntaxHighlighting(highlighting) : []),
      tabs.of([EditorState.tabSize.of(tabSize), indentUnit.of(detectIndent(text))]),
      wrapping.of(wrap ? EditorView.lineWrapping : []),
      language.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state);
        if (update.docChanged || update.selectionSet) onCursor?.(update.state);
      }),
      // Still selectable, to copy from.
      readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
    ],
  });
}

/** An editor showing `state` in `parent`. */
export function createView(parent, state) {
  return new EditorView({ state, parent });
}

/**
 * Loads the language for `file`, if CodeMirror has one, and colors the editor with it,
 * unless `stillShown` says another file is in the editor by then. Returns its name.
 */
export async function loadLanguage(view, file, stillShown) {
  const description = LanguageDescription.matchFilename(languages, file.split("/").pop());
  if (!description) return;
  const support = await description.load().catch(() => null);
  if (support && stillShown()) view.dispatch({ effects: language.reconfigure(support) });
  return description.name;
}

/** Applies Palace's settings for tab width, syntax highlighting and wrapping long lines. */
export function applySettings(view, { tabSize, highlight, wrap }) {
  view.dispatch({
    effects: [
      coloring.reconfigure(highlight ? syntaxHighlighting(highlighting) : []),
      wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
      tabs.reconfigure([EditorState.tabSize.of(tabSize), indentUnit.of(view.state.facet(indentUnit))]),
    ],
  });
}

/** Replaces the whole text, as when the file changed on disk, keeping the cursor near where it was. */
export function replaceText(view, text) {
  const head = Math.min(view.state.selection.main.head, text.length);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
}
