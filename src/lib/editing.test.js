import { beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { buffers, forgetEditsIn, keyFor, markUnsaved, unsavedFiles } = await import("./editing.js");

beforeEach(() => vi.mocked(invoke).mockClear());

test("Palace is told the files with edits not saved, each with the repository it's in", () => {
  markUnsaved("/code/palace", "src/App.vue", true);
  expect(vi.mocked(invoke).mock.calls.at(-1)).toEqual(["set_unsaved_edits", { files: [{ path: "/code/palace", described: "“App.vue” in palace" }] }]);
  markUnsaved("/code/palace", "src/App.vue", false);
});

test("a repository's tab closing lets go of its edits not saved, and no other's", () => {
  markUnsaved("/code/a", "one.txt", true);
  markUnsaved("/code/a", "src/two.txt", true);
  markUnsaved("/code/b", "three.txt", true);
  buffers.set(keyFor("/code/a", "one.txt"), "edited");
  forgetEditsIn("/code/a");
  expect(unsavedFiles()).toEqual([{ path: "/code/b", file: "three.txt" }]);
  expect(buffers.has(keyFor("/code/a", "one.txt"))).toBe(false);
  forgetEditsIn("/code/b");
});
