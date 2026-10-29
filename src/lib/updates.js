import { reactive, watch } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { settings } from "./settings.js";

// Updates come from the latest GitHub release, whose latest.json lists the newest
// version and its signed packages. Palace checks a few seconds after starting and
// then daily, and installs only when asked.
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

const RELEASES = "https://github.com/timmcleod/palace/releases";
export const releaseNotesUrl = (version) => `${RELEASES}/tag/v${version}`;

const FIRST_CHECK = 5 * 1000;
const DAILY = 24 * 60 * 60 * 1000;

let found = null;

getVersion()
  .then((v) => (updates.current = v))
  .catch(() => {});

/** Asks GitHub for a newer version. `quiet` checks leave errors unshown. */
export async function checkForUpdates({ quiet = false } = {}) {
  if (updates.state === "checking" || updates.state === "installing") return;
  updates.state = "checking";
  updates.error = "";
  try {
    found = await check();
    if (found) {
      if (found.version !== updates.version) updates.dismissed = false;
      updates.version = found.version;
      updates.state = "available";
    } else {
      updates.state = "none";
    }
  } catch (e) {
    updates.state = quiet ? "idle" : "error";
    updates.error = explain(String(e));
  }
}

// The updater's own wording, in Palace's where it's unclear.
function explain(message) {
  // The newest release has no download for this kind of computer, such as a Linux-only
  // release checked from a Mac.
  if (message.includes("platforms")) return "the newest release doesn't include a version for this computer yet.";
  return message;
}

/** Downloads and installs the update, then restarts Palace into it. */
export async function installUpdate() {
  if (!found) return;
  updates.state = "installing";
  updates.downloaded = 0;
  updates.total = 0;
  try {
    await found.downloadAndInstall((event) => {
      if (event.event === "Started") updates.total = event.data.contentLength ?? 0;
      if (event.event === "Progress") updates.downloaded += event.data.chunkLength;
    });
    await relaunch();
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
