// Files dragged in from outside Palace, as from the desktop or a file manager. WebKit on
// macOS says so with "Files" among what's dragged; WebKitGTK on Linux, while they're
// dragged, lists only "text/uri-list", the files' addresses. Palace's own drags carry
// neither.
//
// Where they're dropped differs too. On macOS the page has the drop, with the files'
// addresses. WebKitGTK gives the page neither the files nor their addresses, so on Linux
// Tauri takes a drop of files instead (dragDropEnabled in tauri.conf.json; the macOS
// config leaves it off) and says where they are (see onFilesDropped). The page still
// sees them dragged over it.

import { listen } from "@tauri-apps/api/event";

/** Whether `transfer`, a drag's dataTransfer, carries files from outside Palace. */
export function draggingFiles(transfer) {
  if (!transfer) return false;
  const types = Array.from(transfer.types ?? []);
  return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * Calls `fn(paths)` with the paths of files dropped on the window where Tauri takes the
 * drop, on Linux. Returns a function that stops it.
 */
export function onFilesDropped(fn) {
  const stop = listen("tauri://drag-drop", (event) => fn(event.payload?.paths ?? []));
  return () => stop.then((unlisten) => unlisten()).catch(() => {});
}
