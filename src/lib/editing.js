import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";

// What the Files view is editing: the file open in each repository, and edits that
// aren't saved yet, kept while moving between files, views and repositories, the way
// commit message drafts are. Quitting with any asks first (see quit.rs).

// The file open in each repository's Files view: path -> file.
export const openFiles = reactive({});

// Files with edits that aren't saved, as keys from keyFor.
export const unsaved = reactive(new Set());

// The editor for each of those files as it was left: key -> { state, saved, base },
// with `saved` the text as last saved or read and `base` what it was read with
// ({ version, crlf, bom }). Not reactive: CodeMirror's states are kept as they are.
export const buffers = new Map();

export const keyFor = (path, file) => `${path}\n${file}`;

/** Whether `file` in the repository at `path` has edits that aren't saved. */
export const isUnsaved = (path, file) => unsaved.has(keyFor(path, file));

/** Notes whether the file has edits that aren't saved. */
export function markUnsaved(path, file, dirty) {
  const before = unsaved.size > 0;
  if (dirty) unsaved.add(keyFor(path, file));
  else unsaved.delete(keyFor(path, file));
  if (before !== unsaved.size > 0) invoke("set_unsaved_edits", { unsaved: unsaved.size > 0 }).catch(() => {});
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
