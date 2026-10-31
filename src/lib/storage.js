import { invoke } from "@tauri-apps/api/core";

// Palace's saved data, by key: kept by Palace in a file (see store.rs), and read from
// memory once loadStore() has run, before the app starts. Values can be stale or
// missing, so every read falls back to a default instead of throwing.
let values = {};
let saving = Promise.resolve();

/**
 * Why the saved data couldn't be read at startup, or "". Then nothing is saved, so
 * none of it is overwritten, until Palace restarts.
 */
export let storeProblem = "";

// Before 0.11.3, these were kept in the web view's storage.
function fromWebView() {
  const found = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith("palace.")) continue;
      try {
        found[key] = JSON.parse(localStorage.getItem(key));
      } catch {
        // Unreadable: left behind.
      }
    }
  } catch {
    // No web view storage at all.
  }
  return found;
}

export async function loadStore() {
  try {
    values = (await invoke("load_store")) ?? {};
  } catch (e) {
    storeProblem = String(e);
    values = fromWebView();
    return;
  }
  // Keys are never removed, so one the file doesn't have yet was never copied over.
  const missing = Object.fromEntries(Object.entries(fromWebView()).filter(([key]) => !(key in values)));
  if (Object.keys(missing).length) {
    Object.assign(values, missing);
    save(missing);
  }
}

function save(changes) {
  if (storeProblem) return;
  // One at a time, in order, so an older value never lands after a newer one.
  saving = saving.then(() => invoke("save_store", { values: changes })).catch(() => {
    // Not worth interrupting for; the value is kept in memory meanwhile.
  });
}

/** After storeProblem: sets the unreadable file aside and saves what's in use now. */
export async function setStoreAside() {
  await invoke("set_store_aside");
  storeProblem = "";
  save(values);
}

export function readJson(key, fallback) {
  const value = values[key];
  // A copy, so changing what's read never changes what's saved.
  return value === undefined ? fallback : structuredClone(value);
}

export function writeJson(key, value) {
  const copy = JSON.parse(JSON.stringify(value));
  values[key] = copy;
  save({ [key]: copy });
}

const RECENTS_KEY = "palace.recentRepositories";
const MAX_RECENTS = 15;

export function recentRepositories() {
  const recents = readJson(RECENTS_KEY, []);
  return Array.isArray(recents) ? recents : [];
}

export function rememberRepository(repo) {
  const recents = recentRepositories().filter((r) => r.path !== repo.path);
  recents.unshift({ name: repo.name, path: repo.path });
  writeJson(RECENTS_KEY, recents.slice(0, MAX_RECENTS));
}

export function forgetRepository(path) {
  writeJson(RECENTS_KEY, recentRepositories().filter((r) => r.path !== path));
}
