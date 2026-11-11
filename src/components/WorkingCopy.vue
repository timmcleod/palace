<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, CircleCheck, Folder, SlidersHorizontal, Undo2, X } from "lucide-vue-next";
import { confirmDiscard } from "../lib/confirm.js";
import { CANCELED, NO_IDENTITY, errorDetail, isError } from "../lib/errors.js";
import { askConfirm, openForm, openMenu, tell } from "../lib/overlays.js";
import { commandKey, fileManager, isMac, shortcut } from "../lib/platform.js";
import { useIssueSuggestions } from "../lib/issueSuggestions.js";
import IssueSuggestions from "./IssueSuggestions.vue";
import FileIcon from "./FileIcon.vue";
import { useWindowed } from "../lib/windowed.js";
import { onSavedElsewhere, readJson, writeJson } from "../lib/storage.js";

// The list of changed files with staging checkboxes, and the commit form below it.
const props = defineProps({
  path: { type: String, required: true },
  refreshKey: { type: Number, default: 0 },
  selectedPath: { type: String, default: null },
  // The commit being written: { subject, body, amend, saved }. Owned by the parent so
  // it survives switching views; this component edits its fields.
  draft: { type: Object, required: true },
  // undoable(step, work): runs `work`, remembering how to undo it.
  undoable: { type: Function, default: (step, work) => work() },
  // The GitHub repository ({ owner, repo }) whose issues "#" suggests, or null.
  issueRepo: { type: Object, default: null },
  // The changed files as the window's last refresh read them, or null when it didn't:
  // then they're read here.
  statusFiles: { type: Array, default: null },
});
// "open-file" asks to open a file in the Files view, to edit it.
const emit = defineEmits(["select", "changed", "open-file", "open-settings"]);

const files = shallowRef(null);
const error = ref("");
const busy = ref(false);
const committing = ref(false);
const commitError = ref("");
// Git has no name and email for commits, as on a computer it was never set up on:
// Settings is where to give them.
const needsIdentity = computed(() => isError(commitError.value, NO_IDENTITY));
// The selected files' paths; see "Selecting several files" below.
const chosen = ref(new Set());
let anchor = null;

let loadSeq = 0;

function show(result) {
  files.value = result;
  // Files that are no longer changed drop out of the selection.
  chosen.value = new Set(result.filter((f) => chosen.value.has(f.path)).map((f) => f.path));
  // Hand the parent the fresh copy of the selected file, or null if it's gone.
  emit("select", result.find((f) => f.path === props.selectedPath) ?? null);
}

// The window's refresh brings the files while this is showing, reading the status once
// for both; they're read here only when it hasn't, as when this has just opened.
async function load() {
  if (props.statusFiles) return;
  const seq = ++loadSeq;
  try {
    const result = await invoke("working_status", { path: props.path });
    // Read while git was staging, it may be from before; the read after shows it.
    if (seq === loadSeq && !busy.value) show(result);
  } catch (e) {
    if (seq === loadSeq) error.value = String(e);
  }
}

watch(
  () => props.statusFiles,
  (list) => {
    if (!list) return;
    // Newer than any read here still under way.
    loadSeq++;
    // While git stages or unstages, a refresh may have read the status before it began,
    // which would undo the boxes just checked. The refresh once git's done brings it.
    if (busy.value) return;
    show(list);
  },
  { immediate: true },
);
watch([() => props.path, () => props.refreshKey], load, { immediate: true });

// Runs a git operation, then has the whole window refresh. With `step`, it can be
// undone (see undoable).
async function run(command, args, step) {
  busy.value = true;
  error.value = "";
  try {
    const work = () => invoke(command, { path: props.path, ...args });
    await (step ? props.undoable(step, work) : work());
  } catch (e) {
    if (String(e) !== CANCELED) error.value = String(e);
  } finally {
    busy.value = false;
    emit("changed");
  }
}

// Unstaging a rename has to name both paths, or the old path stays staged as deleted.
const pathsOf = (file) => [file.path, file.old_path].filter(Boolean);

const fullyStaged = (file) => file.staged && !file.unstaged;

// From a row's checkbox, `event` is its click.
function toggle(file, event) {
  // The boxes stay enabled while git works, so they don't all flicker gray with each
  // click: one clicked meanwhile does nothing. A conflicted file's box waits for git,
  // as what staging it does depends on the conflict.
  if (busy.value || file.conflicted) event?.preventDefault();
  if (!busy.value) toggleFiles([file]);
}

// Stages the files, or unstages them if they're all staged already, as Space does for
// the selected files.
function toggleFiles(list) {
  setStaged(list, !list.every(fullyStaged));
}

// How a file shows unstaged, as git will then report it: what was staged joins what
// wasn't. A rename comes apart into its old path deleted and its new one untracked; a
// file added and since deleted isn't a change at all.
function unstaged(file) {
  const rest = { ...file, staged: null };
  if (file.staged === "renamed" && file.old_path) {
    const parts = { ...rest, old_path: null };
    return [{ ...parts, path: file.old_path, unstaged: "deleted" }, ...(file.unstaged === "deleted" ? [] : [{ ...parts, unstaged: "untracked" }])];
  }
  if (file.staged === "added") return file.unstaged === "deleted" ? [] : [{ ...rest, unstaged: "untracked" }];
  // Deleted in the index but there again in the working copy, it's a change to it.
  if (file.staged === "deleted") return [{ ...rest, unstaged: file.unstaged === "untracked" ? "modified" : "deleted" }];
  // Deleted, or turned into a link, in the working copy since, that's what it is now.
  return [{ ...rest, unstaged: ["deleted", "typechange"].includes(file.unstaged) ? file.unstaged : file.staged }];
}

// Stages the files, or unstages them. The boxes change at once: reading the status
// again after staging can take a moment in a working copy with many changes, and that
// reading puts them right if this was wrong. Conflicted files wait for it.
function setStaged(list, staging) {
  if (busy.value || !list.length) return;
  const shown = new Map();
  for (const file of list) {
    if (file.conflicted) continue;
    shown.set(file, staging ? [{ ...file, staged: file.staged ?? (file.unstaged === "untracked" ? "added" : file.unstaged), unstaged: null }] : unstaged(file));
  }
  if (shown.size) files.value = files.value.flatMap((f) => shown.get(f) ?? [f]);
  if (staging) {
    run("stage_files", { files: list.filter((f) => !fullyStaged(f)).map((f) => f.path) });
  } else {
    run("unstage_files", { files: list.flatMap(pathsOf) });
  }
}

const unstagedFiles = computed(() => files.value?.filter((f) => f.unstaged) ?? []);
const stagedFiles = computed(() => files.value?.filter((f) => f.staged) ?? []);

// Stage All and Unstage All change the boxes at once too, as git can take a second or
// two over tens of thousands of files.
function stageAll() {
  setStaged(unstagedFiles.value, true);
}

function unstageAll() {
  setStaged(stagedFiles.value, false);
}

async function discard(list) {
  const ok =
    list.length === 1
      ? await confirmDiscard(
          `Discard all changes to “${list[0].path.split("/").at(-1)}”?`,
          "Its staged and unstaged changes will be thrown away.",
        )
      : await confirmDiscard(
          `Discard changes to ${list.length} files?`,
          "All their staged and unstaged changes will be thrown away.",
        );
  if (!ok) return;
  const step = { label: "Discard", mode: "keep", cover: { files: list.flatMap(pathsOf) } };
  run("discard_files", { files: list.map((f) => f.path) }, step);
}

// --- Selecting several files ------------------------------------------------------
// Click selects one file, Ctrl+click adds or removes one, Shift+click selects a range,
// Ctrl+A selects them all. The right-click menu acts on the whole selection. The
// detail pane shows the file clicked last.

// The parent can change the selected file too (or clear it).
watch(
  () => props.selectedPath,
  (path) => {
    if (!path) chosen.value = new Set();
    else if (!chosen.value.has(path)) chosen.value = new Set([path]);
  },
  { immediate: true },
);

function onRowClick(file, event) {
  folderCursor.value = null;
  const list = shownOrder.value;
  if (event.shiftKey && anchor) {
    const from = list.findIndex((f) => f.path === anchor);
    const to = list.indexOf(file);
    const [start, end] = from < to ? [from, to] : [to, from];
    chosen.value = new Set(list.slice(Math.max(start, 0), end + 1).map((f) => f.path));
  } else if (event.ctrlKey || event.metaKey) {
    const next = new Set(chosen.value);
    anchor = file.path;
    if (next.has(file.path)) {
      // Deselecting shows another selected file, if any are left.
      next.delete(file.path);
      chosen.value = next;
      emit("select", list.find((f) => next.has(f.path)) ?? null);
      return;
    }
    next.add(file.path);
    chosen.value = next;
  } else {
    chosen.value = new Set([file.path]);
    anchor = file.path;
  }
  emit("select", file);
}

// ↑ and ↓ move to the previous or next file and show its changes; with Shift, they
// extend the selection from where it started. In the tree they stop at folders too,
// and → opens the folder they're on, or goes into it, while ← closes it, or goes up to
// the folder it's in.
const listEl = ref(null);

// The folder ↑ and ↓ are on in the tree, by path, while no file is selected.
const folderCursor = ref(null);
watch(
  () => props.selectedPath,
  (path) => path && (folderCursor.value = null),
);

function onListKeydown(event) {
  const all = files.value ?? [];
  if ((event.ctrlKey || event.metaKey) && event.key === "a" && all.length) {
    event.preventDefault();
    folderCursor.value = null;
    chosen.value = new Set(all.map((f) => f.path));
    return;
  }
  const folderAt = folderCursor.value ? rows.value.findIndex((row) => row.folder === folderCursor.value) : -1;
  const onFolder = folderAt >= 0 ? rows.value[folderAt] : null;
  // Space stages the selected files, or unstages them, rather than scrolling.
  if (event.key === " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    toggleFiles(onFolder ? onFolder.files : all.filter((f) => chosen.value.has(f.path)));
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (asTree.value && !event.shiftKey && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    moveInTree(event.key, onFolder ? folderAt : rows.value.findIndex((row) => row.file?.path === props.selectedPath));
    return;
  }
  const list = shownOrder.value;
  if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || !list.length) return;
  event.preventDefault();

  folderCursor.value = null;
  const at = list.findIndex((f) => f.path === props.selectedPath);
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next = at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + step));
  const file = list[next];

  if (event.shiftKey && anchor) {
    const from = list.findIndex((f) => f.path === anchor);
    const [start, end] = from < next ? [from, next] : [next, from];
    chosen.value = new Set(list.slice(Math.max(start, 0), end + 1).map((f) => f.path));
  } else {
    chosen.value = new Set([file.path]);
    anchor = file.path;
  }
  emit("select", file);
  nextTick(() => scrollToRow(rows.value.findIndex((row) => row.file === file)));
}

// Moves in the tree for `key`, from the row at `at` (-1 for none).
function moveInTree(key, at) {
  const all = rows.value;
  const row = all[at];
  let next = at;
  if (key === "ArrowDown") next = Math.min(all.length - 1, at + 1);
  else if (key === "ArrowUp") next = at < 0 ? 0 : Math.max(0, at - 1);
  else if (key === "ArrowRight") {
    if (!row?.folder) return;
    if (closed.has(row.folder)) return closed.delete(row.folder);
    next = at + 1;
  } else if (key === "ArrowLeft") {
    if (!row) return;
    if (row.folder && !closed.has(row.folder)) return closed.add(row.folder);
    // Up to the folder it's in: the nearest row above, one level out.
    next = all.findLastIndex((other, i) => i < at && other.folder && other.depth === row.depth - 1);
    if (next < 0) return;
  }
  goToRow(next);
}

// Puts the cursor on the row at `index`: a file is selected and shows its changes; a
// folder is only marked, so ↑ and ↓ pass through it.
function goToRow(index) {
  const row = rows.value[index];
  if (!row) return;
  if (row.folder) {
    folderCursor.value = row.folder;
    chosen.value = new Set();
    if (props.selectedPath) emit("select", null);
  } else {
    folderCursor.value = null;
    chosen.value = new Set([row.file.path]);
    anchor = row.file.path;
    emit("select", row.file);
  }
  nextTick(() => scrollToRow(index));
}

// --- As a list or a tree ----------------------------------------------------------
// The changed files are listed by their paths, or as a tree of their folders, chosen
// with the button above them and kept for next time, in every window. A folder's box
// stages or unstages every file in it; its row opens and closes it.

const TREE_KEY = "palace.workingCopyTree";
const asTree = ref(readJson(TREE_KEY, false) === true);
watch(asTree, (on) => {
  writeJson(TREE_KEY, on);
  folderCursor.value = null;
});
// Chosen in another window, it changes here too.
onBeforeUnmount(onSavedElsewhere((key, value) => key === TREE_KEY && (asTree.value = value === true)));

// Folders closed in the tree, by path.
const closed = reactive(new Set());

function viewMenu(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  openMenu({ clientX: rect.left, clientY: rect.bottom + 4, preventDefault() {} }, [
    { label: "View as Tree", checked: asTree.value, action: () => (asTree.value = true) },
    { label: "View as List", checked: !asTree.value, action: () => (asTree.value = false) },
  ]);
}

// What the list draws: { key, file, depth } for a file, and in the tree,
// { key, folder, name, depth, files } for a folder, `files` being all those in it.
const rows = computed(() => {
  const list = files.value ?? [];
  if (!asTree.value) return list.map((file) => ({ key: file.path, file, depth: 0 }));
  const root = { folders: new Map(), files: [] };
  for (const file of list) {
    // A repository inside this one is listed as a folder, "nested/": it's a row of its own.
    const parts = file.path.replace(/\/$/, "").split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [], all: [] });
      node = node.folders.get(part);
      node.all.push(file);
    }
    node.files.push(file);
  }
  const out = [];
  const walk = (node, path, depth) => {
    for (const { name, folder, node: child } of subfolders(node, path)) {
      out.push({ key: `folder:${folder}`, folder, name, depth, files: child.all, node: child });
      if (!closed.has(folder)) walk(child, folder, depth + 1);
    }
    for (const file of node.files) out.push({ key: file.path, file, depth });
  };
  walk(root, "", 0);
  return out;
});

// A tree node's folders, in order, as { name, folder (its path), node }. A folder
// holding just one folder shares its row, as "public/build/assets".
function subfolders(node, path) {
  const folders = [...node.folders].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return folders.map(([name, child]) => {
    while (!child.files.length && child.folders.size === 1) {
      const [[inner, grandchild]] = child.folders;
      name = `${name}/${inner}`;
      child = grandchild;
    }
    return { name, folder: `${path}${name}/`, node: child };
  });
}

// The paths of every folder in a node, however deep.
function folderPaths(node, path) {
  return subfolders(node, path).flatMap(({ folder, node: child }) => [folder, ...folderPaths(child, folder)]);
}

// The files in the order they're drawn, for ↑, ↓ and Shift+click.
const shownOrder = computed(() => rows.value.filter((row) => row.file).map((row) => row.file));

// Alt-clicking (Option-clicking on a Mac) opens or closes the folders in it too. On a
// Mac the click may not say Option is held, so Palace is asked (keys.rs).
async function toggleFolder(row, event) {
  folderCursor.value = row.folder;
  chosen.value = new Set();
  if (props.selectedPath) emit("select", null);
  const opening = closed.has(row.folder);
  const all = event.altKey || (isMac && (await invoke("alt_held").catch(() => false)));
  for (const folder of [row.folder, ...(all ? folderPaths(row.node, row.folder) : [])]) {
    opening ? closed.delete(folder) : closed.add(folder);
  }
}

// A folder's box: checked with every file in it staged, part-checked with some.
const folderStaged = (row) => row.files.every(fullyStaged);
const folderPartly = (row) => !folderStaged(row) && row.files.some((f) => f.staged);

function onFolderMenu(row, event) {
  chosen.value = new Set(row.files.map((f) => f.path));
  onRowMenu(row.files[0], event, row);
}

// --- Drawing only the rows in view -------------------------------------------------
// A working copy can have tens of thousands of changes, as when a branch without the
// app's .gitignore is checked out over node_modules: drawing a row for each froze the
// window. Only the rows in view, and a few either side, are drawn, over a spacer as
// tall as the whole list.

const { spacer: filesSpacer, rows: shownFiles, top: shownTop, height: filesHeight, scrollToRow } = useWindowed(listEl, rows, 30);

const label = (list) => (list.length === 1 ? `“${list[0].path.split("/").at(-1)}”` : `${list.length} Files`);

// From a folder's row, `folder` is that row, and the menu is for the files in it.
function onRowMenu(file, event, folder = null) {
  // Right-clicking outside the selection selects just that file, as a file manager does.
  if (!folder && !chosen.value.has(file.path)) {
    chosen.value = new Set([file.path]);
    anchor = file.path;
    emit("select", file);
  }
  const list = folder ? folder.files : files.value.filter((f) => chosen.value.has(f.path));
  const what = folder ? `“${folder.name}”` : label(list);
  const unstaged = list.filter((f) => f.unstaged);
  const staged = list.filter((f) => f.staged);
  openMenu(event, [
    { label: `Stage ${what}`, action: () => run("stage_files", { files: unstaged.map((f) => f.path) }), disabled: busy.value || !unstaged.length },
    { label: `Unstage ${what}`, action: () => run("unstage_files", { files: staged.flatMap(pathsOf) }), disabled: busy.value || !staged.length },
    { separator: true },
    {
      label: `Stash ${what}…`,
      action: () => stashFiles(list),
      // Git can't stash a file in the middle of a conflict.
      disabled: busy.value || list.some((f) => f.conflicted),
    },
    { label: `Discard ${what}…`, action: () => discard(list), disabled: busy.value, danger: true },
    { separator: true },
    !folder && list.length === 1 && {
      label: "Open in Editor",
      action: () => emit("open-file", file.path),
      // A deleted file has nothing on disk to open.
      disabled: file.unstaged === "deleted" || file.staged === "deleted",
    },
    !folder && list.length === 1 && {
      label: "Open in Default App",
      action: () => invoke("open_in_editor", { path: props.path, file: file.path }).catch((e) => tell("Couldn't Open the File", String(e))),
      disabled: file.unstaged === "deleted" || file.staged === "deleted",
    },
    (folder || list.length === 1) && {
      label: `Show in ${fileManager}`,
      action: () => invoke("show_in_folder", { path: props.path, file: folder ? folder.folder.slice(0, -1) : file.path }).catch((e) => tell("Couldn't Show the File", String(e))),
    },
    {
      label: folder || list.length === 1 ? "Copy Path" : "Copy Paths",
      action: () => navigator.clipboard.writeText(folder ? folder.folder.slice(0, -1) : list.map((f) => f.path).join("\n")),
    },
  ]);
}

async function stashFiles(list) {
  const count = list.length === 1 ? "1 File" : `${list.length} Files`;
  const values = await openForm({
    title: `Stash ${count}`,
    message:
      list.length === 1
        ? `Set aside the changes to ${list[0].path}. Everything else stays as it is.`
        : `Set aside the changes to these ${list.length} files. Everything else stays as it is.`,
    fields: [{ key: "message", label: "Description (optional)", type: "text", optional: true }],
    confirmLabel: "Stash",
  });
  if (!values) return;
  const files = list.flatMap(pathsOf);
  run("stash_save", { message: values.message.trim() || null, includeUntracked: true, files }, { label: "Stash", mode: "keep", cover: { files } });
}

// --- Amend -----------------------------------------------------------------------

// The commit being amended: { message, pushed }.
const head = shallowRef(null);

async function toggleAmend(on) {
  commitError.value = "";
  if (!on) {
    // Put back whatever was being written before amending.
    Object.assign(props.draft, props.draft.saved ?? { subject: "", body: "" }, { amend: false, saved: null });
    return;
  }

  try {
    head.value = await invoke("head_commit", { path: props.path });
  } catch (e) {
    commitError.value = String(e);
    return;
  }
  if (!head.value) {
    commitError.value = "There's no commit to amend yet.";
    return;
  }
  const [subject, ...rest] = head.value.message.split("\n");
  props.draft.saved = { subject: props.draft.subject, body: props.draft.body };
  Object.assign(props.draft, { subject, body: rest.join("\n").trim(), amend: true });
}

// Reopening the view while amending needs the pushed warning again.
watch(
  () => props.draft.amend,
  async (amend) => {
    if (amend && !head.value) head.value = await invoke("head_commit", { path: props.path }).catch(() => null);
  },
  { immediate: true },
);

// --- Commit ----------------------------------------------------------------------

const canCommit = computed(
  () =>
    (stagedFiles.value.length > 0 || props.draft.amend) &&
    props.draft.subject.trim() !== "" &&
    !committing.value &&
    !busy.value,
);

// Typing "#" in the message suggests issues to mention.
const suggestions = useIssueSuggestions(() => props.issueRepo);

// Ctrl+Enter (Cmd+Enter on a Mac) in the subject or description commits, unless an
// issue suggestion takes the key.
function onMessageKeydown(event) {
  if (suggestions.onKeydown(event)) return;
  if (event.key !== "Enter" || !commandKey(event)) return;
  event.preventDefault();
  commit();
}

async function commit() {
  if (!canCommit.value) return;
  if (props.draft.amend && head.value?.pushed) {
    const ok = await askConfirm({
      title: "Amend a Pushed Commit?",
      message:
        "This commit has already been pushed. After amending it, your branch and its upstream will have diverged, and you'll need to force push to publish the change.",
      confirmLabel: "Amend",
    });
    if (!ok) return;
  }

  committing.value = true;
  commitError.value = "";
  const message = [props.draft.subject.trim(), props.draft.body.trim()].filter(Boolean).join("\n\n");
  try {
    const step = props.draft.amend ? { label: "Amend", mode: "soft" } : { label: "Commit", mode: "soft", message };
    await props.undoable(step, () => invoke("commit_changes", { path: props.path, message, amend: props.draft.amend }));
    // After amending, whatever was being written before comes back.
    const before = props.draft.amend ? props.draft.saved : null;
    Object.assign(props.draft, before ?? { subject: "", body: "" }, { amend: false, saved: null });
    head.value = null;
  } catch (e) {
    commitError.value = String(e);
  } finally {
    committing.value = false;
    emit("changed");
  }
}

const STATUS_LETTER = {
  added: "A",
  untracked: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  conflicted: "!",
};

// What the badge shows: a conflict first, then the unstaged change, then the staged one.
const statusOf = (file) => (file.conflicted ? "conflicted" : (file.unstaged ?? file.staged));

// A repository inside this one, "nested/", is named with its slash.
function splitPath(path) {
  const slash = path.lastIndexOf("/", path.length - 2);
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
</script>

<template>
  <div class="working-copy">
    <div v-if="files?.length" class="list-bar">
      <span class="bar-count">
        <button class="icon-button small" title="View Options" @click="viewMenu"><SlidersHorizontal :size="14" /></button>
        {{ plural(files.length, "changed file") }}
      </span>
      <span class="bar-actions">
        <button class="link-button" :disabled="busy || !unstagedFiles.length" @click="stageAll">Stage All</button>
        <button class="link-button" :disabled="busy || !stagedFiles.length" @click="unstageAll">Unstage All</button>
        <button class="link-button danger" :disabled="busy" @click="discard(files)">Discard All…</button>
      </span>
    </div>

    <p v-if="error" class="banner">
      <span>{{ error }}</span>
      <button class="icon-button small" title="Dismiss" @click="error = ''"><X :size="14" /></button>
    </p>

    <div v-if="files && !files.length" class="clean">
      <CircleCheck :size="32" :stroke-width="1.25" />
      <p>No local changes.</p>
    </div>

    <div v-else ref="listEl" class="files" tabindex="0" @keydown="onListKeydown">
      <div ref="filesSpacer" class="files-spacer" :style="{ height: `${filesHeight}px` }">
        <div :style="{ transform: `translateY(${shownTop}px)` }">
          <template v-for="row in shownFiles" :key="row.key">
            <div
              v-if="row.folder"
              class="file folder-row"
              :class="{ selected: row.folder === folderCursor }"
              @click="toggleFolder(row, $event)"
              @contextmenu.prevent="onFolderMenu(row, $event)"
            >
              <input
                type="checkbox"
                :checked="folderStaged(row)"
                :indeterminate="folderPartly(row)"
                :title="folderStaged(row) ? 'Unstage' : 'Stage'"
                @click.stop="busy ? $event.preventDefault() : toggleFiles(row.files)"
              />
              <span class="badge-space" />
              <span class="indent" :style="{ width: `${row.depth * 16}px` }" />
              <ChevronRight :size="14" class="chevron" :class="{ open: !closed.has(row.folder) }" />
              <Folder :size="15" class="folder-icon" />
              <span class="file-path" :title="row.folder">{{ row.name }}</span>
              <button
                class="icon-button small discard"
                title="Discard Changes…"
                :disabled="busy"
                @click.stop="discard(row.files)"
              >
                <Undo2 :size="14" />
              </button>
            </div>
            <div
              v-else
              class="file"
              :class="{
                selected: chosen.has(row.file.path),
                current: row.file.path === selectedPath && chosen.size > 1,
              }"
              @click="onRowClick(row.file, $event)"
              @contextmenu.prevent="onRowMenu(row.file, $event)"
            >
              <input
                type="checkbox"
                :checked="fullyStaged(row.file)"
                :indeterminate="!!(row.file.staged && row.file.unstaged)"
                :title="fullyStaged(row.file) ? 'Unstage' : 'Stage'"
                @click.stop="toggle(row.file, $event)"
              />
              <span class="badge" :class="statusOf(row.file)" :title="statusOf(row.file)">{{ STATUS_LETTER[statusOf(row.file)] }}</span>
              <span v-if="asTree" class="indent" :style="{ width: `${row.depth * 16 + 22}px` }" />
              <FileIcon :name="row.file.path" :size="15" />
              <span class="file-path" :title="row.file.old_path ? `${row.file.old_path} → ${row.file.path}` : row.file.path">
                <span v-if="row.file.old_path" class="dim">{{ row.file.old_path }} → </span>
                <span v-if="!asTree" class="dim">{{ splitPath(row.file.path).dir }}</span>{{ splitPath(row.file.path).name }}
              </span>
              <button
                class="icon-button small discard"
                title="Discard Changes…"
                :disabled="busy"
                @click.stop="discard([row.file])"
              >
                <Undo2 :size="14" />
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <form class="composer" @submit.prevent="commit">
      <p v-if="commitError" class="commit-error">
        {{ needsIdentity ? errorDetail(commitError, NO_IDENTITY) : commitError }}
        <button v-if="needsIdentity" type="button" class="link-button" @click="emit('open-settings', 'commits')">
          Set Them in Settings
        </button>
      </p>
      <p v-if="draft.amend && head?.pushed" class="amend-warning">
        This commit has already been pushed. Amending it will mean force pushing.
      </p>
      <div class="subject-row">
        <input
          v-model="draft.subject"
          class="subject"
          placeholder="Commit subject"
          spellcheck="true"
          @input="suggestions.onInput($event, (v) => (draft.subject = v))"
          @keydown="onMessageKeydown"
          @blur="suggestions.close()"
        />
        <span
          class="counter"
          :class="{ long: draft.subject.length > 72 }"
          title="Keep subjects under about 72 characters"
        >
          {{ draft.subject.length }}
        </span>
      </div>
      <textarea
        v-model="draft.body"
        placeholder="Description (optional)"
        rows="4"
        spellcheck="true"
        @input="suggestions.onInput($event, (v) => (draft.body = v))"
        @keydown="onMessageKeydown"
        @blur="suggestions.close()"
      />
      <IssueSuggestions :suggestions="suggestions" />
      <div class="composer-actions">
        <label class="amend">
          <input
            type="checkbox"
            :checked="draft.amend"
            :disabled="committing"
            @change="toggleAmend($event.target.checked)"
          />
          Amend last commit
        </label>
        <span class="hint">{{ shortcut("Ctrl+Enter") }}</span>
        <button type="submit" class="primary-button" :disabled="!canCommit">
          <template v-if="committing">{{ draft.amend ? "Amending…" : "Committing…" }}</template>
          <template v-else-if="draft.amend">Amend Last Commit</template>
          <template v-else>Commit {{ plural(stagedFiles.length, "file") }}</template>
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.working-copy {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.list-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: var(--font-ui);
  color: var(--text-secondary);
}

.bar-count {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: -6px;
}

.indent {
  flex-shrink: 0;
  margin-right: -8px;
}

.badge-space {
  flex-shrink: 0;
  width: 17px;
}

.chevron {
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform 0.12s ease;
}

.chevron.open {
  transform: rotate(90deg);
}

.folder-icon {
  flex-shrink: 0;
  color: var(--icon);
}

.bar-actions {
  display: flex;
  gap: 14px;
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}

.link-button:disabled {
  color: var(--text-tertiary);
  cursor: default;
}

.link-button.danger:not(:disabled) {
  color: var(--danger);
}

.banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin: 0 12px 8px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--error-bg);
  color: var(--danger);
  font-size: var(--font-ui);
  white-space: pre-wrap;
}

.files {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
  outline: none;
}

.files-spacer {
  position: relative;
}

.file {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-md);
  white-space: nowrap;
}

.file:hover {
  background: var(--row-hover);
}

.file.selected {
  background: var(--row-selected);
}

/* Among several selected files, the one whose changes are showing. */
.file.current .file-path {
  font-weight: 600;
}

.discard {
  flex-shrink: 0;
  visibility: hidden;
}

.file:hover .discard {
  visibility: visible;
}

.discard:hover:not(:disabled) {
  color: var(--danger);
}

input[type="checkbox"] {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent-fill);
}

.badge {
  flex-shrink: 0;
  width: 17px;
  border-radius: var(--radius-xs);
  font-size: var(--font-xs);
  font-weight: 700;
  line-height: 17px;
  text-align: center;
  color: white;
  background: var(--status);
}

.modified {
  --status: var(--accent);
}
.added,
.untracked {
  --status: var(--lane-4);
}
.deleted,
.conflicted {
  --status: var(--danger);
}
.renamed {
  --status: var(--lane-2);
}
.typechange {
  --status: var(--text-tertiary);
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clean {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-tertiary);
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.commit-error {
  margin: 0;
  max-height: 120px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--error-bg);
  color: var(--danger);
  font-size: var(--font-ui);
  white-space: pre-wrap;
}

.subject-row {
  position: relative;
}

.subject,
textarea {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  outline: none;
  background: var(--input-bg);
  font: inherit;
  color: var(--text-primary);
}

.subject {
  padding-right: 42px;
  font-weight: 500;
}

.subject:focus,
textarea:focus {
  border-color: var(--accent);
}

/* Four lines, scrolling past them, rather than a corner to drag it taller by. */
textarea {
  resize: none;
  min-height: 60px;
}

.counter {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.counter.long {
  color: var(--ref-tag-text);
}

.composer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.amend {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  font-size: var(--font-md);
  color: var(--text-secondary);
}

.amend-warning {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--toolbar-group-bg);
  color: var(--ref-tag-text);
  font-size: var(--font-ui);
}

.hint {
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}
</style>
