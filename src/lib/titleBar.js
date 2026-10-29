import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "./platform.js";

// On macOS the window has no title bar of its own: Palace's top bars run to the top
// edge, with the window buttons in the sidebar's (see tauri.macos.conf.json). Their
// empty parts then do what a title bar does: dragging moves the window, and
// double-clicking zooms it. Screens without those bars, such as the welcome screen,
// get a strip along the top instead.

const BARS = ".toolbar, .sidebar-toolbar, .title-strip";
const CONTROLS = "button, a, input, select, textarea, label, [role=button]";

function inEmptyBar(event) {
  return event.button === 0 && event.target.closest?.(BARS) && !event.target.closest(CONTROLS);
}

if (isMac) {
  document.documentElement.dataset.titleBar = "overlay";
  document.addEventListener("mousedown", (event) => {
    if (!inEmptyBar(event)) return;
    event.preventDefault();
    if (event.detail === 2) getCurrentWindow().toggleMaximize();
    else getCurrentWindow().startDragging();
  });
}
