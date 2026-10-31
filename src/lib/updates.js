import { computed, reactive, watch } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { settings } from "./settings.js";

// Updates come from the latest GitHub release, whose latest.json lists the newest
// version and its signed packages. Palace checks a few seconds after starting, then
// daily and when its window comes to the front (at most hourly), and installs only
// when asked, checking once more first so it installs the newest.
export const updates = reactive({
  current: "",
  // "idle", "checking", "none" (up to date), "available", "installing" or "error".
  state: "idle",
  version: null,
  // Bytes downloaded so far, and the total when known.
  downloaded: 0,
  total: 0,
  error: "",
  // Hidden with "Later" until Palace next starts or finds a newer version.
  dismissed: false,
});

// Whether the notice about an update is on screen.
export const updateNoticeShown = computed(
  () =>
    (updates.state === "available" && !updates.dismissed) ||
    updates.state === "installing" ||
    (updates.state === "error" && updates.version && !updates.dismissed),
);

const RELEASES = "https://github.com/timmcleod/palace/releases";
export const releaseNotesUrl = (version) => `${RELEASES}/tag/v${version}`;

const FIRST_CHECK = 5 * 1000;
const HOURLY = 60 * 60 * 1000;
const DAILY = 24 * HOURLY;

let found = null;
let checking = false;
// When it last asked, whatever the answer: 0 until the first check after starting.
let checkedAt = 0;

getVersion()
  .then((v) => (updates.current = v))
  .catch(() => {});

/**
 * Asks GitHub for a newer version. `quiet` checks happen in the background: they
 * leave the notice as it is while they run, and what was found before if they fail.
 */
export async function checkForUpdates({ quiet = false } = {}) {
  if (checking || updates.state === "installing") return;
  checking = true;
  if (!quiet) {
    updates.state = "checking";
    updates.error = "";
  }
  try {
    const newest = await check();
    if (updates.state === "installing") return;
    found = newest;
    if (found) {
      if (found.version !== updates.version) updates.dismissed = false;
      updates.version = found.version;
      updates.state = "available";
    } else {
      updates.state = "none";
    }
  } catch (e) {
    if (!quiet) {
      updates.state = "error";
      updates.error = explain(String(e));
    } else if (updates.state === "checking") {
      updates.state = "idle";
    }
  } finally {
    checking = false;
    checkedAt = Date.now();
  }
}

// The updater's own wording, in Palace's where it's unclear.
function explain(message) {
  // The newest release has no download for this kind of computer, such as a Linux-only
  // release checked from a Mac.
  if (message.includes("platforms")) return "the newest release doesn't include a version for this computer yet.";
  return message;
}

/**
 * Downloads and installs the update, then restarts Palace into it. A newer version
 * may have come out since the one found, so it asks again first: otherwise, with
 * several releases in a day, one update would only lead to another.
 */
export async function installUpdate() {
  if (!found) return;
  updates.state = "installing";
  updates.downloaded = 0;
  updates.total = 0;
  try {
    // If that fails, or finds nothing, the one already found will do.
    const newest = await check().catch(() => null);
    if (newest) {
      found = newest;
      updates.version = newest.version;
    }
    await found.downloadAndInstall((event) => {
      if (event.event === "Started") updates.total = event.data.contentLength ?? 0;
      if (event.event === "Progress") updates.downloaded += event.data.chunkLength;
    });
    // Palace's own restart: on Linux it waits for this copy to close first.
    await invoke("restart_after_update");
  } catch (e) {
    updates.state = "error";
    updates.error = String(e);
  }
}

// Automatic checks, while they're turned on in Settings. Not in `tauri dev`: its
// version comes from the source, which releases don't bump, so it would always be
// behind. Check Now in Settings still works there.
let timer = null;
function schedule() {
  clearTimeout(timer);
  if (!settings.checkForUpdates || import.meta.env.DEV) return;
  timer = setTimeout(async function run() {
    await checkForUpdates({ quiet: true });
    timer = setTimeout(run, DAILY);
  }, FIRST_CHECK);
}
watch(() => settings.checkForUpdates, schedule, { immediate: true });

// Palace may stay open for days, so it also checks when its window comes to the front,
// if it hasn't for an hour, to offer the newest version rather than an older one.
window.addEventListener("focus", () => {
  if (!settings.checkForUpdates || import.meta.env.DEV) return;
  if (!checkedAt || Date.now() - checkedAt < HOURLY) return;
  checkForUpdates({ quiet: true });
});
