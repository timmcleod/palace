// Prepares a release: sets the version everywhere it's recorded, commits, and tags.
// Pushing the tag then has GitHub build and publish the packages.
//
//   npm run release -- 0.2.0       an exact version
//   npm run release -- patch       0.1.0 → 0.1.1 (also: minor, major)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FILES = {
  package: "package.json",
  tauri: "src-tauri/tauri.conf.json",
  cargo: "src-tauri/Cargo.toml",
  lock: "src-tauri/Cargo.lock",
};

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const current = JSON.parse(readFileSync(FILES.package, "utf8")).version;
const next = nextVersion(current, process.argv[2]);

if (git("status", "--porcelain")) {
  fail("commit or stash your changes first; the release commit should contain only the version bump.");
}
if (git("tag", "--list", `v${next}`)) {
  fail(`the tag v${next} already exists.`);
}

replace(FILES.package, /("version":\s*")[^"]+(")/, next);
replace(FILES.tauri, /("version":\s*")[^"]+(")/, next);
// Only the package's own version, under [package], not a dependency's.
replace(FILES.cargo, /(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/, next);
replace(FILES.lock, /(\[\[package\]\]\nname = "palace"\nversion = ")[^"]+(")/, next);

git("add", ...Object.values(FILES));
git("commit", "--quiet", "--message", `Release v${next}`);
git("tag", "--annotate", `v${next}`, "--message", `Palace v${next}`);

console.log(`Prepared v${next} (was ${current}). Publish it with:\n\n  git push --follow-tags\n`);

function nextVersion(version, request) {
  if (!request) fail("say which version, e.g. npm run release -- 0.2.0 (or patch, minor, major).");
  const [major, minor, patch] = version.split(".").map(Number);
  const bumped = {
    major: `${major + 1}.0.0`,
    minor: `${major}.${minor + 1}.0`,
    patch: `${major}.${minor}.${patch + 1}`,
  }[request];
  const result = bumped ?? request.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(result)) fail(`“${request}” isn't a version like 1.2.3, or patch, minor or major.`);
  return result;
}

function replace(file, pattern, version) {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) fail(`couldn't find the version in ${file}.`);
  writeFileSync(file, text.replace(pattern, `$1${version}$2`));
}
