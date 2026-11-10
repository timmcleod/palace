// New commits at the top of the history, a commit just made or pulled, slide in from
// above rather than appearing at once: the rows already there are drawn where they were
// and glide down to where they now are, making room for the new ones.

/**
 * Whether the newest commit, starting `top` from the top of what scrolls and
 * `rowHeight` tall, is at least partly in view with the view `scrollTop` down. Only
 * then would a slide be seen, so only then is it worth working out.
 */
export function newestInView({ top, rowHeight, scrollTop }) {
  return scrollTop < top + rowHeight;
}

/**
 * How far to slide the history down as it's shown again, in pixels, or 0 not to.
 *
 * `before` is where the newest commit shown so far started, and `after` where that same
 * commit starts now, or null if it's no longer in the history (amended, undone, rebased
 * away), when nothing was simply added above it. New rows taller than the view
 * (`viewportHeight`), as a pull of hundreds would be, just appear.
 */
export function slideDistance({ before, after, viewportHeight }) {
  if (after == null) return 0;
  const distance = after - before;
  if (distance <= 0 || distance > viewportHeight) return 0;
  return distance;
}
