import { ref, shallowRef } from "vue";

// Colorful icons for files and folders, by name, from Material Icon Theme (see
// scripts/file-icons.mjs): its table of which icon each name gets loads the first time
// one is wanted, and until then, or with Settings › Appearance › File Icons off, files
// and folders keep plain outlines.

const map = shallowRef(null);
let loading = null;

function load() {
  loading ??= import("./fileIconMap.json")
    .then((module) => (map.value = module.default))
    .catch(() => {});
}

// Whether the light theme is showing, which some icons have versions of their own for.
const light = ref(document.documentElement.dataset.theme !== "dark");
new MutationObserver(() => (light.value = document.documentElement.dataset.theme !== "dark")).observe(
  document.documentElement,
  { attributes: true, attributeFilter: ["data-theme"] },
);

/**
 * The URL of the icon for `name` (a file or folder's name, or its path), or null until
 * the icons have loaded. `kind` is "file", "dir", "link" or "submodule".
 */
export function fileIconUrl(name, kind = "file", open = false) {
  const icons = map.value;
  if (!icons) {
    load();
    return null;
  }
  const lower = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const themed = light.value ? icons.light : null;
  let icon;
  if (kind === "dir" || kind === "submodule") {
    const table = open ? "folderNamesOpen" : "folderNames";
    icon = themed?.[table][lower] ?? icons[table][lower] ?? (open ? icons.folderOpen : icons.folder);
  } else {
    icon = themed?.fileNames[lower] ?? icons.fileNames[lower];
    // The longest extension first: "component.spec.ts" is "spec.ts" before "ts".
    for (let dot = lower.indexOf("."); !icon && dot !== -1; dot = lower.indexOf(".", dot + 1)) {
      const extension = lower.slice(dot + 1);
      icon = themed?.fileExtensions[extension] ?? icons.fileExtensions[extension];
    }
    icon ??= icons.file;
  }
  return `/file-icons/${icon}.svg`;
}
