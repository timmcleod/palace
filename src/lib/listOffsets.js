// Finding things in a long list laid out by hand, as the history is (see
// HistoryList.vue): each item's offset down it, from its top, in order.

/**
 * Which item `y` down the list is in: the last whose offset is at or above it, found by
 * halves, as a history can be long. 0 above the first, and the last past the end.
 */
export function itemAt(offsets, y) {
  let at = 0;
  let end = offsets.length - 1;
  while (at < end) {
    const mid = (at + end + 1) >> 1;
    if (offsets[mid] <= y) at = mid;
    else end = mid - 1;
  }
  return at;
}
