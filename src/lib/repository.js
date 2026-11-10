import { onBeforeUnmount, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { NOT_A_REPOSITORY, isError } from "./errors.js";

/**
 * Loading the window's repository, and refreshing it as it changes. The state is the
 * window's, App.vue's, as the rest of it reads it too:
 *   overview     the open repository's overview (see repo_overview), or null
 *   loading      whether one the user chose is opening
 *   error        why the one chosen couldn't be opened, shown in its place
 *   refreshKey   counted up each refresh, for the views to read theirs again
 *   listsFiles   whether a view showing lists the changed files, read with the overview
 * And what App.vue does around a load:
 *   onSwitch(data)                 another repository is about to show: views are reset
 *                                  (overview still holds the one before)
 *   onLoaded(data)                 it's showing: it's among the recent ones
 *   onNotRepository(path, options) the folder chosen isn't a repository
 *   onOpenFailed(path, error)      the one chosen couldn't open, and the one showing
 *                                  stays
 * Returns folderGone, whether the one showing's folder has gone, as removed or moved,
 * loadRepository, refresh, and loadsStarted, for telling which overviews were read
 * after something happened (each has `readAt`).
 */
export function useRepository({ overview, loading, error, refreshKey, listsFiles, onSwitch, onLoaded, onNotRepository, onOpenFailed }) {
  // Each load gets a sequence number so a slow, older load can't overwrite a newer one.
  let loadSeq = 0;
  // The open repository's folder, once it's gone: removed as a worktree, or moved or
  // deleted. The window goes on showing it as it was, saying so, until it's closed.
  const folderGone = ref(false);

  /**
   * Opens the repository at `path`. `quiet` refreshes the open one in the background.
   * `keepOnError` keeps the one showing if this one can't be opened.
   */
  async function loadRepository(path, { quiet = false, keepOnError = false } = {}) {
    // A background reload while a repository the user chose is opening would, being
    // newer, win over it, and the one chosen would never show.
    if (quiet && loading.value) return;
    const seq = ++loadSeq;
    if (!quiet) {
      loading.value = true;
    }

    try {
      const data = await invoke("repo_overview", { path, files: listsFiles.value });
      // When it was read, as against what else happened meanwhile (see lostCommits.js).
      data.readAt = seq;
      if (seq !== loadSeq) return;
      // With another refresh to follow, as for files just staged, the files this one read
      // may be from before: they wait for it, rather than undo what the list shows.
      if (quiet && refreshAgain && data.path === overview.value?.path) data.files = overview.value.files;
      // Open in another window already, that window comes forward instead.
      if (data.path !== overview.value?.path && (await invoke("show_window_with", { path: data.path }).catch(() => false))) return;
      if (seq !== loadSeq) return;
      if (data.path !== overview.value?.path) onSwitch(data);
      overview.value = data;
      folderGone.value = false;
      error.value = "";
      onLoaded(data);
    } catch (e) {
      if (seq !== loadSeq) return;
      // A failed background refresh keeps showing the last good state, saying so when
      // that's because the folder is gone.
      if (quiet) {
        if (path === overview.value?.path && !(await invoke("folder_exists", { path }).catch(() => true))) {
          if (seq === loadSeq) folderGone.value = true;
        }
        return;
      }
      if (isError(e, NOT_A_REPOSITORY)) {
        onNotRepository(path, { keepOnError });
        return;
      }
      if (keepOnError && overview.value) {
        onOpenFailed(path, e);
      } else {
        overview.value = null;
        error.value = `Couldn't open ${path}: ${e}`;
      }
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
  }

  // One refresh at a time: asked for again while one is under way, as the watcher does
  // while an agent writes files, it goes once more when that one's done, so nothing's
  // missed, but reads don't pile up.
  let refreshing = null;
  let refreshAgain = false;

  function refresh() {
    // While a repository the user chose is still opening, a refresh would reload the one
    // on screen and, being newer, win over the switch. The window regains focus as the
    // folder picker closes, so without this, opening another repository did nothing.
    if (!overview.value || loading.value) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    const path = overview.value.path;
    refreshing = (async () => {
      // Its folder gone, the views keep what they last showed, rather than each failing
      // to read it again and saying so in its place. It's looked for each time, so a
      // folder put back is shown again.
      if (!(await invoke("folder_exists", { path }).catch(() => true))) {
        folderGone.value = true;
        return;
      }
      // One chosen may have started opening meanwhile, as when the window comes forward
      // as the folder picker closes: the views are about to show that one instead.
      if (loading.value) return;
      refreshKey.value++;
      await loadRepository(path, { quiet: true });
    })().finally(() => {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        refresh();
      }
    });
  }

  // The file watcher catches most changes made elsewhere; refreshing on focus also
  // catches any it misses, such as on network drives where changes aren't reported.
  window.addEventListener("focus", refresh);
  onBeforeUnmount(() => window.removeEventListener("focus", refresh));

  // How many loads have started, so far: an overview's readAt is the count as its own
  // started.
  const loadsStarted = () => loadSeq;

  return { folderGone, loadRepository, refresh, loadsStarted };
}
