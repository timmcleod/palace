import { shallowRef } from "vue";

// The form dialog and context menu are single overlays rendered once in App.vue.
// Anything can open them; each returns a promise with the user's choice.

export const formDialog = shallowRef(null);

/**
 * Shows a modal form and resolves to its values, or null if cancelled.
 *
 * fields: [{ key, label, type: "text" | "password" | "select" | "checkbox", value, options, placeholder }]
 */
export function openForm({ title, message = "", fields = [], confirmLabel = "OK", danger = false }) {
  return new Promise((resolve) => {
    formDialog.value = { title, message, fields, confirmLabel, danger, resolve };
  });
}

export function closeForm(values) {
  formDialog.value?.resolve(values);
  formDialog.value = null;
}

export const contextMenu = shallowRef(null);

/**
 * Shows a menu at the pointer. items: [{ label, action, disabled, danger }] or
 * { separator: true }.
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
 * or null if cancelled. options: { path, revision, branches, remoteBranches, tags, hasRemote }
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
 * cancelled. options: { branch, from, remotes: [{ name, branches }], rebase, autostash }
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
 * cancelled. options: { path, revision, branch, upstream, branches, tags, remoteBranches }
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
 * Shows the Clone dialog and resolves to { url, location }, or null if cancelled.
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
