/**
 * A copy of `element`, a tab or a row, to show as it's dragged: as it looks where it
 * is, at its width there, but for the line of where a drag would land, and inert, so
 * neither the keyboard nor a screen reader takes it for another one while it's on the
 * page.
 */
export function dragCopy(element) {
  const copy = element.cloneNode(true);
  copy.classList.remove("drop-before", "drop-after");
  copy.setAttribute("inert", "");
  copy.setAttribute("aria-hidden", "true");
  copy.style.width = `${element.getBoundingClientRect().width}px`;
  return copy;
}

/** Where in `element` the point `x`, `y` on the page is, to hold its copy by there. */
export function grabPoint(element, x, y) {
  const rect = element.getBoundingClientRect();
  return { x: x - rect.left, y: y - rect.top };
}
