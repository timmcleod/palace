// What's read again, as on a refresh, is often just what was read before. Keeping the
// earlier copy when it is means the views showing it don't redraw: a diff doesn't flash
// plain while its code is highlighted again, and lines picked in it stay picked.

/** `previous` when `next` holds the same data, as plain JSON does; otherwise `next`. */
export function keepUnchanged(previous, next) {
  if (previous === next) return previous;
  if (previous == null || next == null) return next;
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
