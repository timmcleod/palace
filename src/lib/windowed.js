// Drawing only the rows of a long list that are in view, for lists whose rows are all
// one height. A working copy, a commit's folder or the Files tree can have tens of
// thousands of rows, and drawing every one froze the window.
//
// The rows go in a spacer as tall as the whole list (`spacer`, its ref, `height`, its
// height), inside a block moved down to where the first row drawn goes (`top`):
//
//   const { spacer, rows: shownRows, top, height } = useWindowed(list, rows, 26);
//
//   <div ref="spacer" :style="{ height: `${height}px` }">
//     <div :style="{ transform: `translateY(${top}px)` }">
//       <div v-for="row in shownRows" …>
//
// `scroller` is the ref of the element that scrolls; `rows`, a ref or computed list.

import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";

// Rows drawn above and below those in view, so scrolling a little shows no gap.
const OVERSCAN = 10;

export function useWindowed(scroller, rows, rowHeight) {
  const spacer = ref(null);
  const scrollTop = ref(0);
  const viewHeight = ref(0);
  // Where the spacer starts in what scrolls: below a message above the list, say.
  const offset = ref(0);

  function measure() {
    const el = scroller.value;
    if (!el) return;
    scrollTop.value = el.scrollTop;
    viewHeight.value = el.clientHeight;
    if (spacer.value) {
      offset.value = spacer.value.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    }
  }

  const range = computed(() => {
    const count = rows.value?.length ?? 0;
    const from = scrollTop.value - offset.value;
    const start = Math.max(0, Math.floor(from / rowHeight) - OVERSCAN);
    const end = Math.min(count, Math.ceil((from + viewHeight.value) / rowHeight) + OVERSCAN);
    return [start, Math.max(start, end)];
  });

  const shown = shallowRef([]);
  watch([range, rows], ([[start, end], list]) => (shown.value = (list ?? []).slice(start, end)), { immediate: true });

  const sizes = new ResizeObserver(measure);
  watch(
    scroller,
    (el, old) => {
      old?.removeEventListener("scroll", measure);
      if (old) sizes.unobserve(old);
      el?.addEventListener("scroll", measure, { passive: true });
      if (el) sizes.observe(el);
    },
    { immediate: true },
  );
  watch(spacer, measure);
  onBeforeUnmount(() => {
    scroller.value?.removeEventListener("scroll", measure);
    sizes.disconnect();
  });

  // Scrolls just far enough to show the row at `index`.
  function scrollToRow(index) {
    const el = scroller.value;
    if (!el || index < 0) return;
    measure();
    const top = offset.value + index * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  }

  return {
    spacer,
    rows: shown,
    top: computed(() => range.value[0] * rowHeight),
    height: computed(() => (rows.value?.length ?? 0) * rowHeight),
    scrollToRow,
  };
}
