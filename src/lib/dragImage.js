import { isMac } from "./platform.js";

/**
 * Shows `image`, an element on the page, as what follows the pointer while dragging,
 * held at its left end, middle. On Linux, WebKitGTK draws it at the screen's pixel
 * density and GTK then scales that up again, so on a high-resolution screen it came out
 * twice the size or more: it's made that much smaller first, to end up the size it is.
 */
export function setDragImage(event, image) {
  const scale = isMac ? 1 : 1 / (window.devicePixelRatio || 1);
  if (scale !== 1) image.style.zoom = String(scale);
  const { height } = image.getBoundingClientRect();
  event.dataTransfer.setDragImage(image, Math.round(14 * scale), Math.round(height / 2));
}
