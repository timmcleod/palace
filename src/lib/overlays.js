import { shallowRef } from "vue";

// The form dialog and context menu are single overlays rendered once in App.vue.
// Anything can open them; each returns a promise with the user's choice.

export const formDialog = shallowRef(null);

/**
 * Shows a modal form and resolves to its values, or null if canceled.
 *
 * fields: [{ key, label, type: "text" | "password" | "textarea" | "select" | "checkbox", value, options, placeholder }]
 * draft: a key for what's typed (see drafts.js): canceling keeps it for next time.
 */
export function openForm({ title, message = "", fields = [], confirmLabel = "OK", danger = false, draft = null }) {
  return new Promise((resolve) => {
    formDialog.value = { title, message, fields, confirmLabel, danger, draft, resolve };
  });
}

export function closeForm(values) {
  formDialog.value?.resolve(values);
  formDialog.value = null;
}

export const contextMenu = shallowRef(null);

/**
 * Shows a menu at the pointer. items: [{ label, action, disabled, danger, detail,
 * checked }] or { separator: true }. `detail` is a second, smaller line; `checked`
 * puts a tick beside the item.
 */
export function openMenu(event, items) {
  event.preventDefault();
  contextMenu.value = { x: event.clientX, y: event.clientY, items: items.filter(Boolean) };
}

export function closeMenu() {
  contextMenu.value = null;
}

export const tagDialog = shallowRef(null);

/**
 * Shows the Create New Tag dialog and resolves to { name, revision, message, push },
 * or null if canceled. options: { path, revision, branches, remoteBranches, tags, hasRemote }
 */
export function openTagDialog(options) {
  return new Promise((resolve) => {
    tagDialog.value = { ...options, resolve };
  });
}

export function closeTagDialog(values) {
  tagDialog.value?.resolve(values);
  tagDialog.value = null;
}

export const pullDialog = shallowRef(null);

/**
 * Shows the Pull dialog and resolves to { from, rebase, autostash }, or null if
 * canceled. options: { branch, from, remotes: [{ name, branches }], rebase, autostash }
 */
export function openPullDialog(options) {
  return new Promise((resolve) => {
    pullDialog.value = { ...options, resolve };
  });
}

export function closePullDialog(values) {
  pullDialog.value?.resolve(values);
  pullDialog.value = null;
}

export const resetDialog = shallowRef(null);

/**
 * Shows the Reset dialog and resolves to { revision, keepChanges }, or null if
 * canceled. options: { path, revision, branch, checkedOut, current, upstream, branches, tags,
 * remoteBranches }: with checkedOut false, `branch` isn't checked out and only it moves.
 */
export function openResetDialog(options) {
  return new Promise((resolve) => {
    resetDialog.value = { ...options, resolve };
  });
}

export function closeResetDialog(values) {
  resetDialog.value?.resolve(values);
  resetDialog.value = null;
}

export const cloneDialog = shallowRef(null);

/**
 * Shows the Clone dialog and resolves to { url, location }, or null if canceled.
 * options: { url, folder } — the URL to clone (may be empty) and the clone folder.
 */
export function openCloneDialog(options) {
  return new Promise((resolve) => {
    cloneDialog.value = { ...options, resolve };
  });
}

export function closeCloneDialog(values) {
  cloneDialog.value?.resolve(values);
  cloneDialog.value = null;
}

export const mergeDialog = shallowRef(null);

/**
 * Shows the Merge dialog, or with `rebase` the Rebase dialog, and resolves to
 * { branch, options }, or null if canceled.
 * options: { head, branch, branches, remoteBranches, tags, rebase }
 */
export function openMergeDialog(options) {
  return new Promise((resolve) => {
    mergeDialog.value = { ...options, resolve };
  });
}

export function closeMergeDialog(values) {
  mergeDialog.value?.resolve(values);
  mergeDialog.value = null;
}

export const confirmDialog = shallowRef(null);

/**
 * Asks before doing something, resolving to true to go ahead. A blank line in
 * `message` starts a new paragraph. `danger` marks something that can't be undone:
 * the button turns red, and Enter cancels.
 */
export function askConfirm({ title, message, confirmLabel = "OK", danger = false, cancel = true }) {
  return new Promise((resolve) => {
    confirmDialog.value = { title, message, confirmLabel, danger, cancel, resolve };
  });
}

/** Says something, with only an OK button. */
export function tell(title, message) {
  return askConfirm({ title, message, cancel: false });
}

export function closeConfirm(ok) {
  confirmDialog.value?.resolve(ok);
  confirmDialog.value = null;
}
