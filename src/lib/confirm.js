import { ask } from "@tauri-apps/plugin-dialog";

// Asks before throwing work away. Resolves to true when the user chooses Discard.
export function confirmDiscard(question, detail) {
  return ask(`${question}\n\n${detail}`, {
    title: "Discard Changes",
    kind: "warning",
    okLabel: "Discard",
    cancelLabel: "Cancel",
  });
}
