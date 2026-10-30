import { askConfirm } from "./overlays.js";
import { shortcut } from "./platform.js";

// Asks before throwing work away. Resolves to true when the user chooses Discard.
// `detail` (optional) says what's thrown away; the dialog adds that it can be undone.
export function confirmDiscard(question, detail = "") {
  const message = `${question}\n\n${detail} ${undoHint()}`.trim();
  return askConfirm({ title: "Discard Changes", message, confirmLabel: "Discard", danger: true });
}

export const undoHint = () => `You can undo this with ${shortcut("Ctrl+Z")}.`;

// Thrown, or returned as the error, when the user decides against going ahead.
export const CANCELED = "Canceled.";
