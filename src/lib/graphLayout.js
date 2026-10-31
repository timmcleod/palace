// Where the history graph's columns go. Up to MAX_LANES columns get their full width;
// past that, the first ones keep it and the rest squeeze into the last two columns'
// space, so a history with dozens of branches open at once doesn't push the commits
// out of view.
export const LANE_WIDTH = 14;
const LEFT = 10;
export const MAX_LANES = 10;
const FULL = MAX_LANES - 3;
const BAND = 2 * LANE_WIDTH;

// { width, x(lane), squeezed(lane) } for a graph showing `lanes` columns.
export function graphLayout(lanes) {
  const count = Math.max(1, lanes);
  if (count <= MAX_LANES) {
    return { width: count * LANE_WIDTH + LEFT, x: (lane) => LEFT + lane * LANE_WIDTH, squeezed: () => false };
  }
  const step = BAND / (count - 1 - FULL);
  return {
    width: MAX_LANES * LANE_WIDTH + LEFT,
    x: (lane) => LEFT + Math.min(lane, FULL) * LANE_WIDTH + Math.max(0, lane - FULL) * step,
    squeezed: (lane) => lane > FULL,
  };
}

// How many columns a row's graph uses.
export function lanesOf(graph) {
  return Math.max(graph.lane, ...graph.pass, ...graph.merge_in, ...graph.out) + 1;
}
