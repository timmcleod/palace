// Sets the app's version in every file that records it.
//
//   node scripts/set-version.mjs 0.2.0
//
// The release workflow runs this with the version from the pushed tag, so a tag made
// anywhere (in Palace, or with git) builds a release with the right version.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

const PATTERNS = {
  "package.json": /("version":\s*")[^"]+(")/,
  // Palace's own version, at the top and in its entry among the packages; npm
  // install would otherwise change both to match package.json. Not a dependency's.
  "package-lock.json": [
    /(^\{\s*"name":\s*"palace",\s*"version":\s*")[^"]+(")/,
    /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"palace",\s*"version":\s*")[^"]+(")/,
  ],
  "src-tauri/tauri.conf.json": /("version":\s*")[^"]+(")/,
  // Only the package's own version, under [package], not a dependency's.
  "src-tauri/Cargo.toml": /(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/,
  "src-tauri/Cargo.lock": /(\[\[package\]\]\nname = "palace"\nversion = ")[^"]+(")/,
};

export function setVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`“${version}” isn't a version like 1.2.3.`);
  }
  for (const file of VERSION_FILES) {
    let text = readFileSync(file, "utf8");
    for (const pattern of [PATTERNS[file]].flat()) {
      if (!pattern.test(text)) throw new Error(`couldn't find the version in ${file}.`);
      text = text.replace(pattern, `$1${version}$2`);
    }
    writeFileSync(file, text);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    setVersion((process.argv[2] ?? "").replace(/^v/, ""));
    console.log(`Set the version to ${process.argv[2].replace(/^v/, "")}.`);
  } catch (e) {
    console.error(`set-version: ${e.message}`);
    process.exit(1);
  }
}
