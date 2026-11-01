<script setup>
import { markRaw, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, ExternalLink, Save } from "lucide-vue-next";
import { buffers, keyFor, markUnsaved } from "../lib/editing.js";
import { formatSize } from "../lib/format.js";
import { shortcut } from "../lib/platform.js";
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

const settingsNow = () => ({ tabSize: settings.tabSize, highlight: settings.syntaxHighlighting });

function newState(text) {
  return cm.createState(text, props.file, {
    ...settingsNow(),
    onSave: () => save(),
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
    const [read] = await Promise.all([invoke("read_working_file", { path, file }), cm ?? import("../lib/codeEditor.js").then((m) => (cm = m))]);
    if (seq !== loadSeq) return;
    contents.value = read;
    if (read.kind !== "text") return;

    const key = keyFor(path, file);
    const kept = buffers.get(key);
    let state;
    if (kept) {
      current = { key, saved: kept.saved, base: kept.base };
      state = kept.state;
      dirty.value = true;
      changedOnDisk.value = read.version !== kept.base.version;
    } else {
      state = newState(read.text);
      current = { key, saved: state.doc, base: { version: read.version, crlf: read.crlf, bom: read.bom } };
    }
    await showState(state);
    if (seq !== loadSeq) return;
    cm.applySettings(view, settingsNow());
    cm.loadLanguage(view, file, () => current?.key === key);
  } catch (e) {
    if (seq === loadSeq) {
      contents.value = null;
      error.value = String(e);
    }
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function showState(state) {
  // The host is shown once the text is ready.
  await Promise.resolve();
  if (!host.value) return;
  if (view) view.setState(state);
  else view = markRaw(cm.createView(host.value, state));
  view.focus();
}

watch(() => [props.path, props.file], open, { immediate: true });

// The file as it is on disk now: followed if it has no edits here, otherwise noted.
async function checkDisk() {
  if (!current || !view || saving.value) return;
  const key = current.key;
  let read;
  try {
    read = await invoke("read_working_file", { path: props.path, file: props.file });
  } catch {
    return;
  }
  if (!current || current.key !== key || read.version === current.base.version) return;
  if (read.kind !== "text") return;
  if (dirty.value) {
    changedOnDisk.value = true;
    return;
  }
  takeFromDisk(read);
}

function takeFromDisk(read) {
  current.base = { version: read.version, crlf: read.crlf, bom: read.bom };
  cm.replaceText(view, read.text);
  current.saved = view.state.doc;
  dirty.value = false;
  changedOnDisk.value = false;
  markUnsaved(props.path, props.file, false);
  buffers.delete(current.key);
}

watch(() => props.refreshKey, checkDisk);

// Reload takes the file as it is on disk, dropping the edits here.
async function reload() {
  try {
    takeFromDisk(await invoke("read_working_file", { path: props.path, file: props.file }));
  } catch (e) {
    tell("Couldn't Reload the File", String(e));
  }
}

// Keep Mine saves over the version on disk.
async function keepMine() {
  try {
    const read = await invoke("read_working_file", { path: props.path, file: props.file });
    current.base = { ...current.base, version: read.version };
    changedOnDisk.value = false;
  } catch (e) {
    tell("Couldn't Read the File", String(e));
  }
}

const CHANGED_ON_DISK = "CHANGED_ON_DISK: ";

async function save() {
  if (!current || !view || saving.value) return;
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
  () => [settings.tabSize, settings.syntaxHighlighting],
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
  too_large: "This file is too large to edit here.",
};
</script>

<template>
  <div class="file-editor">
    <div class="editor-header">
      <span class="file-title" :title="file">{{ file }}</span>
      <span v-if="dirty" class="unsaved-note">Edited</span>
      <span class="spacer" />
      <Spinner v-if="loading || saving" :size="13" class="dim" />
      <span v-else-if="contents" class="dim size">{{ formatSize(contents.size) }}</span>
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
    </div>
    <div v-else-if="contents && NOT_EDITABLE[contents.kind]" class="empty-state">
      <p>{{ NOT_EDITABLE[contents.kind] }}</p>
      <button class="secondary-button" @click="openInEditor"><ExternalLink :size="14" /> Open in Your Editor</button>
    </div>
    <div v-show="contents?.kind === 'text' && !error" ref="host" class="editor-host" />
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

.image-view {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 20px;
  overflow: auto;
  background: repeating-conic-gradient(var(--row-hover) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
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
