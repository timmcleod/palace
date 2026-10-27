// Small localStorage wrappers. Storage can be unavailable or hold stale data, so every
// read falls back to a default instead of throwing.

export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not worth surfacing; these are only conveniences.
  }
}

const RECENTS_KEY = "palace.recentRepositories";
const MAX_RECENTS = 10;

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
