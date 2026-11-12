import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import ConflictView from "./ConflictView.vue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/overlays.js", () => ({ askConfirm: vi.fn() }));

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  vi.mocked(invoke).mockReset();
});

const conflicted = "top\n<<<<<<< HEAD\nmain's\n=======\nmine\n>>>>>>> a1b2c3d (Fix login)\nend\n";
const rebase = { operation: "rebase", current: { name: "main", subject: null }, incoming: { name: "a1b2c3d", subject: "Fix login" }, rebasing: "feature", deleted_in: null };

// Shows a conflicted file whose text and sides the backend gives as `text` and `sides`,
// `text` null for one not on disk.
async function mount({ text = conflicted, sides = rebase } = {}) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "conflict_file") {
      if (text == null) throw "Couldn't read gone.txt: No such file or directory";
      return text;
    }
    if (command === "conflict_sides") return sides;
    return null;
  });
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(ConflictView, { path: "/repo", file: { path: "src/gone.txt", conflicted: true } }) });
  app.mount(root);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve));
}

const buttons = () => [...document.querySelectorAll("button")].map((b) => b.textContent.replace(/\s+/g, " ").trim());

test("names each side for what it is, as a rebase turns git's names around", async () => {
  await mount();
  expect(buttons()).toEqual(["Use “main”", "Use “a1b2c3d”", "Open in Editor", "Mark as Resolved", "main", "a1b2c3d", "Both"]);
  // The legend's parts, spaced apart by its layout.
  const legend = [...document.querySelector(".count").children].map((part) => part.textContent.trim()).filter(Boolean);
  expect(legend).toEqual(["main", "being rebased onto", "a1b2c3d", "your commit “Fix login”, from feature"]);
});

test("a file one side deleted asks whether to keep it, keeping the side that changed it", async () => {
  await mount({ text: null, sides: { ...rebase, operation: "merge", incoming: { name: "feature", subject: null }, deleted_in: "incoming" } });
  expect(document.querySelector(".intro").textContent).toBe("“feature” (being merged in) deleted this file, and “main” (the branch checked out) changed it.");
  expect(buttons()).toEqual(["Keep File", "Delete File"]);
  // Not there to read, as it may not be: that's no error.
  expect(document.querySelector(".error")).toBeNull();

  document.querySelector("button").click();
  await nextTick();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("resolve_conflict", { path: "/repo", file: "src/gone.txt", side: "current" });
});

test("a file one side deleted, still on disk, can be edited and kept as it is", async () => {
  await mount({ text: "main's version\n", sides: { ...rebase, operation: "merge", incoming: { name: "feature", subject: null }, deleted_in: "incoming" } });
  expect(buttons()).toEqual(["Keep File", "Delete File", "Open in Editor", "Mark as Resolved"]);
});

test("Delete File deletes it, after asking", async () => {
  const { askConfirm } = await import("../lib/overlays.js");
  vi.mocked(askConfirm).mockResolvedValue(true);
  await mount({ text: null, sides: { ...rebase, deleted_in: "both" } });
  expect(buttons()).toEqual(["Delete File"]);
  document.querySelector("button").click();
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve));
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("resolve_conflict", { path: "/repo", file: "src/gone.txt", side: "deleted" });
});
