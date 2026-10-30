// Prepares a release from the command line: sets the version everywhere it's
// recorded, commits, and tags. Pushing the tag then has GitHub build and publish the
// packages. (Tagging in Palace works too; the workflow takes the version from the tag.)
//
//   npm run release -- 0.2.0       an exact version
//   npm run release -- patch       0.1.0 → 0.1.1 (also: minor, major)
//   npm run release -- 0.2.0 notes.md
//                                  with release notes (Markdown), shown on the release

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setVersion, VERSION_FILES } from "./set-version.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const current = JSON.parse(readFileSync("package.json", "utf8")).version;
const next = nextVersion(current, process.argv[2]);

if (git("status", "--porcelain")) {
  fail("commit or stash your changes first; the release commit should contain only the version bump.");
}
if (git("tag", "--list", `v${next}`)) {
  fail(`the tag v${next} already exists.`);
}
const notes = process.argv[3];
if (notes && !existsSync(notes)) {
  fail(`there's no notes file at ${notes}.`);
}

setVersion(next);

git("add", ...VERSION_FILES);
git("commit", "--quiet", "--message", `Release v${next}`);
// The workflow puts the tag's message on the release as its notes. "verbatim" keeps
// lines starting with "#", which git would otherwise drop as comments.
if (notes) git("tag", "--annotate", "--cleanup=verbatim", `v${next}`, "--file", notes);
else git("tag", "--annotate", `v${next}`, "--message", `Palace v${next}`);

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
