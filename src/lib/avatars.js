import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// GitHub profile pictures by lowercased author email. The backend finds them in the
// background and reports them as they arrive; authors without one keep their initials.
export const avatars = reactive({});

let currentPath = null;

listen("avatars", (event) => {
  if (event.payload.path !== currentPath) return;
  Object.assign(avatars, event.payload.avatars);
});

export function loadAvatars(path) {
  if (path !== currentPath) {
    for (const email of Object.keys(avatars)) delete avatars[email];
    currentPath = path;
  }
  invoke("github_avatars", { path }).catch(() => {});
}

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
