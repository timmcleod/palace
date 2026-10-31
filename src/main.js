import { createApp } from "vue";
import "./styles.css";
import { loadStore } from "./lib/storage.js";

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

// The saved settings are read first: the rest of Palace reads them as it loads.
loadStore().then(async () => {
  // Applies the theme before the first paint.
  await import("./lib/settings.js");
  await import("./lib/titleBar.js");
  const { default: App } = await import("./App.vue");
  createApp(App).mount("#app");
});
