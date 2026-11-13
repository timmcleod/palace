import { reactive, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { settings } from "./settings.js";

// GitHub profile pictures by lowercased author email. The backend finds them in the
// background and reports them as they arrive; authors without one keep their initials.
// They're kept for every repository the page has open, together: someone's picture is
// the same in each.
export const avatars = reactive({});

// The repositories open, whose authors' pictures are asked for.
const open = new Set();

listen("avatars", (event) => {
  if (!open.has(event.payload.path) || !settings.githubAvatars) return;
  Object.assign(avatars, event.payload.avatars);
});

function clear() {
  for (const email of Object.keys(avatars)) delete avatars[email];
}

/** Asks for the pictures of the authors in the repository at `path`, as it opens. */
export function loadAvatars(path) {
  open.add(path);
  // Turned off in Settings: nothing is looked up, and everyone shows initials.
  if (settings.githubAvatars) invoke("github_avatars", { path }).catch(() => {});
}

/** The repository at `path` is closed: its pictures aren't asked for again. */
export function forgetAvatars(path) {
  open.delete(path);
}

watch(
  () => settings.githubAvatars,
  (on) => {
    if (!on) return clear();
    for (const path of open) loadAvatars(path);
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
