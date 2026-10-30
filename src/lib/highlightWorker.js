import hljs from "highlight.js/lib/core";

// Highlights code for lib/highlight.js, away from the page so that big files don't hold
// it up. Each request is { id, language } with either `blocks` (arrays of lines) or
// `text`, and is answered with { id, result }: see highlightBlocks and highlightText.

// Languages that highlight parts of themselves with others, such as <script> in HTML.
const NEEDS = { xml: ["javascript", "css"], "php-template": ["xml", "php"], markdown: ["xml"] };

// Each a chunk of its own, so only the languages in use are ever loaded.
const LOADERS = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  erlang: () => import("highlight.js/lib/languages/erlang"),
  fsharp: () => import("highlight.js/lib/languages/fsharp"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  groovy: () => import("highlight.js/lib/languages/groovy"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  julia: () => import("highlight.js/lib/languages/julia"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  "php-template": () => import("highlight.js/lib/languages/php-template"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  twig: () => import("highlight.js/lib/languages/twig"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const loading = new Map();

function load(language) {
  if (hljs.getLanguage(language)) return Promise.resolve(true);
  if (!loading.has(language)) {
    loading.set(
      language,
      Promise.all([LOADERS[language]?.(), ...(NEEDS[language] ?? []).map(load)])
        .then(([module]) => {
          if (module) hljs.registerLanguage(language, module.default);
          return !!module;
        })
        .catch(() => false),
    );
  }
  return loading.get(language);
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (e) => ENTITIES[e]);

// Splits highlight.js's HTML into lines of { text, kind }. Spans can run over several
// lines (a comment, a string); each piece takes the innermost one's class.
function splitLines(html, count) {
  const lines = [[]];
  const stack = [];
  for (const [, open, close, text] of html.matchAll(/<span class="([^"]*)">|(<\/span>)|([^<]+)/g)) {
    if (open != null) stack.push(open.startsWith("language-") ? "" : open);
    else if (close) stack.pop();
    else {
      const kind = stack.findLast((k) => k) ?? "";
      decode(text)
        .split("\n")
        .forEach((piece, i) => {
          if (i) lines.push([]);
          if (piece) lines.at(-1).push({ text: piece, kind });
        });
    }
  }
  while (lines.length < count) lines.push([]);
  return lines;
}

self.onmessage = async ({ data: { id, language, blocks, text } }) => {
  let result = null;
  if (await load(language)) {
    const highlight = (code) => hljs.highlight(code, { language, ignoreIllegals: true }).value;
    result = blocks ? blocks.map((lines) => (lines.length ? splitLines(highlight(lines.join("\n")), lines.length) : [])) : highlight(text);
  }
  self.postMessage({ id, result });
};
