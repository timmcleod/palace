import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import CommitDetails from "./CommitDetails.vue";

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
