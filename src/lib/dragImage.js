import { isMac } from "./platform.js";

/**
 * Shows `image`, an element on the page, as what follows the pointer while dragging,
 * held at `at`, a point in it in CSS pixels, or else at its left end, middle. On Linux,
 * WebKitGTK draws it at the screen's pixel density and GTK then scales that up again,
 * so on a high-resolution screen it came out twice the size or more: it's made that
 * much smaller first, to end up the size it is.
 */
export function setDragImage(event, image, at = null) {
  const scale = isMac ? 1 : 1 / (window.devicePixelRatio || 1);
  // A transform, not zoom: zoom gives text a minimum size, so it stayed large.
  if (scale !== 1) Object.assign(image.style, { transform: `scale(${scale})`, transformOrigin: "0 0" });
  const { height } = image.getBoundingClientRect();
  const [x, y] = at ? [at.x * scale, at.y * scale] : [14 * scale, height / 2];
  event.dataTransfer.setDragImage(image, Math.round(x), Math.round(y));
}

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
