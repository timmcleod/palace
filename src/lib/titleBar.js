import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "./platform.js";

// On macOS the window has no title bar of its own: Palace's top bars run to the top
// edge, with the window buttons in the sidebar's (see tauri.macos.conf.json). Their
// empty parts then do what a title bar does: dragging moves the window, and
// double-clicking zooms it. Screens without those bars, such as the welcome screen,
// get a strip along the top instead. The GitHub view's headers count as bars, and in
// Settings, whose page has none, so does a strip as tall as the toolbars elsewhere.

const BARS = ".toolbar, .sidebar-toolbar, .title-strip, .owners-header, .repos-header";
const CONTROLS = "button, a, input, select, textarea, label, [role=button]";
// The toolbars' height, which Settings' strip matches.
const barHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--toolbar-height")) || 56;

function inEmptyBar(event) {
  if (event.button !== 0 || !event.target.closest || event.target.closest(CONTROLS)) return false;
  return !!event.target.closest(BARS) || (event.clientY < barHeight() && !!event.target.closest(".settings"));
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
