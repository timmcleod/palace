import { shallowRef } from "vue";

// The window's dialogs and context menu: one of each, rendered in App.vue. Anything can
// open them; each returns a promise with the user's choice.

// Each dialog shown is numbered, and App.vue keys it by that, so the next, even of the
// same kind, mounts afresh, taking the keys as its own focus says: otherwise a danger
// question coming after another could open with the keys on its red button.
let nextId = 1;

// Shows `dialog` in `slot`, resolving to the user's choice. One it takes the place of is
// settled as canceled (null), so what opened that doesn't wait for good.
function show(slot, dialog) {
  return new Promise((resolve) => {
    slot.value?.resolve(null);
    slot.value = { ...dialog, id: nextId++, resolve };
  });
}

// Closes the dialog in `slot` with `value` as its choice.
function settle(slot, value) {
  slot.value?.resolve(value);
  slot.value = null;
}

export const formDialog = shallowRef(null);

/**
 * Shows a modal form and resolves to its values, or null if canceled.
 *
 * fields: [{ key, label, type: "text" | "password" | "textarea" | "select" | "checkbox", value, options, placeholder }]
 * draft: a key for what's typed (see drafts.js): canceling keeps it for next time.
 */
export function openForm({ title, message = "", fields = [], confirmLabel = "OK", danger = false, draft = null }) {
  return show(formDialog, { title, message, fields, confirmLabel, danger, draft });
}

export const closeForm = (values) => settle(formDialog, values);

export const contextMenu = shallowRef(null);

/**
 * Shows a menu at the pointer. items: [{ label, action, disabled, danger, detail,
 * checked, filterable }] or { separator: true }. `detail` is a second, smaller line;
 * `checked` puts a tick beside the item. A { filter: placeholder, empty } item is a
 * field, focused as the menu opens, that narrows the `filterable` items to those
 * matching what's typed; `empty` is shown when none do.
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
export const openTagDialog = (options) => show(tagDialog, options);

export const closeTagDialog = (values) => settle(tagDialog, values);

export const pullDialog = shallowRef(null);

/**
 * Shows the Pull dialog and resolves to { from, rebase, autostash }, or null if
 * canceled. options: { branch, from, remotes: [{ name, branches }], rebase, autostash }
 */
export const openPullDialog = (options) => show(pullDialog, options);

export const closePullDialog = (values) => settle(pullDialog, values);

export const resetDialog = shallowRef(null);

/**
 * Shows the Reset dialog and resolves to { revision, keepChanges }, or null if
 * canceled. options: { path, revision, branch, checkedOut, current, upstream, branches, tags,
 * remoteBranches }: with checkedOut false, `branch` isn't checked out and only it moves.
 */
export const openResetDialog = (options) => show(resetDialog, options);

export const closeResetDialog = (values) => settle(resetDialog, values);

export const cloneDialog = shallowRef(null);

/**
 * Shows the Clone dialog and resolves to { url, location }, or null if canceled.
 * options: { url, folder } — the URL to clone (may be empty) and the clone folder.
 */
export const openCloneDialog = (options) => show(cloneDialog, options);

export const closeCloneDialog = (values) => settle(cloneDialog, values);

export const mergeDialog = shallowRef(null);

/**
 * Shows the Merge dialog, or with `rebase` the Rebase dialog, and resolves to
 * { branch, options }, or null if canceled.
 * options: { head, branch, branches, remoteBranches, tags, rebase }
 */
export const openMergeDialog = (options) => show(mergeDialog, options);

export const closeMergeDialog = (values) => settle(mergeDialog, values);

export const confirmDialog = shallowRef(null);

/**
 * Asks before doing something, resolving to true to go ahead. A blank line in
 * `message` starts a new paragraph. `danger` marks something that can't be undone:
 * the button turns red, and Enter cancels. One asked while another's showing, as from
 * a tab behind it, waits its turn, rather than taking its place; with `first`, as for
 * quitting, it goes before, and the other's asked again after.
 */
export function askConfirm({ title, message, confirmLabel = "OK", danger = false, cancel = true, first = false }) {
  return new Promise((resolve) => {
    const dialog = { title, message, confirmLabel, danger, cancel, id: nextId++, resolve };
    if (!confirmDialog.value) confirmDialog.value = dialog;
    else if (first) {
      waiting.unshift(confirmDialog.value);
      confirmDialog.value = dialog;
    } else waiting.push(dialog);
  });
}

// What's been asked while another was showing, in order.
const waiting = [];

/**
 * Whether a dialog or menu is showing over the window: one of those above, which App.vue
 * shows, or one of the tab showing's own, as Create Pull Request or New Issue. Every
 * dialog draws a .backdrop; a hidden tab's is hidden with it, and doesn't count.
 */
export const overlayOpen = () =>
  [formDialog, confirmDialog, contextMenu, mergeDialog, pullDialog, resetDialog, tagDialog, cloneDialog].some((d) => d.value) ||
  [...document.querySelectorAll(".backdrop")].some((backdrop) => !backdrop.closest('[style*="display: none"]'));

/** Says something, with only an OK button. */
export function tell(title, message) {
  return askConfirm({ title, message, cancel: false });
}

export function closeConfirm(ok) {
  confirmDialog.value?.resolve(ok);
  confirmDialog.value = waiting.shift() ?? null;
}
