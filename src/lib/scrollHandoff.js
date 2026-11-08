// A heading that hands off to a slim bar pinned at the top as it scrolls away, in step
// with the scrolling rather than on a timer: as its last `range` pixels pass under the
// top edge, the bar comes in, and goes again as they come back.

/**
 * How far the handoff has gone, 0 to 1, with the view scrolled `scrollTop` down and the
 * heading ending `headingBottom` from the top of what scrolls.
 */
export function handoff(scrollTop, headingBottom, range = 60) {
  const into = scrollTop - (headingBottom - range);
  return Math.min(1, Math.max(0, into / range));
}
