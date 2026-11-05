import { beforeEach, describe, expect, test, vi } from "vitest";
import { reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { askConfirm } from "./overlays.js";
import { CANCELED } from "./confirm.js";
import { useUndo } from "./undo.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./overlays.js", () => ({ askConfirm: vi.fn() }));

// Each snapshot differs from the last, as if every operation changed something.
let snapshots;
beforeEach(() => {
  snapshots = 0;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "take_snapshot") return { head_branch: "main", files: [], n: snapshots++ };
    throw new Error(`unexpected ${command}`);
  });
  vi.mocked(askConfirm).mockReset();
});

function setUp() {
  const draft = reactive({ subject: "", body: "" });
  const runs = [];
  const offers = [];
  const settle = vi.fn(async () => {});
  const undo = useUndo({
    overview: ref({ path: "/repo" }),
    draft,
    busy: () => false,
    settle,
    run: async (titles, command, args) => {
      runs.push({ title: titles[1], command, args });
      return null;
    },
    offer: (label) => offers.push(label),
  });
  return { undo, draft, runs, offers, settle };
}

describe("stepFor", () => {
  test("names the undoable commands, and nothing else", () => {
    const { undo } = setUp();
    expect(undo.stepFor("merge", {})).toEqual({ label: "Merge", mode: "keep", cover: undefined, resumed: null });
    expect(undo.stepFor("fetch", {})).toBeNull();
    expect(undo.stepFor("fetch", {}, "Custom").label).toBe("Custom");
  });

  test("takes what it covers and how it restores from the arguments", () => {
    const { undo } = setUp();
    expect(undo.stepFor("stash_apply", { pop: true, index: 2 })).toMatchObject({ label: "Pop Stash", cover: { stash: 2 } });
    expect(undo.stepFor("stash_apply", { pop: false, index: 2 }).label).toBe("Apply Stash");
    expect(undo.stepFor("stash_save", { files: ["a"] }).cover).toEqual({ files: ["a"] });
    expect(undo.stepFor("reset", { keepChanges: true })).toMatchObject({ mode: "mixed", cover: { changed: true } });
    expect(undo.stepFor("reset", { keepChanges: false })).toMatchObject({ mode: "keep", cover: undefined });
  });
});

describe("undoable", () => {
  test("records a step, after letting a background fetch finish", async () => {
    const { undo, settle } = setUp();
    expect(await undo.undoable({ label: "Merge", mode: "keep" }, async () => "merged")).toBe("merged");
    expect(settle).toHaveBeenCalledOnce();
    expect(undo.newest().label).toBe("Merge");
  });

  test("records nothing when nothing changed", async () => {
    vi.mocked(invoke).mockImplementation(async () => ({ head_branch: "main", files: [] }));
    const { undo } = setUp();
    await undo.undoable({ label: "Merge", mode: "keep" }, async () => "");
    expect(undo.newest()).toBeUndefined();
  });

  test("asks before going ahead without a snapshot of files it would change", async () => {
    vi.mocked(invoke).mockRejectedValue("disk full");
    vi.mocked(askConfirm).mockResolvedValue(false);
    const { undo } = setUp();
    const work = vi.fn();
    await expect(undo.undoable({ label: "Stash", mode: "keep", cover: { changed: true } }, work)).rejects.toBe(CANCELED);
    expect(askConfirm.mock.calls[0][0].message).toContain("disk full");
    expect(work).not.toHaveBeenCalled();
  });
});

describe("undo and redo", () => {
  test("restore the snapshots, and bring a commit's message back and away again", async () => {
    const { undo, draft, runs, offers } = setUp();
    await undo.undoable({ label: "Commit", mode: "keep", message: "Subject\n\nBody" }, async () => "");
    await undo.undo();
    expect(runs.at(-1)).toMatchObject({ title: "Undid “Commit”", command: "restore_snapshot" });
    expect(runs.at(-1).args).toMatchObject({ from: { n: 1 }, to: { n: 0 }, mode: "keep" });
    expect([draft.subject, draft.body]).toEqual(["Subject", "Body"]);
    expect(undo.newest()).toBeUndefined();
    expect(offers).toEqual(["Redo"]);

    await undo.redo();
    expect(runs.at(-1).args).toMatchObject({ from: { n: 0 }, to: { n: 1 } });
    expect([draft.subject, draft.body]).toEqual(["", ""]);
    expect(undo.newest().label).toBe("Commit");
    expect(offers).toEqual(["Redo", "Undo"]);
  });

  test("drop a step that something else has since moved, and keep one that failed otherwise", async () => {
    let error;
    const undo = useUndo({
      overview: ref({ path: "/repo" }),
      draft: reactive({}),
      busy: () => false,
      settle: async () => {},
      run: async () => error,
      offer: () => {},
    });
    await undo.undoable({ label: "Merge", mode: "keep" }, async () => "");
    error = "The network is down";
    await undo.undo();
    expect(undo.newest().label).toBe("Merge");
    error = "main has moved since";
    await undo.undo();
    expect(undo.newest()).toBeUndefined();
  });
});

describe("a step that stopped for conflicts", () => {
  test("is finished as one step by continuing, and forgotten by aborting", async () => {
    const { undo } = setUp();
    await expect(undo.undoable(undo.stepFor("merge", {}), async () => Promise.reject("CONFLICT: stopped"))).rejects.toBe(
      "CONFLICT: stopped",
    );
    const resumed = undo.stepFor("control_operation", { action: "continue" });
    expect(resumed).toMatchObject({ label: "Merge", resumed: { path: "/repo" } });
    expect(undo.stepFor("control_operation", { action: "abort" })).toBeNull();
    expect(undo.stepFor("control_operation", { action: "continue" })).toBeNull();
  });
});

test("each repository keeps its own steps", async () => {
  const { undo } = setUp();
  await undo.undoable({ label: "Commit", mode: "keep" }, async () => "");
  undo.switchRepository("/repo", "/other");
  expect(undo.newest()).toBeUndefined();
  undo.switchRepository("/other", "/repo");
  expect(undo.newest().label).toBe("Commit");
});
