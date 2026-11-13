// Dragging a row by the pointer, as a branch in the sidebar is or a tab in the tab row,
// rather than with the web view's own drag and drop: during one of those, the page
// doesn't hear keys pressed (GNOME on Wayland and macOS keep them while they run the
// drag), so it couldn't tell Escape, or Alt, was pressed.
//
// A press becomes a drag once the pointer has moved a few pixels, so a click stays a
// click. Then an image of the row follows the pointer (`.drag-image.following`, see
// styles.css), and the release drops it, and isn't a click too. Escape, the pointer
// lost, or the window left, ends it without a drop.

// How far the pointer moves, pressed, before it's a drag rather than a click.
const DRAG_DISTANCE = 4;

/**
 * A pointer drag, its parts the caller's own:
 *   image(pressed)  the element to follow the pointer, as the drag starts; pressed is
 *                   { data, element, x, y }, what press() was given and where
 *   start(pressed)  as the drag starts, after the image is made
 *   move(event)     the pointer moved, the drag under way
 *   drop(event)     released, the drag under way: before end(), so what it reads of
 *                   the drag is still there
 *   key(event)      another key pressed or let go meanwhile, as Alt
 *   end()           the drag over, dropped or not, to let go of what it had
 * Returns press(event, data), for the row's pointerdown, and cancel().
 */
export function pointerDrag({ image, start = () => {}, move = () => {}, drop = () => {}, key = () => {}, end = () => {} }) {
  let pressed = null;
  let dragging = false;
  let following = null;

  function press(event, data) {
    if (pressed) cancel();
    pressed = { data, element: event.currentTarget, x: event.clientX, y: event.clientY };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", cancel);
  }

  function begin() {
    dragging = true;
    following = image(pressed);
    following.classList.add("drag-image", "following");
    document.body.append(following);
    document.body.classList.add("dragging-row");
    window.getSelection()?.removeAllRanges();
    start(pressed);
  }

  function onMove(event) {
    if (!pressed) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < DRAG_DISTANCE) return;
      begin();
    }
    event.preventDefault();
    // Held 14px into its left end, at its middle. With the pointer out of the window, it
    // stays at the window's edge nearest it, as the page can't draw beyond the window.
    const { offsetWidth: width, offsetHeight: height } = following;
    const x = Math.min(Math.max(event.clientX - 14, 0), innerWidth - width);
    const y = Math.min(Math.max(event.clientY - height / 2, 0), innerHeight - height);
    following.style.transform = `translate(${x}px, ${y}px)`;
    following.style.visibility = "visible";
    move(event);
  }

  function onKey(event) {
    if (!dragging) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    } else {
      key(event);
    }
  }

  function onUp(event) {
    const dropped = dragging;
    try {
      if (dropped) {
        // The click that follows the release isn't one.
        window.addEventListener("click", swallowClick, true);
        setTimeout(() => window.removeEventListener("click", swallowClick, true));
        drop(event);
      }
    } finally {
      // Ended whatever the drop did, so a failed one doesn't leave the drag going.
      cancel();
    }
  }

  function swallowClick(event) {
    event.stopPropagation();
    window.removeEventListener("click", swallowClick, true);
  }

  function cancel() {
    const was = pressed;
    pressed = null;
    dragging = false;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    window.removeEventListener("blur", cancel);
    document.body.classList.remove("dragging-row");
    following?.remove();
    following = null;
    if (was) end();
  }

  return { press, cancel };
}
