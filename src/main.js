import { createApp } from "vue";
import "./styles.css";
import { loadStore } from "./lib/storage.js";
import { draggingFiles } from "./lib/fileDrag.js";
import { followWindowFocus } from "./lib/windowFocus.js";

// Right-clicking where Palace has no menu of its own would show the web view's (Back,
// Reload, Inspect Element). Keep it only where it's useful: in text fields, for Cut,
// Copy and Paste, and over selected text, for Copy.
document.addEventListener("contextmenu", (event) => {
  if (event.defaultPrevented) return;
  const editable = event.target.closest?.("input, textarea, [contenteditable='true']");
  const selection = window.getSelection();
  const overSelection =
    selection && !selection.isCollapsed && selection.containsNode(event.target, true);
  if (!editable && !overSelection) event.preventDefault();
});

// A file dragged in from the desktop and dropped where nothing takes it would replace
// Palace with the file, as a browser shows it, where the web view has the drop: on macOS
// (see fileDrag.js). Nothing happens instead. Where something takes files, as the
// terminal does, it has handled the event first.
window.addEventListener("dragover", (event) => {
  if (!draggingFiles(event.dataTransfer) || event.defaultPrevented) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (event) => {
  if (draggingFiles(event.dataTransfer)) event.preventDefault();
});

// A window in the background shows muted, as the system's own do (see styles.css).
followWindowFocus();

// The saved settings are read first: the rest of Palace reads them as it loads.
loadStore().then(async () => {
  // Applies the theme before the first paint.
  await import("./lib/settings.js");
  await import("./lib/titleBar.js");
  const { default: App } = await import("./App.vue");
  createApp(App).mount("#app");
});
