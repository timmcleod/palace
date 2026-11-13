import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { loadAvatars } from "./avatars.js";
import { shortcut } from "./platform.js";
import { settings } from "./settings.js";

// Every few minutes, the open repository's remotes are fetched quietly, so the counts
// of commits to pull and push stay current. Failures (offline, a locked key) are let
// go until the next time.

/**
 * overview: the repository overview ref. busy(): whether an operation the user started
 * is running, and loading(): whether a repository is loading, which a background fetch
 * waits for. refresh(): reloads the open repository, after a fetch brought something.
 *
 * Returns stop(), which cancels a background fetch under way and waits for it, so what
 * the user does goes first; markFetched(path), for a fetch or pull the user ran; and
 * fetchTitle, the Fetch button's tooltip, saying when the last fetch was.
 */
export function useBackgroundFetch({ overview, busy, loading, refresh }) {
  // When each repository was last fetched, by path, and when a background fetch last
  // tried, which failing doesn't record as fetched.
  const fetchedAt = reactive({});
  const triedAt = {};
  let backgroundFetch = null;
  // The repository it's fetching, which canceling names.
  let fetching = null;
  const now = ref(Date.now());

  function fetchIfDue() {
    now.value = Date.now();
    const o = overview.value;
    if (!settings.fetchInBackground || !o?.remotes.length || backgroundFetch || busy()) return;
    if (loading() || !navigator.onLine) return;
    const last = Math.max(fetchedAt[o.path] ?? 0, triedAt[o.path] ?? 0);
    if (now.value - last < settings.fetchMinutes * 60_000) return;
    triedAt[o.path] = now.value;
    fetching = o.path;
    backgroundFetch = invoke("fetch_in_background", { path: o.path })
      .then(() => {
        fetchedAt[o.path] = Date.now();
        if (o.path === overview.value?.path) {
          loadAvatars(o.path);
          refresh();
        }
      })
      .catch(() => {})
      .finally(() => (backgroundFetch = null));
  }

  // Anything the user does goes first: a background fetch still running is canceled.
  // It also keeps the fetch's new tags out of an undo step's before and after.
  async function stop() {
    if (!backgroundFetch) return;
    invoke("cancel_remote", { path: fetching }).catch(() => {});
    await backgroundFetch;
  }

  function markFetched(path) {
    fetchedAt[path] = Date.now();
  }

  const fetchTimer = setInterval(fetchIfDue, 30_000);
  onBeforeUnmount(() => clearInterval(fetchTimer));
  // A repository is fetched shortly after it's opened, once it has had time to load.
  watch(
    () => overview.value?.path,
    () => setTimeout(fetchIfDue, 3000),
  );

  const fetchTitle = computed(() => {
    const at = overview.value && fetchedAt[overview.value.path];
    if (!at) return `Fetch from all remotes (${shortcut("Ctrl+R")})`;
    const minutes = Math.floor((now.value - at) / 60_000);
    const ago = minutes < 1 ? "just now" : minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
    return `Fetch from all remotes (${shortcut("Ctrl+R")}), last fetched ${ago}`;
  });

  return { stop, markFetched, fetchTitle };
}
