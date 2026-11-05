import { computed, reactive, ref } from "vue";

/**
 * The status card in the corner of the window (RemoteStatus.vue): what an operation is
 * doing or did. One at a time; showing another replaces it. A card is { title, state:
 * "running" | "done" | "failed" | "conflict", message, actions } and, for one runGit
 * shows, { command, line, cancellable }.
 *
 * Returns card (the ref RemoteStatus shows), busy (whether it shows an operation still
 * running), show(card, { dismissAfter }), dismissLater(card, ms) and dismiss().
 */
export function useStatusCard() {
  const card = ref(null);
  let timer;

  const busy = computed(() => card.value?.state === "running");

  // Shows `shown` in place of whatever's there, and returns it, made reactive so what
  // the caller changes on it later shows. With `dismissAfter` (ms), it goes away by
  // itself then; otherwise it stays until dismissed or replaced.
  function show(shown, { dismissAfter } = {}) {
    clearTimeout(timer);
    shown = reactive(shown);
    card.value = shown;
    if (dismissAfter) dismissLater(shown, dismissAfter);
    return shown;
  }

  // Dismisses `shown` after `ms`, restarting any countdown already going, unless it's
  // been replaced by then.
  function dismissLater(shown, ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (card.value === shown) card.value = null;
    }, ms);
  }

  function dismiss() {
    card.value = null;
  }

  return { card, busy, show, dismissLater, dismiss };
}
