import { shallowRef } from "vue";

// The form dialog and context menu are single overlays rendered once in App.vue.
// Anything can open them; each returns a promise with the user's choice.

export const formDialog = shallowRef(null);

/**
 * Shows a modal form and resolves to its values, or null if cancelled.
 *
 * fields: [{ key, label, type: "text" | "select" | "checkbox", value, options, placeholder }]
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
