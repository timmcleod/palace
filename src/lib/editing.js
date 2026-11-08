import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { folderName } from "./format.js";

// What the Files view is editing: the file open in each repository, and edits that
// aren't saved yet, kept while moving between files, views and repositories, the way
// commit message drafts are. Quitting with any asks first (see quit.rs).

// The file open in each repository's Files view: path -> file.
export const openFiles = reactive({});

// Whether the next file opened takes the keys. Asked for by what opens a file to write
// in, such as New File or the search; opened from the tree, the keys stay in the tree.
// A request that no file opens for, as when the file was open already, soon lapses.
let focusAskedAt = 0;
export const focusOnOpen = () => (focusAskedAt = Date.now());
export function takeFocusRequest() {
  const wanted = Date.now() - focusAskedAt < 1000;
  focusAskedAt = 0;
  return wanted;
}

// Images to edit as text instead, such as SVGs, as keys from keyFor.
export const asText = reactive(new Set());

// Files with edits that aren't saved, as keys from keyFor.
export const unsaved = reactive(new Set());

// The editor for each of those files as it was left: key -> { state, saved, base },
// with `saved` the text as last saved or read and `base` what it was read with
// ({ version, crlf, bom }). Not reactive: CodeMirror's states are kept as they are.
export const buffers = new Map();

// Saves under way, and what starts saving the files open in editors now: for quitting
// to finish saving first, when saving automatically.
export const savesUnderWay = new Set();
export const openEditors = new Set();

/** Saves what's open in editors, and waits for every save under way to finish. */
export async function finishSaving() {
  for (const save of openEditors) save();
  while (savesUnderWay.size) await Promise.allSettled([...savesUnderWay]);
}

export const keyFor = (path, file) => `${path}\n${file}`;

/** Whether `file` in the repository at `path` has edits that aren't saved. */
export const isUnsaved = (path, file) => unsaved.has(keyFor(path, file));

/**
 * Notes whether the file has edits that aren't saved, and tells Palace which files
 * have, so quitting from another window can name them.
 */
export function markUnsaved(path, file, dirty) {
  const key = keyFor(path, file);
  if (dirty === unsaved.has(key)) return;
  if (dirty) unsaved.add(key);
  else unsaved.delete(key);
  const files = unsavedFiles().map((f) => `“${f.file.split("/").pop()}” in ${folderName(f.path)}`);
  invoke("set_unsaved_edits", { files }).catch(() => {});
}

/** Drops the edits not saved to `file`, or to anything in it if it's a folder, as when it's deleted. */
export function forgetEdits(path, file) {
  for (const key of [...unsaved, ...buffers.keys()]) {
    const [repo, edited] = key.split("\n");
    if (repo !== path || (edited !== file && !edited.startsWith(`${file}/`))) continue;
    buffers.delete(key);
    markUnsaved(repo, edited, false);
  }
}

/** Moves the edits not saved to `from`, or to anything in it if it's a folder, as when it's renamed to `to`. */
export function renameEdits(path, from, to) {
  const moved = (file) => (file === from ? to : file.startsWith(`${from}/`) ? to + file.slice(from.length) : null);
  for (const key of [...new Set([...unsaved, ...buffers.keys()])]) {
    const [repo, edited] = key.split("\n");
    const renamed = repo === path && moved(edited);
    if (!renamed) continue;
    if (buffers.has(key)) {
      buffers.set(keyFor(repo, renamed), buffers.get(key));
      buffers.delete(key);
    }
    if (unsaved.has(key)) {
      markUnsaved(repo, edited, false);
      markUnsaved(repo, renamed, true);
    }
  }
}

/** The files with edits that aren't saved, as { path, file }. */
export const unsavedFiles = () =>
  [...unsaved].map((key) => {
    const [path, file] = key.split("\n");
    return { path, file };
  });
