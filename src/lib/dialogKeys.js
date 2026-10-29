import { commandKey } from "./platform.js";

// Keyboard behavior shared by the dialogs, as in native ones: Enter presses the main
// button from anywhere in the dialog. In a multi-line field, where Enter starts a new
// line, Ctrl+Enter (Cmd+Enter on a Mac) does it instead.
export function submitOnEnter(event) {
  if (event.key !== "Enter" || event.isComposing || event.defaultPrevented) return;
  const target = event.target;
  // A focused button, such as Cancel, does what it says.
  if (target.closest("button, a")) return;
  if (target.tagName === "TEXTAREA" && !commandKey(event)) return;
  const form = target.closest("form");
  if (!form) return;
  event.preventDefault();
  form.requestSubmit();
}

// With nothing in the dialog focused, as when it has no text field, focuses its main
// button, or its first field while that button is disabled, so Enter and Escape work
// straight away.
export function focusDialog(form) {
  if (!form || form.contains(document.activeElement)) return;
  (form.querySelector("button[type=submit]:not(:disabled)") ?? form.querySelector("input, select, textarea"))?.focus();
}
