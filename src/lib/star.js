import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { githubAccount } from "./github.js";
import { readJson, writeJson } from "./storage.js";

// Palace asks once, on each computer, for a star on GitHub: a little while after it's
// signed in to GitHub (or starts up signed in), unless the account has starred it
// already. Settings has a link for anyone who'd rather do it later.
export const PALACE_URL = "https://github.com/timmcleod/palace";

const ASKED_KEY = "palace.starAsked";
const DELAY = 10 * 1000;

// "ask", "starring" or "thanks" while the request is on screen; null otherwise.
export const starRequest = ref(null);

let timer = null;
watch(
  githubAccount,
  (account) => {
    clearTimeout(timer);
    if (!account || readJson(ASKED_KEY, false)) return;
    timer = setTimeout(async () => {
      const starred = await invoke("github_starred_palace").catch(() => null);
      if (starred) markAsked();
      else if (githubAccount.value) starRequest.value = "ask";
    }, DELAY);
  },
  { immediate: true },
);

/** Remembers that the request has been seen, so it isn't made again. */
export function markAsked() {
  writeJson(ASKED_KEY, true);
}

/**
 * Stars Palace with the GitHub account. Tokens that can't star, such as fine-grained
 * ones without that permission, get the repository's page instead.
 */
export async function starPalace() {
  starRequest.value = "starring";
  try {
    await invoke("github_star_palace");
    starRequest.value = "thanks";
    setTimeout(dismissStarRequest, 2500);
  } catch {
    dismissStarRequest();
    openUrl(PALACE_URL);
  }
}

export function dismissStarRequest() {
  starRequest.value = null;
}
