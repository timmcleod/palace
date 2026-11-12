import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp, h, nextTick, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import CommitDetails from "./CommitDetails.vue";
import { settings } from "../lib/settings.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// Avatars listen for pictures fetched in the background.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
// settings.js sets the window's theme as it loads.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

// The byline's parts, as the reader sees them, spaced apart by its layout.
const bylineParts = () => [...document.querySelector(".byline").children].map((part) => part.textContent.trim()).filter(Boolean);

const jonathan = { name: "jonathanbriehl", email: "jonathan@briehl.com", time: 1_793_314_199 };
const details = (more = {}) => ({
  id: "95d90e064c1b2d11223a5385f05d2e4dd3570f78",
  tree_id: "4aa2534bbd1112f019567854c986a5c83a515226",
  parents: ["4cbad69fd8a7f31f30d33d955478e3da502a4901"],
  author: jonathan,
  committer: jonathan,
  message: "Update atlas-pkg to 0.8.2\n\nReports whether nginx needs a restart, see #42.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n",
  files: [],
  ...more,
});

async function mount(result, props = {}) {
  vi.mocked(invoke).mockResolvedValue(result);
  const root = document.createElement("div");
  document.body.append(root);
  const shown = [];
  app = createApp({
    render: () => h(CommitDetails, { path: "/repo", commit: { id: result.id, refs: [{ kind: "local", name: "main" }] }, issueLinks: true, onShowIssue: (n) => shown.push(n), ...props }),
  });
  app.mount(root);
  for (let i = 0; i < 4; i++) await nextTick();
  return shown;
}

test("leads with the subject, then who committed it and when, with whom, and where it is", async () => {
  await mount(details());
  expect(document.querySelector(".subject").textContent.trim()).toBe("Update atlas-pkg to 0.8.2");
  const parts = bylineParts();
  expect(parts.slice(1, 3)).toEqual(["jonathanbriehl", expect.stringMatching(/^committed on /)]);
  expect(parts.slice(-2)).toEqual(["· with", "Claude Opus 5.5"]);
  // Claude, by its own icon rather than an avatar.
  expect(document.querySelector(".co-author .agent-icon").style.getPropertyValue("--shape")).toBe("url(/file-icons/claude.svg)");
  expect(document.querySelector(".refs").textContent).toContain("main");
});

test("shows the rest of the message, its issues linked, without the co-author lines", async () => {
  const shown = await mount(details());
  const body = document.querySelector(".message-body");
  expect(body.textContent).toContain("Reports whether nginx needs a restart");
  expect(body.textContent).not.toContain("Co-Authored-By");
  body.querySelector(".issue-ref").click();
  expect(shown).toEqual([42]);
});

test("offers each hash, short, to copy in full", async () => {
  await mount(details());
  const hashes = [...document.querySelectorAll(".hash")].map((h) => h.textContent.replace(/\s+/g, " ").trim());
  expect(hashes).toEqual(["commit 95d90e0", "parent 4cbad69", "tree 4aa2534"]);
});

test("says who committed it when that's someone else", async () => {
  await mount(details({ committer: { name: "Tim McLeod", email: "tim@example.com", time: jonathan.time + 3600 } }));
  const parts = bylineParts();
  expect(parts.slice(1, 3)).toEqual(["jonathanbriehl", expect.stringMatching(/^authored on /)]);
  expect(parts.slice(4, 7)).toEqual(["committed by", "Tim McLeod", expect.stringMatching(/^on /)]);
});

test("says when its author committed it later, as a rebase does", async () => {
  await mount(details({ committer: { ...jonathan, time: jonathan.time + 6 * 24 * 3600 } }));
  const parts = bylineParts();
  expect(parts.slice(1, 4)).toEqual(["jonathanbriehl", expect.stringMatching(/^committed on /), expect.stringMatching(/^\(authored /)]);
});

test("numbers a merge's parents, and says when there are none", async () => {
  await mount(details({ parents: ["aaaaaaa111", "bbbbbbb222"] }));
  const hashes = () => [...document.querySelectorAll(".hash")].map((h) => h.textContent.replace(/\s+/g, " ").trim());
  expect(hashes()).toEqual(["commit 95d90e0", "parent 1 aaaaaaa", "parent 2 bbbbbbb", "tree 4aa2534"]);
  app.unmount();
  document.body.innerHTML = "";
  await mount(details({ parents: [] }));
  expect(hashes()).toEqual(["commit 95d90e0", "root commit", "tree 4aa2534"]);
});

test("links issues in the subject too, and none where issues don't show", async () => {
  const shown = await mount(details({ message: "Fix #7, the redirect" }));
  document.querySelector(".subject .issue-ref").click();
  expect(shown).toEqual([7]);
  app.unmount();
  document.body.innerHTML = "";
  await mount(details({ message: "Fix #7, the redirect" }), { issueLinks: false });
  expect(document.querySelector(".subject").textContent).toBe("Fix #7, the redirect");
  expect(document.querySelector(".issue-ref")).toBeNull();
});

test("copies a name with its email, as git writes them", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await mount(details());
  document.querySelector(".byline .person").click();
  await nextTick();
  expect(writeText).toHaveBeenCalledWith("jonathanbriehl <jonathan@briehl.com>");
});

test("hands off to a bar pinned at the top, in step, as the heading scrolls away", async () => {
  await mount(details());
  const heading = document.querySelector(".heading");
  Object.defineProperty(heading, "offsetTop", { value: 0 });
  Object.defineProperty(heading, "offsetHeight", { value: 140 });
  const scroller = document.querySelector(".details");
  const scrollTo = async (top) => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event("scroll"));
    await nextTick();
  };
  await scrollTo(40);
  expect(document.querySelector(".pinned-bar")).toBeNull();
  // Halfway through the heading's last 60px.
  await scrollTo(110);
  const bar = document.querySelector(".pinned-bar");
  expect(bar.style.opacity).toBe("0.5");
  expect(bar.textContent).toContain("Update atlas-pkg to 0.8.2");
  expect(bar.textContent).toContain("95d90e0");
  await scrollTo(400);
  expect(document.querySelector(".pinned-bar").style.opacity).toBe("1");
  await scrollTo(0);
  expect(document.querySelector(".pinned-bar")).toBeNull();
});

// A stash's commit is made afresh each time the repository refreshes, as when the
// window comes forward; showing it again from the start made its details flicker.
test("keeps showing a commit handed over again as a new object with the same id", async () => {
  const result = details();
  vi.mocked(invoke).mockResolvedValue(result);
  const commit = shallowRef({ id: result.id, short_id: "95d90e0", refs: [] });
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(CommitDetails, { path: "/repo", commit: commit.value, stash: true }) });
  app.mount(root);
  for (let i = 0; i < 4; i++) await nextTick();
  const loads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "commit_details").length;
  expect(loads()).toBe(1);
  const shown = document.querySelector(".heading");

  commit.value = { ...commit.value };
  for (let i = 0; i < 4; i++) await nextTick();
  expect(loads()).toBe(1);
  expect(document.querySelector(".heading")).toBe(shown);
});

// A file's diff, opened, loads as it comes into view, which here is at once.
class SeenAtOnce {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect() {}
}

const twoFiles = () => details({ files: ["a.js", "b.js"].map((path) => ({ path, old_path: null, status: "modified", binary: false, additions: 1, deletions: 0 })) });
const aDiff = { binary: false, total_lines: 1, truncated: false, hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "+", old: null, new: 1, text: "x" }] }], images: null };
// Lets what's awaited, and Vue's updates after it, finish.
const flush = () => new Promise((resolve) => setTimeout(resolve));

// Mounts a commit of two files, whose diffs come only when `answers` answers them.
async function mountSliding() {
  vi.stubGlobal("IntersectionObserver", SeenAtOnce);
  // Highlighting runs in a Web Worker, which the tests don't have; the diff shows plain.
  settings.syntaxHighlighting = false;
  await mount(twoFiles());
  const answers = [];
  vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
  return answers;
}

describe("a file's diff", () => {
  const highlighting = settings.syntaxHighlighting;
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  afterEach(() => {
    // Gone first, so highlighting turned back on doesn't reach for a Web Worker.
    app?.unmount();
    app = null;
    settings.syntaxHighlighting = highlighting;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete HTMLElement.prototype.animate;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
  });

  test("clicked open, waits for the diff, rather than showing Loading… first; Expand All doesn't wait", async () => {
    const answers = await mountSliding();
    document.querySelector(".file-header").click();
    await nextTick();
    expect(document.querySelector(".file-diff").classList).toContain("waiting");
    answers[0](aDiff);
    await flush();
    expect(document.querySelector(".file-diff").classList).not.toContain("waiting");

    // Both open, b.js not waiting, its Loading… shown as it is.
    document.querySelector(".changes-bar .link-button").click();
    await nextTick();
    const [, b] = document.querySelectorAll(".file-diff");
    expect(b.classList).not.toContain("waiting");
    expect(b.textContent).toContain("Loading…");
  });

  test("clicked open and closed again with Collapse All before it came, opens at once with Expand All", async () => {
    await mountSliding();
    document.querySelector(".file-header").click();
    await nextTick();
    // Expand All, the other's not open yet; then Collapse All, and Expand All again.
    const toggleAll = async () => {
      document.querySelector(".changes-bar .link-button").click();
      await flush();
    };
    await toggleAll();
    await toggleAll();
    await toggleAll();
    const [a] = document.querySelectorAll(".file-diff");
    expect(a.classList).not.toContain("waiting");
  });

  test("taking a while, shows Loading… after a moment rather than seeming to do nothing", async () => {
    const answers = await mountSliding();
    vi.useFakeTimers();
    document.querySelector(".file-header").click();
    await nextTick();
    vi.advanceTimersByTime(400);
    await nextTick();
    const diff = document.querySelector(".file-diff");
    expect(diff.classList).not.toContain("waiting");
    expect(diff.textContent).toContain("Loading…");
    expect(answers).toHaveLength(1);
  });

  test("clicked shut, slides closed; Collapse All closes at once", async () => {
    const answers = await mountSliding();
    const slides = [];
    // The tests' page lays nothing out: each element is given a height, to slide from.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 120 });
    HTMLElement.prototype.animate = function (frames) {
      slides.push(frames.at(-1).height);
      return { finished: Promise.resolve(), cancel() {} };
    };
    document.querySelector(".file-header").click();
    answers.forEach((answer) => answer(aDiff));
    await flush();
    document.querySelector(".file-header").click();
    await flush();
    expect(slides.at(-1)).toBe("0px");
    expect(document.querySelectorAll(".file-diff")).toHaveLength(0);

    const before = slides.length;
    document.querySelector(".changes-bar .link-button").click();
    await flush();
    answers.forEach((answer) => answer(aDiff));
    await flush();
    document.querySelector(".changes-bar .link-button").click();
    await flush();
    expect(slides).toHaveLength(before);
    expect(document.querySelectorAll(".file-diff")).toHaveLength(0);
  });
});
