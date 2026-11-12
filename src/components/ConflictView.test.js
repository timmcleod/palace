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

const conflicted =
  "top\n<<<<<<< HEAD\nmain's\n=======\nmine\n>>>>>>> a1b2c3d (Fix login)\nend\n";
const rebase = {
  operation: "rebase",
  current: { name: "main", subject: null },
  incoming: { name: "a1b2c3d", subject: "Fix login" },
  rebasing: "feature",
  deleted_in: null,
};

// Shows a conflicted file whose text and sides the backend gives as `text` and `sides`,
// `text` null for one not on disk. Returns the file's state on disk, to change, and the
// paths it says it resolved.
async function mount({ text = conflicted, sides = rebase, undoable } = {}) {
  const disk = { text };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "conflict_file") {
      if (disk.text == null)
        throw "Couldn't read gone.txt: No such file or directory";
      return disk.text;
    }
    if (command === "conflict_sides") return sides;
    return null;
  });
  const resolved = [];
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    render: () =>
      h(ConflictView, {
        path: "/repo",
        file: { path: "src/gone.txt", conflicted: true },
        undoable,
        onResolved: (path) => resolved.push(path),
      }),
  });
  app.mount(root);
  await settle();
  return { disk, resolved };
}

const settle = async () => {
  for (let i = 0; i < 4; i++)
    await new Promise((resolve) => setTimeout(resolve));
};
const click = (label) =>
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent.trim() === label)
    .click();

const buttons = () =>
  [...document.querySelectorAll("button")].map((b) =>
    b.textContent.replace(/\s+/g, " ").trim(),
  );

test("names each side for what it is, as a rebase turns git's names around", async () => {
  await mount();
  expect(buttons()).toEqual([
    "Use “main”",
    "Use “a1b2c3d”",
    "Edit",
    "Open in Editor",
    "Mark as Resolved",
    "main",
    "a1b2c3d",
    "Both",
  ]);
  // The legend's parts, spaced apart by its layout.
  const legend = [...document.querySelector(".count").children]
    .map((part) => part.textContent.trim())
    .filter(Boolean);
  expect(legend).toEqual([
    "main",
    "being rebased onto",
    "a1b2c3d",
    "your commit “Fix login”, from feature",
  ]);
});

test("a file one side deleted asks whether to keep it, keeping the side that changed it", async () => {
  await mount({
    text: null,
    sides: {
      ...rebase,
      operation: "merge",
      incoming: { name: "feature", subject: null },
      deleted_in: "incoming",
    },
  });
  expect(document.querySelector(".intro").textContent).toBe(
    "“feature” (being merged in) deleted this file, and “main” (the branch checked out) changed it.",
  );
  expect(buttons()).toEqual(["Keep File", "Delete File"]);
  // Not there to read, as it may not be: that's no error.
  expect(document.querySelector(".error")).toBeNull();

  document.querySelector("button").click();
  await nextTick();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("resolve_conflict", {
    path: "/repo",
    file: "src/gone.txt",
    side: "current",
  });
});

test("a file one side deleted, still on disk, can be edited and kept as it is", async () => {
  await mount({
    text: "main's version\n",
    sides: {
      ...rebase,
      operation: "merge",
      incoming: { name: "feature", subject: null },
      deleted_in: "incoming",
    },
  });
  expect(buttons()).toEqual([
    "Keep File",
    "Delete File",
    "Edit",
    "Open in Editor",
    "Mark as Resolved",
  ]);
});

test("Delete File deletes it, after asking", async () => {
  const { askConfirm } = await import("../lib/overlays.js");
  vi.mocked(askConfirm).mockResolvedValue(true);
  await mount({ text: null, sides: { ...rebase, deleted_in: "both" } });
  expect(buttons()).toEqual(["Delete File"]);
  document.querySelector("button").click();
  await settle();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("resolve_conflict", {
    path: "/repo",
    file: "src/gone.txt",
    side: "deleted",
  });
});

test("Mark as Resolved asks first while conflicts are left in it, as read again", async () => {
  const { askConfirm } = await import("../lib/overlays.js");
  vi.mocked(askConfirm).mockReset().mockResolvedValue(false);
  const { disk, resolved } = await mount({ text: "resolved by hand\n" });
  // Edited elsewhere since it was shown, a conflict's back.
  disk.text = conflicted;
  click("Mark as Resolved");
  await settle();
  expect(vi.mocked(askConfirm).mock.calls[0][0].message).toContain(
    "It still has a conflict in it",
  );
  expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
    "resolve_conflict",
    expect.anything(),
  );
  expect(resolved).toEqual([]);
});

test("Mark as Resolved with nothing left in it resolves it at once, and says so", async () => {
  const { askConfirm } = await import("../lib/overlays.js");
  vi.mocked(askConfirm).mockReset();
  const { resolved } = await mount({ text: "resolved by hand\n" });
  click("Mark as Resolved");
  await settle();
  expect(askConfirm).not.toHaveBeenCalled();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("resolve_conflict", {
    path: "/repo",
    file: "src/gone.txt",
    side: "resolved",
  });
  expect(resolved).toEqual(["src/gone.txt"]);
});

test("resolving can be undone, the file covered, and choosing one conflict's side too", async () => {
  const steps = [];
  const undoable = vi.fn((step, work) => (steps.push(step), work()));
  const { disk } = await mount({ undoable });
  click("Both");
  await settle();
  // As choosing both sides of its only conflict leaves it.
  disk.text = "main's\nmine\n";
  click("Mark as Resolved");
  await settle();
  expect(steps.map((s) => [s.label, s.cover])).toEqual([
    ["Resolve Conflict", { files: ["src/gone.txt"] }],
    ["Mark as Resolved", { files: ["src/gone.txt"] }],
  ]);
});

test("Mark as Resolved asks first with edits in Palace's editor not saved", async () => {
  const { askConfirm } = await import("../lib/overlays.js");
  const { markUnsaved } = await import("../lib/editing.js");
  vi.mocked(askConfirm).mockReset().mockResolvedValue(false);
  await mount({ text: "resolved by hand\n" });
  markUnsaved("/repo", "src/gone.txt", true);
  click("Mark as Resolved");
  await settle();
  markUnsaved("/repo", "src/gone.txt", false);
  expect(vi.mocked(askConfirm).mock.calls[0][0].message).toContain(
    "edits in Palace's editor that aren't saved",
  );
});

test("keeping a file one side deleted is undone as Keep File; going without undo, declined, says nothing", async () => {
  const { CANCELED } = await import("../lib/errors.js");
  const steps = [];
  const undoable = vi.fn(async (step) => {
    steps.push(step.label);
    throw CANCELED;
  });
  const { resolved } = await mount({
    text: "main's version\n",
    sides: {
      ...rebase,
      operation: "merge",
      incoming: { name: "feature", subject: null },
      deleted_in: "incoming",
    },
    undoable,
  });
  click("Keep File");
  await settle();
  expect(steps).toEqual(["Keep File"]);
  expect(document.querySelector(".error")).toBeNull();
  expect(resolved).toEqual([]);
});
