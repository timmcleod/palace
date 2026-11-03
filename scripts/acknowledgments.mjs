// Lists the open-source projects that go into Palace, with their licenses, for
// Settings › Acknowledgments: the npm packages the app ships, the Material Icon Theme
// icons, and the Rust crates compiled into it for this platform (not those only used
// to build it, such as build scripts and macros). Writes src/lib/acknowledgments.json,
// which isn't committed. Runs before `npm run dev` and `npm run build`.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..");

// Each license text once, by index: most crates share the same few.
const texts = [];
const textIndex = new Map();
function addText(text) {
  const key = text.trim();
  if (!textIndex.has(key)) {
    textIndex.set(key, texts.length);
    texts.push(key);
  }
  return textIndex.get(key);
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
function licenseTexts(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      return [addText(readFileSync(join(dir, f), "utf8"))];
    } catch {
      return [];
    }
  });
}

// "git+https://github.com/vuejs/core.git" -> "https://github.com/vuejs/core"
function webUrl(url) {
  if (!url) return null;
  if (typeof url === "object") url = url.url;
  if (!url) return null;
  url = url.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");
  url = url.replace(/^github:/, "https://github.com/");
  if (/^[\w-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return /^https?:\/\//.test(url) ? url : null;
}

// --- npm ------------------------------------------------------------------------

function npmPackages() {
  let lines = [];
  try {
    lines = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch (e) {
    // npm ls exits non-zero for problems it can still list past.
    lines = String(e.stdout ?? "").split("\n").filter(Boolean);
  }
  // The icon set is only needed to build, but its icons ship.
  const dirs = [...new Set([...lines.slice(1), join(root, "node_modules", "material-icon-theme")])];
  const seen = new Set();
  const packages = [];
  for (const dir of dirs) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const id = `${pkg.name}@${pkg.version}`;
    if (!pkg.name || seen.has(id)) continue;
    seen.add(id);
    packages.push({
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "",
      url: webUrl(pkg.homepage) ?? webUrl(pkg.repository),
      texts: licenseTexts(dir),
    });
  }
  return packages;
}

// --- Rust -------------------------------------------------------------------------

function crates() {
  const manifest = join(root, "src-tauri", "Cargo.toml");
  let metadata;
  try {
    const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1];
    metadata = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--manifest-path", manifest, "--filter-platform", host], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    console.warn("acknowledgments: couldn't read the Rust crates (is cargo installed?); listing npm packages only");
    return [];
  }
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const isMacro = (p) => p.targets.some((t) => t.kind.includes("proc-macro"));

  // What the app's binary links: normal dependencies, from Palace down, leaving out
  // build and dev dependencies and macros, which only run while it's built.
  const included = new Set();
  const queue = [metadata.resolve.root];
  while (queue.length) {
    const node = nodes.get(queue.pop());
    for (const dep of node?.deps ?? []) {
      if (included.has(dep.pkg)) continue;
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
      const pkg = packages.get(dep.pkg);
      if (!pkg || isMacro(pkg)) continue;
      included.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  return [...included].map((id) => {
    const p = packages.get(id);
    const dir = dirname(p.manifest_path);
    const files = licenseTexts(dir);
    if (!files.length && p.license_file) {
      try {
        files.push(addText(readFileSync(join(dir, p.license_file), "utf8")));
      } catch {}
    }
    return {
      name: p.name,
      version: p.version,
      license: p.license ?? "",
      url: webUrl(p.repository) ?? webUrl(p.homepage) ?? `https://crates.io/crates/${p.name}`,
      texts: files,
    };
  });
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true });
const app = npmPackages().sort(byName);
const backend = crates().sort(byName);

writeFileSync(
  join(root, "src", "lib", "acknowledgments.json"),
  JSON.stringify({
    groups: [
      { name: "App", packages: app },
      { name: "Backend", packages: backend },
    ],
    texts,
  }),
);
console.log(`acknowledgments: ${app.length} npm packages, ${backend.length} crates, ${texts.length} license texts`);
