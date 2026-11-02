// Prepares the file and folder icons Palace shows, from Material Icon Theme (MIT,
// https://github.com/material-extensions/vscode-material-icon-theme): copies its icons
// to public/file-icons/, with its license, and writes src/lib/fileIconMap.json, which
// says which icon each file name, extension and folder name gets. Runs before
// `npm run dev` and `npm run build`; neither output is committed.

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = dirname(require.resolve("material-icon-theme/package.json"));
const manifest = JSON.parse(readFileSync(join(pkg, "dist", "material-icons.json"), "utf8"));

// "./../icons/folder-src.svg" -> "folder-src", the icon's file name.
const iconFile = (id) => basename(manifest.iconDefinitions[id].iconPath, ".svg");
const names = (table = {}) => Object.fromEntries(Object.entries(table).map(([name, id]) => [name.toLowerCase(), iconFile(id)]));

const map = {
  file: iconFile(manifest.file),
  folder: iconFile(manifest.folder),
  folderOpen: iconFile(manifest.folderExpanded),
  fileNames: names(manifest.fileNames),
  fileExtensions: names(manifest.fileExtensions),
  folderNames: names(manifest.folderNames),
  folderNamesOpen: names(manifest.folderNamesExpanded),
  // Lighter or darker versions of some, for the light theme.
  light: {
    fileNames: names(manifest.light?.fileNames),
    fileExtensions: names(manifest.light?.fileExtensions),
    folderNames: names(manifest.light?.folderNames),
    folderNamesOpen: names(manifest.light?.folderNamesExpanded),
  },
};

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const out = join(root, "public", "file-icons");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const used = new Set(Object.values(manifest.iconDefinitions).map((d) => basename(d.iconPath)));
for (const file of used) copyFileSync(join(pkg, "icons", file), join(out, file));
copyFileSync(join(pkg, "LICENSE"), join(out, "LICENSE"));
writeFileSync(join(root, "src", "lib", "fileIconMap.json"), JSON.stringify(map));
console.log(`file-icons: ${used.size} icons`);
