// A part of the page opening or closing by sliding, as a file's diff in a commit does,
// rather than popping in or out and moving everything below it at once. Where motion is
// turned down in the system's settings, or the page can't animate, it's done at once.

export const SLIDE_MS = 180;

const stillness = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

// Each element's slide under way, and its overflow from before the first of them: one
// started while another's under way, as on closing a file still opening, takes over
// from it, and the overflow comes back only when the last one's done.
const sliding = new WeakMap();
const overflowBefore = new WeakMap();

/** Slides `el` open, from nothing to the height of what's in it. */
export function slideOpen(el) {
  return slide(el, 0, el.scrollHeight);
}

/** Slides `el` closed, from its height to nothing. Resolves once it's closed. */
export function slideClosed(el) {
  return slide(el, el.offsetHeight, 0);
}

async function slide(el, from, to) {
  if (typeof el.animate !== "function" || stillness()?.matches || from === to) return;
  sliding.get(el)?.cancel();
  // Hidden while it slides, what's in it doesn't spill out over what's below.
  if (!overflowBefore.has(el)) overflowBefore.set(el, el.style.overflow);
  el.style.overflow = "hidden";
  const animation = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: SLIDE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  sliding.set(el, animation);
  try {
    await animation.finished;
  } catch {
    // Canceled, by another slide or the element going: nothing's left to do.
  } finally {
    if (sliding.get(el) === animation) {
      el.style.overflow = overflowBefore.get(el);
      sliding.delete(el);
      overflowBefore.delete(el);
    }
  }
}
