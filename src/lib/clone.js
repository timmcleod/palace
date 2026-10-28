import { homeDir } from "@tauri-apps/api/path";
import { recentRepositories } from "./storage.js";
import { settings } from "./settings.js";

/**
 * The folder new clones go in. Until one is chosen in Settings, it's wherever recent
 * repositories mostly live as <folder>/<owner>/<repository> (such as ~/Work/github
 * for ~/Work/github/acme/site), or ~/Code.
 */
export async function cloneFolder() {
  if (settings.cloneFolder) return settings.cloneFolder;
  const home = await homeDir();
  const counts = new Map();
  for (const repo of recentRepositories()) {
    const folder = repo.path.split("/").slice(0, -2).join("/");
    if (folder && folder !== home) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= 2 ? best[0] : `${home}/Code`;
}

/** The owner and repository a URL names, e.g. https://github.com/acme/site.git. */
export function repoFromUrl(url) {
  const match = url.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (match) return { owner: match[1], name: match[2] };
  const name = url.trim().replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "");
  return name ? { owner: null, name } : null;
}

/** Where a clone of `url` goes by default: <folder>/<owner>/<repository>. */
export function suggestedLocation(folder, url) {
  const repo = repoFromUrl(url);
  if (!repo) return "";
  return [folder, repo.owner, repo.name].filter(Boolean).join("/");
}

/** After cloning to <folder>/<owner>/<repository>, offer that folder next time. */
export function rememberCloneFolder(url, location) {
  const repo = repoFromUrl(url);
  const suffix = repo?.owner ? `/${repo.owner}/${repo.name}` : null;
  if (suffix && location.endsWith(suffix)) settings.cloneFolder = location.slice(0, -suffix.length);
}
