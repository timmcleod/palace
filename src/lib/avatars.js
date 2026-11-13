import { reactive, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { settings } from "./settings.js";

// GitHub profile pictures by lowercased author email. The backend finds them in the
// background and reports them as they arrive; authors without one keep their initials.
// They're kept for every repository the page has open, together: someone's picture is
// the same in each.
export const avatars = reactive({});

// The repositories open, whose authors' pictures are asked for, each with the emails
// of those its reports brought: a repository closed takes those only it had with it, so
// pictures don't pile up as one tab after another opens repositories.
const open = new Map();

listen("avatars", (event) => {
  const { path, avatars: found } = event.payload;
  if (!open.has(path) || !settings.githubAvatars) return;
  for (const email of Object.keys(found)) open.get(path).add(email);
  Object.assign(avatars, found);
});

function clear() {
  for (const email of Object.keys(avatars)) delete avatars[email];
}

/** Asks for the pictures of the authors in the repository at `path`, as it opens. */
export function loadAvatars(path) {
  if (!open.has(path)) open.set(path, new Set());
  // Turned off in Settings: nothing is looked up, and everyone shows initials.
  if (settings.githubAvatars) invoke("github_avatars", { path }).catch(() => {});
}

/** The repository at `path` is closed: its pictures aren't asked for again, and those no other open one has go. */
export function forgetAvatars(path) {
  const emails = open.get(path);
  open.delete(path);
  const kept = new Set([...open.values()].flatMap((theirs) => [...theirs]));
  for (const email of emails ?? []) if (!kept.has(email)) delete avatars[email];
}

watch(
  () => settings.githubAvatars,
  (on) => {
    if (!on) return clear();
    for (const path of open.keys()) loadAvatars(path);
  },
);

// Asks GitHub for a picture sized for the screen it's shown on.
export function sizedAvatar(url, size) {
  const pixels = String(Math.ceil(size * (window.devicePixelRatio || 1)));
  try {
    const sized = new URL(url);
    sized.searchParams.set(sized.hostname === "github.com" ? "size" : "s", pixels);
    return sized.href;
  } catch {
    return url;
  }
}
