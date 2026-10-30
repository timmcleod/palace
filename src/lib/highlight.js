// Syntax highlighting for diffs and file contents, with highlight.js. It runs in a
// worker (highlightWorker.js), which loads each language the first time a file needs
// it, so the page stays responsive and shows the plain text until the colors are
// ready. Very large or minified text is left plain.

// Languages by file name or extension. A few names are checked in languageFor.
const BY_NAME = { dockerfile: "dockerfile", makefile: "makefile", gemfile: "ruby", rakefile: "ruby" };
const BY_EXTENSION = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  vue: "xml", html: "xml", htm: "xml", xml: "xml", svg: "xml", plist: "xml",
  php: "php", phtml: "php-template",
  css: "css", scss: "scss", less: "less",
  json: "json", jsonc: "json",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", env: "bash",
  md: "markdown", markdown: "markdown",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", m: "objectivec", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", fs: "fsharp", sql: "sql", lua: "lua", dart: "dart", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", scala: "scala", groovy: "groovy", gradle: "groovy", pl: "perl",
  r: "r", jl: "julia", ps1: "powershell", graphql: "graphql", gql: "graphql", proto: "protobuf",
  twig: "twig", diff: "diff", patch: "diff",
};


/** The language to highlight `file` (a path) as, or null. */
export function languageFor(file) {
  if (!file) return null;
  const name = file.split("/").pop().toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.endsWith(".blade.php")) return "xml";
  if (name.startsWith(".env")) return "bash";
  if (name === "package-lock.json" || name === "composer.lock") return "json";
  const extension = name.includes(".") ? name.split(".").pop() : "";
  return BY_EXTENSION[extension] ?? null;
}

// Past these, highlighting would take too long, or the text is minified.
const MAX_CHARS = 400_000;
const MAX_LINE = 2_000;

/**
 * Highlights each of `blocks` (arrays of lines, read as continuous text) as `file`'s
 * language. Resolves to the blocks' lines as arrays of { text, kind }, `kind` being
 * the highlight.js class or "", or null when the text stays plain.
 */
export async function highlightBlocks(file, blocks) {
  const language = languageFor(file);
  if (!language) return null;
  let chars = 0;
  for (const lines of blocks) {
    for (const line of lines) {
      if (line.length > MAX_LINE) return null;
      chars += line.length + 1;
    }
  }
  if (chars > MAX_CHARS) return null;
  return request({ language, blocks });
}

/** Highlights a whole file's text as HTML, or resolves to null to leave it plain. */
export async function highlightText(file, text) {
  const language = languageFor(file);
  if (!language || text.length > MAX_CHARS || text.split("\n").some((l) => l.length > MAX_LINE)) return null;
  return request({ language, text });
}

let worker = null;
let nextId = 0;
const waiting = new Map();

// Sends a request to the worker, started the first time it's needed. A worker that
// fails to start leaves everything plain.
function request(message) {
  if (!worker) {
    worker = new Worker(new URL("./highlightWorker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      waiting.get(data.id)?.(data.result);
      waiting.delete(data.id);
    };
    worker.onerror = () => {
      for (const resolve of waiting.values()) resolve(null);
      waiting.clear();
    };
  }
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker.postMessage({ id, ...message });
  });
}

/**
 * Combines a line's highlighting with its changed words (see wordDiff.js) into pieces
 * of { text, kind, changed }. Either may be null.
 */
export function combine(tokens, words) {
  if (!words) return tokens.map((t) => ({ ...t, changed: false }));
  const text = (parts) => parts.map((p) => p.text).join("");
  if (!tokens || text(tokens) !== text(words)) return words.map((w) => ({ text: w.text, kind: "", changed: w.changed }));
  const pieces = [];
  let t = 0;
  let w = 0;
  let tOffset = 0;
  let wOffset = 0;
  while (t < tokens.length && w < words.length) {
    const token = tokens[t];
    const word = words[w];
    const length = Math.min(token.text.length - tOffset, word.text.length - wOffset);
    pieces.push({ text: token.text.slice(tOffset, tOffset + length), kind: token.kind, changed: word.changed });
    tOffset += length;
    wOffset += length;
    if (tOffset === token.text.length) [t, tOffset] = [t + 1, 0];
    if (wOffset === word.text.length) [w, wOffset] = [w + 1, 0];
  }
  return pieces;
}
