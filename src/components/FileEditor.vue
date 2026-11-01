<script setup>
import { computed, markRaw, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, ExternalLink, Image, Save } from "lucide-vue-next";
import { asText, buffers, focusOnOpen, keyFor, markUnsaved, takeFocusRequest } from "../lib/editing.js";
import { formatSize } from "../lib/format.js";
import { isMac, shortcut } from "../lib/platform.js";
import { settings } from "../lib/settings.js";
import { tell } from "../lib/overlays.js";
import Spinner from "./Spinner.vue";

// A file from the working copy, to read and edit. Edits that aren't saved stay with
// their file (see editing.js) while you look at another, and the file is checked
// against the disk whenever Palace refreshes: unchanged text follows it, and edited
// text asks whether to reload it.
const props = defineProps({
  path: { type: String, required: true },
  file: { type: String, default: null },
  refreshKey: { type: Number, default: 0 },
});

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

// The file being edited: its key, the text as last saved or read, and what it was
// read with ({ version, crlf, bom }).
let current = null;

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
  return cm.createState(text, props.file, {
    ...settingsNow(),
    readOnly,
    onSave: () => save(),
    onCursor: (state) => (status.value = cm.statusOf(state)),
    onChange: (state) => {
      if (!current) return;
      dirty.value = !state.doc.eq(current.saved);
      markUnsaved(props.path, props.file, dirty.value);
    },
  });
}

// Keeps the file being left, if it has edits, to come back to.
function leave() {
  if (!current || !view) return;
  if (dirty.value) buffers.set(current.key, { state: view.state, saved: current.saved, base: current.base });
  else buffers.delete(current.key);
  current = null;
}

let loadSeq = 0;
async function open() {
  leave();
  const seq = ++loadSeq;
  const focus = takeFocusRequest();
  const { path, file } = props;
  error.value = "";
  changedOnDisk.value = false;
  dirty.value = false;
  if (!file) {
    contents.value = null;
    return;
  }
  loading.value = true;
  try {
    const [read] = await Promise.all([readFile(path, file), cm ?? import("../lib/codeEditor.js").then((m) => (cm = m))]);
    if (seq !== loadSeq) return;
    contents.value = read;
    if (!TEXT.includes(read.kind)) return;

    const key = keyFor(path, file);
    const kept = buffers.get(key);
    let state;
    if (kept) {
      current = { key, saved: kept.saved, base: kept.base };
      state = kept.state;
      dirty.value = true;
      changedOnDisk.value = read.version !== kept.base.version;
    } else {
      state = newState(read.text, read.kind === "read_only");
      current = { key, saved: state.doc, base: { version: read.version, crlf: read.crlf, bom: read.bom } };
    }
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
  if (!current || !view || saving.value) return;
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
  } catch (e) {
    tell("Couldn't Read the File", String(e));
  }
}

const CHANGED_ON_DISK = "CHANGED_ON_DISK: ";

async function save() {
  if (!current || !view || saving.value || contents.value?.kind !== "text") return;
  if (!dirty.value && !changedOnDisk.value) return;
  saving.value = true;
  const target = current;
  const doc = view.state.doc;
  try {
    const version = await invoke("save_working_file", {
      path: props.path,
      file: props.file,
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
      markUnsaved(props.path, props.file, dirty.value);
    }
  } catch (e) {
    const message = String(e);
    if (message.startsWith(CHANGED_ON_DISK)) changedOnDisk.value = true;
    else tell("Couldn't Save the File", message);
  } finally {
    saving.value = false;
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
      <span v-if="dirty" class="unsaved-note">Edited</span>
      <span v-if="contents?.kind === 'read_only'" class="unsaved-note" title="Files this large open read-only">Read Only</span>
      <span class="spacer" />
      <Spinner v-if="loading || saving" :size="13" class="dim" />
      <span v-else-if="contents" class="dim size">{{ formatSize(contents.size) }}</span>
      <button v-if="isSvg && isText && !dirty" class="secondary-button save" title="Show the image" @click="showAs(false)">
        <Image :size="13" /> Image
      </button>
      <button v-if="file" class="icon-button small" title="Open in Your Editor" @click="openInEditor"><ExternalLink :size="14" /></button>
      <button
        v-if="contents?.kind === 'text'"
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
    <div v-show="isText && !error" ref="host" class="editor-host" />
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
  font-size: 11.5px;
  color: var(--text-secondary);
}

.spacer {
  flex: 1;
}

.size {
  flex-shrink: 0;
  font-size: 12px;
}

.save {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 11px;
  font-size: 12.5px;
}

.disk-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--banner-warning-bg);
  font-size: 12.5px;
}

.disk-banner span {
  flex: 1;
}

.disk-banner .secondary-button {
  padding: 3px 11px;
  font-size: 12.5px;
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
  font-size: 11.5px;
  white-space: nowrap;
  color: var(--text-secondary);
}

.status-item {
  padding: 1px 6px;
  border: 0;
  border-radius: 4px;
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
