<script setup>
import { computed, h, markRaw, onBeforeUnmount, onMounted, ref, render, shallowRef, watch } from "vue";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, ExternalLink, Image, Save } from "lucide-vue-next";
import {
  asText,
  buffers,
  focusOnOpen,
  keyFor,
  markUnsaved,
  openEditors,
  savesUnderWay,
  takeFocusRequest,
  unsaved,
} from "../lib/editing.js";
import { formatSize } from "../lib/format.js";
import { isMac, shortcut } from "../lib/platform.js";
import { settings } from "../lib/settings.js";
import { openMenu, tell } from "../lib/overlays.js";
import { addComment, commentsOn, deleteComment, editComment } from "../lib/review.js";
import { agentCommand, agentName } from "../lib/agents.js";
import ReviewComment from "./ReviewComment.vue";
import Spinner from "./Spinner.vue";
import { CHANGED_ON_DISK, isError } from "../lib/errors.js";

// A file from the working copy, to read and edit. Edits that aren't saved stay with
// their file (see editing.js) while you look at another, and the file is checked
// against the disk whenever Palace refreshes: unchanged text follows it, and edited
// text asks whether to reload it. With Settings › Save files automatically, edits save
// a moment after typing stops, and on leaving the file, the editor or Palace.
const props = defineProps({
  path: { type: String, required: true },
  file: { type: String, default: null },
  refreshKey: { type: Number, default: 0 },
});
// "send-to-agent" with text to put in the agent's prompt.
const emit = defineEmits(["send-to-agent"]);

// The editor module, loaded with the first file opened.
let cm = null;
const host = ref(null);
let view = null;

// What's shown: the file as read ({ kind, size, image, ... }), or an error.
const contents = shallowRef(null);
const error = ref("");
const loading = ref(false);
const dirty = ref(false);
// Set when the file changed on disk while it has edits here.
const changedOnDisk = ref(false);
const saving = ref(false);
// The review comment being written: { key, last, lines }, or null (see below).
const draft = shallowRef(null);
// Why saving automatically last failed, shown until a save works.
const saveError = ref("");

// The file being edited: { key, path, file, editable, saved, base, state }, with
// `saved` the text as last saved or read, `base` what it was read with ({ version,
// crlf, bom }) and `state` the editor as left, while it's kept in `buffers`. Saves
// write one at a time: `writing` while one is under way, and `again` if another was
// asked for meanwhile.
let current = null;

// How long after typing stops edits save, when saving automatically.
const AUTOSAVE_DELAY = 1000;
let autosaveTimer = 0;

const settingsNow = () => ({ tabSize: settings.tabSize, highlight: settings.syntaxHighlighting, wrap: settings.wrapLines });

// An image to edit as text, such as an SVG, comes as text; one with edits not saved
// stays text.
function readFile(path = props.path, file = props.file) {
  const key = keyFor(path, file);
  return invoke("read_working_file", { path, file, asText: asText.has(key) || buffers.has(key) });
}

// The status bar: where the cursor is, and how the file is laid out.
const status = ref(null);
const layout = ref({ crlf: false, bom: false });
const language = ref("");

// The file as of the last commit, for the editor to mark the lines changed since.
// Fetched again on each refresh, as committing changes it.
async function loadCommitted() {
  if (!current || !view) return;
  const key = current.key;
  const text = await invoke("committed_text", { path: props.path, file: props.file }).catch(() => null);
  if (current?.key === key && view) cm.setCommittedText(view, text);
}

function goToLine() {
  if (view) cm.goToLine(view);
}

// Text Palace shows, editable or, when too large to edit, read-only.
const TEXT = ["text", "read_only"];
const isText = computed(() => TEXT.includes(contents.value?.kind));
const isSvg = computed(() => /\.svg$/i.test(props.file ?? ""));

function newState(text, readOnly = false) {
  return cm.createState(text, props.file, { ...settingsNow(), readOnly, ...hooks() });
}

// What the editor calls back into: this editor's, so a file kept with edits from an
// editor that's since gone, as when the Files view was left, is rebound to these.
function hooks() {
  return {
    onSave: () => save(),
    review,
    onCursor: (state) => (status.value = cm.statusOf(state)),
    onChange: (state) => {
      if (!current) return;
      dirty.value = !state.doc.eq(current.saved);
      markUnsaved(props.path, props.file, dirty.value);
      if (dirty.value && settings.autoSave) {
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(autosave, AUTOSAVE_DELAY);
      }
    },
  };
}

// Keeps the file being left, if it has edits, to come back to, and saves them if
// saving automatically.
function leave() {
  clearTimeout(autosaveTimer);
  if (!current || !view) return;
  const left = current;
  current = null;
  saving.value = false;
  if (!dirty.value) {
    buffers.delete(left.key);
    return;
  }
  left.state = view.state;
  buffers.set(left.key, left);
  if (settings.autoSave && !changedOnDisk.value) write(left, left.state.doc, true);
}

let loadSeq = 0;
async function open() {
  leave();
  const seq = ++loadSeq;
  const focus = takeFocusRequest();
  const { path, file } = props;
  error.value = "";
  saveError.value = "";
  draft.value = null;
  changedOnDisk.value = false;
  dirty.value = false;
  if (!file) {
    contents.value = null;
    return;
  }
  loading.value = true;
  try {
    // Left with edits that are still saving, as on going back to it quickly: read once
    // that's done, or the read could find the text from before them.
    if (buffers.get(keyFor(path, file))?.writing) await Promise.allSettled([...savesUnderWay]);
    if (seq !== loadSeq) return;
    const [read] = await Promise.all([readFile(path, file), cm ?? import("../lib/codeEditor.js").then((m) => (cm = m))]);
    if (seq !== loadSeq) return;
    contents.value = read;
    if (!TEXT.includes(read.kind)) return;

    const key = keyFor(path, file);
    const kept = buffers.get(key);
    let state;
    const editable = read.kind === "text";
    if (kept) {
      // The same file, kept as it was left, though it may have been renamed since.
      current = Object.assign(kept, { key, path, file, editable });
      state = cm.rebind(kept.state, hooks());
      dirty.value = true;
      changedOnDisk.value = read.version !== kept.base.version;
    } else {
      state = newState(read.text, read.kind === "read_only");
      current = { key, path, file, editable, saved: state.doc, base: { version: read.version, crlf: read.crlf, bom: read.bom } };
    }
    saving.value = !!current.writing;
    await showState(state, focus);
    if (seq !== loadSeq) return;
    cm.applySettings(view, settingsNow());
    status.value = cm.statusOf(view.state);
    layout.value = { crlf: current.base.crlf, bom: current.base.bom };
    language.value = "";
    cm.loadLanguage(view, file, () => current?.key === key).then((name) => {
      if (current?.key === key) language.value = name ?? "Plain Text";
    });
    loadCommitted();
    placeNotes();
  } catch (e) {
    if (seq === loadSeq) {
      contents.value = null;
      error.value = String(e);
    }
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function showState(state, focus) {
  // The host is shown once the text is ready.
  await Promise.resolve();
  if (!host.value) return;
  if (view) view.setState(state);
  else view = markRaw(cm.createView(host.value, state));
  if (focus) view.focus();
}

watch(() => [props.path, props.file], open, { immediate: true });

// The file as it is on disk now: followed if it has no edits here, otherwise noted.
async function checkDisk() {
  if (!current || !view || current.writing) return;
  const key = current.key;
  let read;
  try {
    read = await readFile();
  } catch {
    return;
  }
  if (!current || current.key !== key || read.version === current.base.version) return;
  if (!TEXT.includes(read.kind)) return;
  if (dirty.value) {
    changedOnDisk.value = true;
    return;
  }
  takeFromDisk(read);
}

function takeFromDisk(read) {
  current.base = { version: read.version, crlf: read.crlf, bom: read.bom };
  layout.value = { crlf: read.crlf, bom: read.bom };
  cm.replaceText(view, read.text);
  current.saved = view.state.doc;
  dirty.value = false;
  changedOnDisk.value = false;
  markUnsaved(props.path, props.file, false);
  buffers.delete(current.key);
  placeNotes();
}

watch(
  () => props.refreshKey,
  async () => {
    await checkDisk();
    loadCommitted();
  },
);

// Reload takes the file as it is on disk, dropping the edits here.
async function reload() {
  try {
    takeFromDisk(await readFile());
  } catch (e) {
    tell("Couldn't Reload the File", String(e));
  }
}

// Keep Mine saves over the version on disk.
async function keepMine() {
  try {
    const read = await readFile();
    current.base = { ...current.base, version: read.version };
    changedOnDisk.value = false;
    if (settings.autoSave) save();
  } catch (e) {
    tell("Couldn't Read the File", String(e));
  }
}

// Saves the file open now, as with Ctrl+S (⌘S).
function save() {
  if (!current || !view || (!dirty.value && !changedOnDisk.value)) return;
  clearTimeout(autosaveTimer);
  return write(current, view.state.doc, false);
}

// Saving automatically: a moment after typing stops, and on leaving the editor or
// Palace. Not while the file has changed on disk, until Reload or Keep Mine says
// which to keep.
function autosave() {
  clearTimeout(autosaveTimer);
  if (!settings.autoSave || !current || !view || !dirty.value || changedOnDisk.value) return;
  write(current, view.state.doc, true);
}

onMounted(() => {
  window.addEventListener("blur", autosave);
  openEditors.add(autosave);
});
onBeforeUnmount(() => {
  window.removeEventListener("blur", autosave);
  openEditors.delete(autosave);
});

// Writes `doc` to the file `target` is. Saved automatically, a failure is noted beside
// the file's name rather than interrupting, and a file whose edits were dropped, as
// when it was deleted, isn't saved at all. Quitting waits for it (see finishSaving).
function write(target, doc, auto) {
  const promise = writeNow(target, doc, auto);
  savesUnderWay.add(promise);
  promise.finally(() => savesUnderWay.delete(promise));
  return promise;
}

async function writeNow(target, doc, auto) {
  if (!target.editable) return;
  if (auto && !unsaved.has(target.key)) return;
  if (target.writing) {
    target.again = true;
    return;
  }
  target.writing = true;
  if (current === target) saving.value = true;
  try {
    const version = await invoke("save_working_file", {
      path: target.path,
      file: target.file,
      text: doc.toString(),
      crlf: target.base.crlf,
      bom: target.base.bom,
      version: target.base.version,
    });
    target.base = { ...target.base, version };
    target.saved = doc;
    if (current === target) {
      dirty.value = !view.state.doc.eq(doc);
      changedOnDisk.value = false;
      saveError.value = "";
      markUnsaved(target.path, target.file, dirty.value);
    } else if (buffers.get(target.key) === target && target.state.doc.eq(doc)) {
      // Left while it saved, with nothing more to save: there's nothing to keep.
      buffers.delete(target.key);
      markUnsaved(target.path, target.file, false);
    }
  } catch (e) {
    const message = String(e);
    // Noted only on the file still open; coming back to another, it's checked again.
    if (isError(message, CHANGED_ON_DISK)) {
      if (current === target) changedOnDisk.value = true;
    } else if (!auto) {
      tell("Couldn't Save the File", message);
    } else if (current === target) {
      saveError.value = message;
    }
  } finally {
    target.writing = false;
    if (current === target) saving.value = false;
  }
  if (target.again) {
    target.again = false;
    const latest = current === target ? view?.state.doc : target.state?.doc;
    if (latest && !latest.eq(target.saved)) write(target, latest, true);
  }
}

watch(
  () => [settings.tabSize, settings.syntaxHighlighting, settings.wrapLines],
  () => view && cm.applySettings(view, settingsNow()),
);

onBeforeUnmount(() => {
  leave();
  view?.destroy();
  view = null;
});

// --- Review comments ----------------------------------------------------------------
// Comments for the agent on lines of the file, as on lines of a diff (see review.js),
// shown under their lines. A comment is found again by its lines' text, near where
// they were, so it follows them as lines come and go above it. One whose lines have
// changed since is shown above the file if it's still to be sent, and goes if it was
// sent, as the agent has acted on it.

const WHERE = "file";
const agent = computed(() => agentName(agentCommand(props.path)));
const comments = computed(() => (props.file ? commentsOn(props.path, props.file, WHERE) : []));
const lost = shallowRef([]);

// Where `lines` start in the text now, the nearest to where they were, or null.
function findLines(state, lines) {
  const { doc } = state;
  const want = lines[0].new ?? 1;
  let best = null;
  for (let first = 1; first + lines.length - 1 <= doc.lines; first++) {
    if (!lines.every((line, k) => doc.line(first + k).text === line.text)) continue;
    if (best == null || Math.abs(first - want) < Math.abs(best - want)) best = first;
  }
  return best;
}

function placeNotes() {
  if (!view || !current || !cm) return;
  const notes = [];
  const missing = [];
  for (const comment of comments.value) {
    const first = findLines(view.state, comment.lines);
    if (first == null) {
      missing.push(comment);
      continue;
    }
    const data = { comment };
    notes.push({ key: `c${comment.id}`, version: comment.body, line: first + comment.lines.length - 1, data });
  }
  if (draft.value) notes.push({ key: "draft", version: draft.value.key, line: draft.value.last, data: { draft: draft.value } });
  lost.value = missing;
  cm.setReviewNotes(view, notes);
}

watch(() => comments.value.map((c) => `${c.id}|${c.body}`).join(","), placeNotes);
watch(draft, placeNotes);

// What the editor shows under the lines: a comment, or the box for writing one.
const review = {
  mount(el, { comment, draft: writing }) {
    const path = props.path;
    render(
      comment
        ? h(ReviewComment, {
            comment,
            onSave: (body) => editComment(path, comment.id, body),
            onDelete: () => deleteComment(path, comment.id),
          })
        : h(ReviewComment, { lines: writing.lines, onSave: saveDraft, onCancel: () => (draft.value = null) }),
      el,
    );
  },
  unmount(el) {
    render(null, el);
  },
  comment: (_, line) => startComment(line),
};

// Starts a comment on the line `line`, or on the lines selected, if it's one of them
// or null.
function startComment(line = null) {
  if (!view || !props.file) return;
  const [first, last] = cm.commentLines(view.state, line);
  const lines = cm.linesText(view.state, first, last).map((text, i) => ({ kind: " ", old: null, new: first + i, text }));
  draft.value = { key: Date.now(), last, lines };
  requestAnimationFrame(() => host.value?.querySelector(".cm-review-note textarea")?.focus());
}

function saveDraft(body) {
  addComment(props.path, { file: props.file, where: WHERE, lines: draft.value.lines, body });
  draft.value = null;
}

// Puts the lines selected, or the cursor's line, in the agent's prompt straight away.
function addSelection() {
  if (!view || !props.file) return;
  const [first, last] = cm.commentLines(view.state, null);
  const where = first === last ? `line ${first}` : `lines ${first}–${last}`;
  const quoted = cm.linesText(view.state, first, last).map((text) => `    ${text}`);
  emit("send-to-agent", `${props.file}, ${where}:\n${quoted.join("\n")}\n`);
}

// The editor's menu: commenting, and what the web view's menu offered.
async function editorMenu(event) {
  if (!view || event.target.closest(".cm-review-note")) return;
  event.preventDefault();
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  const line = view.state.doc.lineAt(pos).number;
  const { empty } = view.state.selection.main;
  const readOnly = view.state.readOnly;
  openMenu(event, [
    { label: `Comment for ${agent.value}…`, detail: shortcut("Ctrl+Shift+C"), action: () => startComment(line) },
    { label: empty ? `Add Line to ${agent.value}` : `Add Selection to ${agent.value}`, action: addSelection },
    { separator: true },
    { label: "Cut", disabled: empty || readOnly, action: () => (view.focus(), document.execCommand("cut")) },
    { label: "Copy", disabled: empty, action: () => (view.focus(), document.execCommand("copy")) },
    {
      label: "Paste",
      disabled: readOnly,
      action: async () => {
        const text = await readText().catch(() => "");
        if (text) view.dispatch(view.state.replaceSelection(text));
        view.focus();
      },
    },
    { label: "Select All", action: () => (view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }), view.focus()) },
  ]);
}

function openInEditor() {
  invoke("open_in_editor", { path: props.path, file: props.file }).catch((e) => tell("Couldn't Open the File", String(e)));
}

const NOT_EDITABLE = {
  binary: "This file isn't text Palace can edit.",
  too_large: "This file is too large to show here.",
};

// An SVG shows as an image, or as its text to edit.
function showAs(text) {
  const key = keyFor(props.path, props.file);
  if (text) asText.add(key);
  else asText.delete(key);
  if (text) focusOnOpen();
  open();
}
</script>

<template>
  <div class="file-editor">
    <div class="editor-header">
      <span class="file-title" :title="file">{{ file }}</span>
      <span v-if="dirty && (!settings.autoSave || changedOnDisk)" class="unsaved-note">Edited</span>
      <span v-if="saveError" class="unsaved-note failed" :title="saveError">Not Saved</span>
      <span v-if="contents?.kind === 'read_only'" class="unsaved-note" title="Files this large open read-only">Read Only</span>
      <span class="spacer" />
      <Spinner v-if="loading || saving" :size="13" class="dim" />
      <span v-else-if="contents" class="dim size">{{ formatSize(contents.size) }}</span>
      <button v-if="isSvg && isText && !dirty" class="secondary-button save" title="Show the image" @click="showAs(false)">
        <Image :size="13" /> Image
      </button>
      <button v-if="file" class="icon-button small" title="Open in Your Editor" @click="openInEditor"><ExternalLink :size="14" /></button>
      <button
        v-if="contents?.kind === 'text' && (!settings.autoSave || saveError)"
        class="secondary-button save"
        :disabled="(!dirty && !changedOnDisk) || saving"
        :title="`Save (${shortcut('Ctrl+S')})`"
        @click="save"
      >
        <Save :size="13" /> Save
      </button>
    </div>

    <div v-if="changedOnDisk" class="disk-banner">
      <CircleAlert :size="15" />
      <span>This file changed on disk, by another program, while you had edits here.</span>
      <button class="secondary-button" @click="reload">Reload</button>
      <button class="secondary-button" @click="keepMine">Keep Mine</button>
    </div>

    <p v-if="error" class="message"><CircleAlert :size="15" /> {{ error }}</p>
    <div v-else-if="!file" class="empty-state"><p>Select a file to see and edit it.</p></div>
    <div v-else-if="contents?.kind === 'image'" class="image-view">
      <img :src="contents.image" alt="" />
      <button v-if="isSvg" class="secondary-button edit-text" @click="showAs(true)">Edit as Text</button>
    </div>
    <div v-else-if="contents && NOT_EDITABLE[contents.kind]" class="empty-state">
      <p>{{ NOT_EDITABLE[contents.kind] }}</p>
      <button class="secondary-button" @click="openInEditor"><ExternalLink :size="14" /> Open in Your Editor</button>
    </div>
    <div v-if="lost.length && isText && !error" class="lost-comments">
      <p class="lost-title">On lines that have changed since</p>
      <ReviewComment
        v-for="c in lost"
        :key="c.id"
        :comment="c"
        quote
        @save="editComment(path, c.id, $event)"
        @delete="deleteComment(path, c.id)"
      />
    </div>
    <div v-show="isText && !error" ref="host" class="editor-host" @focusout="autosave" @contextmenu="editorMenu" />
    <div v-if="isText && !error && status" class="status-bar">
      <button class="status-item" :title="`Go to Line (${isMac ? '⌃G' : 'Ctrl+G'})`" @click="goToLine">
        Ln {{ status.line }}, Col {{ status.column }}
      </button>
      <span v-if="status.cursors > 1">{{ status.cursors }} cursors</span>
      <span v-if="status.selected">{{ status.selected.toLocaleString() }} selected</span>
      <span class="spacer" />
      <span title="How lines are indented, detected from the file">{{ status.indent }}</span>
      <span :title="layout.crlf ? 'Lines end with CRLF, as on Windows; saving keeps them that way' : 'Lines end with LF'">
        {{ layout.crlf ? "CRLF" : "LF" }}
      </span>
      <span>{{ layout.bom ? "UTF-8 with BOM" : "UTF-8" }}</span>
      <span v-if="language">{{ language }}</span>
    </div>
  </div>
</template>

<style scoped>
.file-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* As tall as the subheaders beside it. */
.editor-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 12px 0 16px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.file-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.unsaved-note {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--pill-bg);
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.unsaved-note.failed {
  background: var(--banner-warning-bg);
  color: var(--text-primary);
}

.spacer {
  flex: 1;
}

.size {
  flex-shrink: 0;
  font-size: var(--font-sm);
}

.save {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 11px;
  font-size: var(--font-ui);
}

.lost-comments {
  max-height: 40%;
  overflow-y: auto;
  flex-shrink: 0;
  padding: 2px 0;
  border-bottom: 1px solid var(--border);
  background: var(--diff-gutter-bg);
}

.lost-title {
  margin: 6px 12px 0;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.disk-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--banner-warning-bg);
  font-size: var(--font-ui);
}

.disk-banner span {
  flex: 1;
}

.disk-banner .secondary-button {
  padding: 3px 11px;
  font-size: var(--font-ui);
}

.editor-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.status-bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 14px;
  height: 24px;
  padding: 0 12px 0 6px;
  border-top: 1px solid var(--border);
  background: var(--sidebar-bg);
  font-size: var(--font-sm);
  white-space: nowrap;
  color: var(--text-secondary);
}

.status-item {
  padding: 1px 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  color: inherit;
}

.status-item:hover {
  background: var(--button-hover);
  color: var(--text-primary);
}

.image-view {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 20px;
  overflow: auto;
  background: repeating-conic-gradient(var(--row-hover) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
}

.edit-text {
  position: absolute;
  top: 12px;
  right: 14px;
  padding: 4px 12px;
  background: var(--content-bg);
}

.image-view img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.message {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 16px;
  color: var(--text-tertiary);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-tertiary);
}
</style>
