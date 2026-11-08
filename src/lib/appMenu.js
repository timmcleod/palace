// The Palace menu's own items, on macOS (see menu.rs): About Palace and Check for
// Updates… show Palace's page for them, the top of Settings, the second checking as it
// opens. The window in front is told which was chosen.
import { onBeforeUnmount } from "vue";
import { checkForUpdates } from "./updates.js";

/** Listens on `window` for the menu's items, showing the About page with `showAbout()`. */
export function useAppMenu({ window, showAbout }) {
  const unlisten = window.listen("menu", ({ payload }) => {
    if (payload === "about") showAbout();
    if (payload === "check-for-updates") {
      showAbout();
      checkForUpdates();
    }
  });
  onBeforeUnmount(() => unlisten.then((stop) => stop()));
}
