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
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Whether `transfer`, a drag's dataTransfer, carries files from outside Palace. */
export function draggingFiles(transfer) {
  if (!transfer) return false;
  const types = Array.from(transfer.types ?? []);
  return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * Calls `fn(paths)` with the paths of files dropped on this window where Tauri takes the
 * drop, on Linux. Returns a function that stops it.
 *
 * Only this window's: a listener for any window hears every window's drops, so a file
 * dropped in one could be typed in another's terminal. And only paths: Tauri gives what
 * else is dragged, such as a link from a browser, as if it were one, where on macOS the
 * page takes only files' addresses (see dropFiles in terminals.js).
 */
export function onFilesDropped(fn) {
  const target = { kind: "WebviewWindow", label: getCurrentWebviewWindow().label };
  const stop = listen(
    "tauri://drag-drop",
    (event) => {
      const paths = (event.payload?.paths ?? []).filter((path) => path.startsWith("/"));
      if (paths.length) fn(paths);
    },
    { target },
  );
  return () => stop.then((unlisten) => unlisten()).catch(() => {});
}
