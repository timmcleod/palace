import { askConfirm } from "./overlays.js";

// Asks before throwing work away. Resolves to true when the user chooses Discard.
export function confirmDiscard(question, detail) {
  return askConfirm({ title: "Discard Changes", message: `${question}\n\n${detail}`, confirmLabel: "Discard", danger: true });
}
