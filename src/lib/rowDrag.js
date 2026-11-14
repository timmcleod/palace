// Dragging a row by the pointer, as a branch in the sidebar is or a tab in the tab row,
// rather than with the web view's own drag and drop: during one of those, the page
// doesn't hear keys pressed (GNOME on Wayland and macOS keep them while they run the
// drag), so it couldn't tell Escape, or Alt, was pressed.
//
// A press becomes a drag once the pointer has moved a few pixels, so a click stays a
// click. Then an image of the row follows the pointer (`.following`), and the release
// drops it, and isn't a click too. Escape, the pointer lost, or the window left, ends it
// without a drop.

// How far the pointer moves, pressed, before it's a drag rather than a click.
const DRAG_DISTANCE = 4;

// How near a scrolling list's ends the pointer, dragging, scrolls it.
export const SCROLL_EDGE = 28;

/**
 * How far a list running from `start` to `end` on the page scrolls in a frame, with the
 * pointer dragging at `at` along it: toward whichever end it's within SCROLL_EDGE of, or
 * past, faster the nearer, or further past, that end; 0 away from both.
 */
export function edgeScroll(at, start, end) {
  const into = at < start + SCROLL_EDGE ? at - (start + SCROLL_EDGE) : at > end - SCROLL_EDGE ? at - (end - SCROLL_EDGE) : 0;
  return (Math.sign(into) * Math.min(SCROLL_EDGE, Math.abs(into))) / 2;
}

// How far beyond a list something dragged along it is let go of and still lands in
// it, about a tab's height: a drag along it wanders, and missing it by a little
// shouldn't lose it.
export const DROP_REACH = 40;

/**
 * Scrolling a list near its ends while something's dragged over it, a frame at a time,
 * by edgeScroll, for as long as the pointer stays there and it can go further:
 *   element()        the list, which scrolls along `axis`, "x" or "y"
 *   near(pointer)    whether the pointer's where it scrolls the list, as on it rather
 *                    than beside it; by default, anywhere
 *   scrolled()       it's scrolled, so where a drop would land has moved under the
 *                    pointer
 * Returns follow(pointer), as the pointer moves, { x, y } on the page; and stop(), as
 * the drag ends.
 */
export function edgeScroller({ element, axis = "y", near = () => true, scrolled = () => {} }) {
  let pointer = null;
  let frame = 0;

  function step() {
    frame = 0;
    const el = element();
    if (!el || !pointer || !near(pointer)) return;
    const rect = el.getBoundingClientRect();
    const [at, start, end, scroll] = axis === "x" ? [pointer.x, rect.left, rect.right, "scrollLeft"] : [pointer.y, rect.top, rect.bottom, "scrollTop"];
    const by = edgeScroll(at, start, end);
    if (!by) return;
    const before = el[scroll];
    el[scroll] += by;
    if (el[scroll] === before) return;
    scrolled();
    frame = requestAnimationFrame(step);
  }

  return {
    follow(at) {
      pointer = at;
      if (!frame) frame = requestAnimationFrame(step);
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      pointer = null;
    },
  };
}

/**
 * A pointer drag, its parts the caller's own:
 *   image(pressed)  the element to follow the pointer, as the drag starts, styled as
 *                   the caller likes; pressed is { data, element, x, y }, what press()
 *                   was given and where
 *   hold(pressed)   the point in the image, { x, y } in CSS pixels, the pointer holds
 *                   it by; by default 14px into its left end, at its middle
 *   start(pressed)  as the drag starts, after the image is made
 *   reshape(event, image)
 *                   as the pointer moves, before the image is placed: the caller may
 *                   change the image, as to a smaller one away from where it came from,
 *                   and return the point to hold it by from now on, or nothing to go on
 *                   holding it as it was
 *   move(event)     the pointer moved, the drag under way
 *   drop(event, image)
 *                   released, the drag under way: before end(), so what it reads of
 *                   the drag is still there, as the image, where it was let go
 *   key(event)      another key pressed or let go meanwhile, as Alt
 *   end()           the drag over, dropped or not, to let go of what it had
 * Returns press(event, data), for the row's pointerdown, and cancel().
 */
export function pointerDrag({ image, hold = null, start = () => {}, reshape = () => null, move = () => {}, drop = () => {}, key = () => {}, end = () => {} }) {
  let pressed = null;
  let dragging = false;
  let following = null;
  let held = null;
  // How far the image, as drawn, reaches past its own box on each side: turned or
  // scaled, as a tab's copy is, its corners do.
  let spill = { x: 0, y: 0 };

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
    following.classList.add("following");
    // Placed here, inline, rather than by a class: whatever the image is styled as, a
    // label or a copy of a tab, its own rules can't leave it elsewhere. A little see-
    // through, as the web view's own drag images are.
    Object.assign(following.style, { position: "fixed", top: "0", left: "0", zIndex: "1000", visibility: "hidden", pointerEvents: "none", opacity: "0.9" });
    document.body.append(following);
    held = hold?.(pressed) ?? { x: 14, y: following.offsetHeight / 2 };
    measureSpill();
    document.body.classList.add("dragging-row");
    window.getSelection()?.removeAllRanges();
    start(pressed);
  }

  function measureSpill() {
    const drawn = following.getBoundingClientRect();
    spill = { x: Math.max(0, (drawn.width - following.offsetWidth) / 2), y: Math.max(0, (drawn.height - following.offsetHeight) / 2) };
  }

  function onMove(event) {
    if (!pressed) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < DRAG_DISTANCE) return;
      begin();
    }
    event.preventDefault();
    const regrip = reshape(event, following);
    if (regrip) {
      held = regrip;
      measureSpill();
    }
    // Held where hold() says, or reshape() since. With the pointer out of the window, it stays at the
    // window's edge nearest it, as the page can't draw beyond the window, all of it as
    // drawn. Moved there by `translate`, which comes after any turn or scale its styles
    // give it, so those are about its own middle: with `transform`, they'd come after,
    // about where it started, and swing it further off the further it went.
    const { offsetWidth: width, offsetHeight: height } = following;
    const x = Math.min(Math.max(event.clientX - held.x, spill.x), innerWidth - width - spill.x);
    const y = Math.min(Math.max(event.clientY - held.y, spill.y), innerHeight - height - spill.y);
    following.style.setProperty("translate", `${x}px ${y}px`);
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
        drop(event, following);
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
    held = null;
    spill = { x: 0, y: 0 };
    if (was) end();
  }

  return { press, cancel };
}
