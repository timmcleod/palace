/**
 * Dragging a pane's edge to resize it, from its pointerdown `event`: `move(distance)`
 * is told how far the pointer has gone since, across for `axis` "x" or down for "y",
 * and `done()` once it's let go, or the edge loses the pointer, as when the window does.
 * Meanwhile no text is selected as the pointer crosses it, and the resizing cursor
 * stays wherever it goes (see body.resizing in styles.css).
 */
export function dragEdge(event, { axis, move, done = () => {} }) {
  const target = event.currentTarget;
  const at = (e) => (axis === "x" ? e.clientX : e.clientY);
  const start = at(event);
  const classes = ["resizing", axis === "x" ? "resizing-columns" : "resizing-rows"];
  target.setPointerCapture(event.pointerId);
  // Not starting a selection in the text the drag begins beside, either.
  event.preventDefault();
  document.body.classList.add(...classes);

  const onMove = (e) => move(at(e) - start);
  const stop = () => {
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("lostpointercapture", stop);
    document.body.classList.remove(...classes);
    done();
  };
  target.addEventListener("pointermove", onMove);
  target.addEventListener("lostpointercapture", stop);
}
