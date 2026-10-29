import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
// Applies the theme before the first paint.
import "./lib/settings.js";
import "./lib/titleBar.js";

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

createApp(App).mount("#app");
