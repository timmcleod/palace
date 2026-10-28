import { reactive, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readJson, writeJson } from "./storage.js";

// App-wide preferences, kept in local storage and applied to the page as they change.
const KEY = "palace.settings";

const DEFAULTS = {
  // "system", "light" or "dark".
  theme: "system",
  // "accessible" (blue and orange) or "classic" (green and red).
  diffColors: "accessible",
  tabSize: 4,
  githubAvatars: true,
  // Where new clones go, as <folder>/<owner>/<repository>; null until chosen, when
  // it's worked out from where recent repositories are (see clone.js).
  cloneFolder: null,
  // Look for new versions of Palace on GitHub at startup and daily.
  checkForUpdates: true,
};

export const settings = reactive({ ...DEFAULTS, ...readJson(KEY, {}) });

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function apply() {
  const root = document.documentElement;
  const dark = settings.theme === "dark" || (settings.theme === "system" && systemDark.matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.diffColors = settings.diffColors;
  root.style.setProperty("--tab-size", String(settings.tabSize));
}

apply();
systemDark.addEventListener("change", apply);

watch(
  settings,
  () => {
    apply();
    writeJson(KEY, { ...settings });
  },
  { deep: true },
);

// The window's title bar follows the chosen theme too.
watch(
  () => settings.theme,
  (theme) => {
    getCurrentWindow()
      .setTheme(theme === "system" ? null : theme)
      .catch(() => {});
  },
  { immediate: true },
);
