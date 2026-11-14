import { nextTick, onBeforeUnmount, ref } from "vue";
import { grabPoint, dragCopy } from "./dragImage.js";
import { DROP_REACH, edgeScroller, pointerDrag } from "./rowDrag.js";
import { slideFrom } from "./slide.js";

// Dragging a tab along a row of them to put it elsewhere, as the window's tabs and a
// terminal panel's are (TabStrip.vue, TerminalPanel.vue), by the pointer (see
// rowDrag.js): a copy of the tab follows it, held where it was grabbed; the tabs slide
// apart where it would land, a line in the gap (see .tab-row in styles.css);
// and dropped there, they slide into their new order. Escape, or dropping it well away
// from the row, leaves it, the gap sliding shut. Near either end of a row that scrolls,
// it scrolls, to reach the tabs out of sight.

/**
 * Where a tab dragged along the row would land, with the pointer at `x`: at whichever
 * place between two tabs, or at an end, is nearest, as { key, after }, before the tab
 * `key`, or after it at the end; null with no tabs. `spans` is where each tab is along
 * the row, { key, left, right }, in order: as they were when the drag started, so the
 * gap that opens where it'd land, moving the tabs, doesn't move where that is.
 */
export function landingAt(spans, x) {
  if (!spans.length) return null;
  const places = spans.map((span, i) => (i ? (spans[i - 1].right + span.left) / 2 : span.left));
  places.push(spans.at(-1).right);
  let nearest = 0;
  places.forEach((place, i) => {
    if (Math.abs(x - place) < Math.abs(x - places[nearest])) nearest = i;
  });
  return nearest < spans.length ? { key: spans[nearest].key, after: false } : { key: spans.at(-1).key, after: true };
}

/**
 * Where the tab `key` goes among `keys`, the row's, in order, dropped at `at`
 * ({ key, after }): its place once it's taken out of its own. Null where it would stay
 * where it is, or `at` isn't one of them.
 */
export function dropPlace(keys, key, at) {
  const others = keys.filter((other) => other !== key);
  const target = others.indexOf(at.key);
  if (target < 0) return null;
  const to = target + (at.after ? 1 : 0);
  return keys.indexOf(key) === to ? null : to;
}

/**
 * A row of tabs to drag along, each marked with its key as data-key:
 *   row        the element around them, which a tab dropped on or near lands in
 *   list       the one they're in, which may scroll sideways
 *   keys()     their keys, in order
 *   move(key, to)  put the tab `key` at `to` among them, as dropped there
 *   image(element) what follows the pointer; a copy of the tab, by default
 * Returns press(event, key), for a tab's pointerdown; the key being dragged; and
 * classOf(key), a tab's class while dragging: "dragging", or where it would land.
 */
export function useTabRowDrag({ row, list, keys, move, image = dragCopy }) {
  const dragging = ref(null);
  // Where it would land: { key, after }, as landingAt has it, or null for nowhere.
  const dropAt = ref(null);
  // Where each tab was along the row, scrolled or not, as the drag started.
  let spans = [];
  // Where the tab dropped was let go, on the page, to slide into its place from.
  let droppedAt = null;
  // Where the pointer is, for where the tab would land as the row scrolls under it.
  let pointer = null;

  // Keys as data-key has them, whatever they were.
  const keysNow = () => keys().map(String);
  const tabElements = () => [...list.value.querySelectorAll(":scope > [data-key]")];
  // How far along the row, from its start, scrolled or not, `x` on the page is.
  const alongRow = (x) => x - list.value.getBoundingClientRect().left + list.value.scrollLeft;

  // Whether `y` down the page is on the row, or near enough it.
  const nearRow = (rect, y) => y >= rect.top - DROP_REACH && y <= rect.bottom + DROP_REACH;

  // With the pointer on the row or near it: at the place between tabs nearest it, past
  // either end at that end, unless that leaves it where it is.
  function landing({ x, y }) {
    const rect = row.value?.getBoundingClientRect();
    if (!rect || x < rect.left - DROP_REACH || x > rect.right + DROP_REACH || !nearRow(rect, y)) return null;
    const at = landingAt(spans, alongRow(x));
    return at && dropPlace(keysNow(), String(dragging.value), at) != null ? at : null;
  }

  const drag = pointerDrag({
    // Marked to be drawn picked up off the row (.tab-copy in styles.css).
    image: ({ element }) => {
      const copy = image(element);
      copy.classList.add("tab-copy");
      return copy;
    },
    hold: ({ element, x, y }) => grabPoint(element, x, y),
    start({ data: key }) {
      dragging.value = key;
      spans = tabElements().map((element) => {
        const { left, right } = element.getBoundingClientRect();
        return { key: element.dataset.key, left: alongRow(left), right: alongRow(right) };
      });
    },
    move(event) {
      pointer = { x: event.clientX, y: event.clientY };
      dropAt.value = landing(pointer);
      scroller.follow(pointer);
    },
    drop(event, followed) {
      const to = dropAt.value && dropPlace(keysNow(), String(dragging.value), dropAt.value);
      if (to == null) return;
      // Its box, where it's drawn: the copy may be turned or scaled (see TabStrip.vue),
      // which takes its corners out past where it is.
      const drawn = followed.getBoundingClientRect();
      const [left, top] = [drawn.left + (drawn.width - followed.offsetWidth) / 2, drawn.top + (drawn.height - followed.offsetHeight) / 2];
      droppedAt = { left, top };
      move(dragging.value, to);
    },
    end() {
      // Where each tab is, the gap still open, and the one dropped where its copy was let
      // go, to slide from: into their new order, or with none, back together, the gap
      // closing at once (see .tab-row.sorting). Not after a click, which isn't a drag.
      if (dragging.value != null && list.value) {
        const elements = tabElements();
        const before = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
        const dropped = droppedAt && elements.find((element) => element.dataset.key === String(dragging.value));
        if (dropped) before.set(dropped, droppedAt);
        nextTick(() => slideFrom(before));
      }
      scroller.stop();
      pointer = null;
      droppedAt = null;
      dragging.value = null;
      dropAt.value = null;
      spans = [];
    },
  });
  onBeforeUnmount(() => drag.cancel());

  // Near either end of the row, on it or near it, it scrolls, faster the nearer the end,
  // or the further past it, and where it'd land goes with it.
  const scroller = edgeScroller({
    element: () => list.value,
    axis: "x",
    near: (at) => dragging.value != null && !!row.value && nearRow(row.value.getBoundingClientRect(), at.y),
    scrolled: () => (dropAt.value = landing(pointer)),
  });

  function classOf(key) {
    if (dragging.value == null) return null;
    if (String(key) === String(dragging.value)) return "dragging";
    if (dropAt.value?.key !== String(key)) return null;
    return dropAt.value.after ? "drop-after" : "drop-before";
  }

  return { press: drag.press, dragging, classOf };
}
