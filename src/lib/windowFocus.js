// Marks the page while its window isn't the one in front, as `data-inactive` on the
// root element, so styles.css can mute the accent as macOS and GNOME do for their own
// windows: the window in front is then the one in color.

/** Follows `win`'s focus, marking `root` while it doesn't have it. Returns a function that stops. */
export function followWindowFocus(win = window, root = document.documentElement) {
  const mark = (active) => {
    if (active) delete root.dataset.inactive;
    else root.dataset.inactive = "";
  };
  const onFocus = () => mark(true);
  const onBlur = () => mark(false);
  win.addEventListener("focus", onFocus);
  win.addEventListener("blur", onBlur);
  mark(win.document.hasFocus());
  return () => {
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("blur", onBlur);
    mark(true);
  };
}
