import { reactive, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { settings } from "./settings.js";

// GitHub profile pictures by lowercased author email. The backend finds them in the
// background and reports them as they arrive; authors without one keep their initials.
export const avatars = reactive({});

let currentPath = null;

listen("avatars", (event) => {
  if (event.payload.path !== currentPath || !settings.githubAvatars) return;
  Object.assign(avatars, event.payload.avatars);
});

function clear() {
  for (const email of Object.keys(avatars)) delete avatars[email];
}

export function loadAvatars(path) {
  if (path !== currentPath) {
    clear();
    currentPath = path;
  }
  // Turned off in Settings: nothing is looked up, and everyone shows initials.
  if (settings.githubAvatars) invoke("github_avatars", { path }).catch(() => {});
}

watch(
  () => settings.githubAvatars,
  (on) => (on && currentPath ? loadAvatars(currentPath) : clear()),
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
