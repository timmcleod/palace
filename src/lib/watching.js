import { invoke } from "@tauri-apps/api/core";

/**
 * The backend's watching of the repositories a tab shows, for live refresh (see
 * watch.rs): watch(path) as one comes to show, letGo(path) as it stops. `shownElsewhere`
 * says whether another tab shows the one at a path, which it's then left watched for.
 */
export function useWatching({ shownElsewhere }) {
  // Each repository being watched, by path: done once the backend's watching it.
  const watching = new Map();

  function watch(path) {
    watching.set(path, invoke("watch_repo", { path }).catch(() => {}));
  }

  // Let go of once it's been watched, as letting go first would leave the watcher, set
  // up after, watching for nobody; and only if it's still not shown then. Setting one up
  // can take seconds, and by then this tab may show it again, as on going back to it, or
  // another tab may: letting go would stop that one being watched.
  function letGo(path) {
    if (shownElsewhere(path)) return;
    const watched = watching.get(path) ?? Promise.resolve();
    watching.delete(path);
    watched.then(() => {
      if (watching.has(path) || shownElsewhere(path)) return;
      invoke("release_repo", { path }).catch(() => {});
    });
  }

  return { watch, letGo };
}
