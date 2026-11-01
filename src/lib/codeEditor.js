import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
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
export function createState(text, file, { tabSize, highlight, wrap, readOnly = false, onSave, onChange }) {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      Prec.highest(keymap.of([{ key: "Mod-s", run: () => (onSave(), true), preventDefault: true }])),
      theme,
      coloring.of(highlight ? syntaxHighlighting(highlighting) : []),
      tabs.of([EditorState.tabSize.of(tabSize), indentUnit.of(detectIndent(text))]),
      wrapping.of(wrap ? EditorView.lineWrapping : []),
      language.of([]),
      EditorView.updateListener.of((update) => update.docChanged && onChange(update.state)),
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
 * unless `stillShown` says another file is in the editor by then.
 */
export async function loadLanguage(view, file, stillShown) {
  const description = LanguageDescription.matchFilename(languages, file.split("/").pop());
  if (!description) return;
  const support = await description.load().catch(() => null);
  if (support && stillShown()) view.dispatch({ effects: language.reconfigure(support) });
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
