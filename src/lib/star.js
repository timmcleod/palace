import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { githubAccount } from "./github.js";
import { readJson, writeJson } from "./storage.js";

// Palace asks once, on each computer, for a star on GitHub: a little while after it's
// signed in to GitHub (or starts up signed in), unless the account has starred it
// already. Not before it has been in use for a day, though, so someone trying it for
// the first time isn't asked before they know whether they like it. Settings has a
// link for anyone who'd rather do it later.
export const PALACE_URL = "https://github.com/timmcleod/palace";

const ASKED_KEY = "palace.starAsked";
const FIRST_STARTED_KEY = "palace.firstStarted";
const DELAY = 10 * 1000;
const IN_USE_FOR = 24 * 60 * 60 * 1000;

// When Palace first started on this computer, as far as it knows: from versions before
// this was saved, the first start of one that saves it.
let firstStarted = readJson(FIRST_STARTED_KEY, null);
if (firstStarted == null) {
  firstStarted = Date.now();
  writeJson(FIRST_STARTED_KEY, firstStarted);
}

// "ask", "starring" or "thanks" while the request is on screen; null otherwise.
export const starRequest = ref(null);

let timer = null;
watch(
  githubAccount,
  (account) => {
    clearTimeout(timer);
    // Until a day has gone by, asking waits for a later start or sign-in.
    if (!account || readJson(ASKED_KEY, false) || Date.now() - firstStarted < IN_USE_FOR) return;
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
