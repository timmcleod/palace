import { nextTick, onBeforeUnmount, ref } from "vue";
import { grabPoint, dragCopy } from "./dragImage.js";
import { pointerDrag } from "./rowDrag.js";
import { slideFrom } from "./slide.js";

// Dragging a tab along a row of them to put it elsewhere, as the window's tabs and a
// terminal panel's are (TabStrip.vue, TerminalPanel.vue), by the pointer (see
// rowDrag.js): a copy of the tab follows it, held where it was grabbed; the tabs slide
// apart where it would land, a line in the gap (see .tab-row in styles.css);
// and dropped there, they slide into their new order. Escape, or dropping it well away
// from the row, leaves it.

// How far beyond the row a tab let go of still lands in it, about a tab's height: a
// drag along the row wanders, and missing it by a little shouldn't lose it.
export const DROP_REACH = 40;

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

  // Keys as data-key has them, whatever they were.
  const keysNow = () => keys().map(String);
  const tabElements = () => [...list.value.querySelectorAll(":scope > [data-key]")];
  // How far along the row, from its start, scrolled or not, `x` on the page is.
  const alongRow = (x) => x - list.value.getBoundingClientRect().left + list.value.scrollLeft;

  // With the pointer on the row or near it: at the place between tabs nearest it, past
  // either end at that end, unless that leaves it where it is.
  function landing(event) {
    const rect = row.value?.getBoundingClientRect();
    if (!rect) return null;
    const { clientX: x, clientY: y } = event;
    if (x < rect.left - DROP_REACH || x > rect.right + DROP_REACH || y < rect.top - DROP_REACH || y > rect.bottom + DROP_REACH) return null;
    const at = landingAt(spans, alongRow(x));
    return at && dropPlace(keysNow(), String(dragging.value), at) != null ? at : null;
  }

  const drag = pointerDrag({
    image: ({ element }) => image(element),
    hold: ({ element, x, y }) => grabPoint(element, x, y),
    start({ data: key }) {
      dragging.value = key;
      spans = tabElements().map((element) => {
        const { left, right } = element.getBoundingClientRect();
        return { key: element.dataset.key, left: alongRow(left), right: alongRow(right) };
      });
    },
    move: (event) => (dropAt.value = landing(event)),
    drop(event, followed) {
      const key = dragging.value;
      const to = dropAt.value && dropPlace(keysNow(), String(key), dropAt.value);
      if (to == null) return;
      // Where each tab is now, the dropped one where its copy was let go, to slide from
      // into the new order, the gap closing at once (see .tab-row.sorting).
      const elements = tabElements();
      const before = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
      const dropped = elements.find((element) => element.dataset.key === String(key));
      if (dropped) before.set(dropped, followed.getBoundingClientRect());
      move(key, to);
      nextTick(() => slideFrom(before));
    },
    end() {
      dragging.value = null;
      dropAt.value = null;
      spans = [];
    },
  });
  onBeforeUnmount(() => drag.cancel());

  function classOf(key) {
    if (dragging.value == null) return null;
    if (String(key) === String(dragging.value)) return "dragging";
    if (dropAt.value?.key !== String(key)) return null;
    return dropAt.value.after ? "drop-after" : "drop-before";
  }

  return { press: drag.press, dragging, classOf };
}
