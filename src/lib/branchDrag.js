// Where a branch, folder or divider dragged in the sidebar would land among the rows
// it can be moved among, its siblings, those in the same folder (see Sidebar.vue). As
// with tabs (see tabRowDrag.js), it's worked out from where the rows were when the drag
// started, so the gap that opens where it'd land, moving the rows below, doesn't move
// where that is.

/**
 * The places a row can land among its siblings, top to bottom: before each, and after
 * the last. `spans` is every row, as laid out, in order: { key, top, bottom, depth };
 * `isSibling(key)` says whether a row is one. Each place is { y, at, gap }: where it is
 * down the list; where the row would go, { key, after }, before or after the sibling
 * `key`; and where the gap opens, { key, after }, by the row that's there. After the
 * last sibling, a folder open with its own rows below it, that's after the last of them.
 */
export function placesAmong(spans, isSibling) {
  const places = [];
  let last = -1;
  spans.forEach((span, i) => {
    if (!isSibling(span.key)) return;
    places.push({ y: span.top, at: { key: span.key, after: false }, gap: { key: span.key, after: false } });
    last = i;
  });
  if (last < 0) return places;
  let end = last;
  while (end + 1 < spans.length && spans[end + 1].depth > spans[last].depth) end++;
  places.push({ y: spans[end].bottom, at: { key: spans[last].key, after: true }, gap: { key: spans[end].key, after: true } });
  return places;
}

/**
 * The place nearest `y`, as long as it's no further than `reach` beyond the first or
 * last of them: past those, it's dragged away from its siblings. Null with none.
 */
export function nearestPlace(places, y, reach) {
  if (!places.length || y < places[0].y - reach || y > places.at(-1).y + reach) return null;
  return places.reduce((nearest, place) => (Math.abs(y - place.y) < Math.abs(y - nearest.y) ? place : nearest));
}

/**
 * Whether `y` is in the middle of `span`, the HEAD branch's row, where a branch let go
 * of merges into it, rather than at its edges, where it's moved before or after it.
 */
export const inMiddle = (span, y) => {
  const share = (y - span.top) / (span.bottom - span.top);
  return share > 0.25 && share < 0.75;
};
