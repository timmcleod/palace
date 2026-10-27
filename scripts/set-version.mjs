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
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

const PATTERNS = {
  "package.json": /("version":\s*")[^"]+(")/,
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
    const text = readFileSync(file, "utf8");
    if (!PATTERNS[file].test(text)) throw new Error(`couldn't find the version in ${file}.`);
    writeFileSync(file, text.replace(PATTERNS[file], `$1${version}$2`));
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
