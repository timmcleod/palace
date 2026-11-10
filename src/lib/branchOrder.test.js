import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
// storage.js hears of other windows' saves through this event, which a test sends.
const heard = vi.hoisted(() => ({ storeChanged: null }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event, fn) => {
    if (event === "store-changed") heard.storeChanged = fn;
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));

const { dividerRows, moveKey } = await import("./branchOrder.js");
const { readJson } = await import("./storage.js");

const savedElsewhere = (values) => heard.storeChanged({ payload: { window: "window-2", values } });

// Each test starts with nothing arranged, as another window saving that would leave it.
beforeEach(() => savedElsewhere({ "palace.branchOrder": {} }));

describe("the branches' arrangement", () => {
  test("takes in what another window arranged, and doesn't save over it", () => {
    const arranged = { "/code/blog": { order: ["branch-divider:x", "branch:main"], labels: { "branch-divider:x": "Theirs" } } };
    savedElsewhere({ "palace.branchOrder": arranged });
    expect(dividerRows("/code/blog")).toEqual([{ key: "branch-divider:x", divider: true, label: "Theirs" }]);

    moveKey("/code/other", "branch:b", "branch:a", false, ["branch:a", "branch:b"]);
    expect(readJson("palace.branchOrder", {})["/code/blog"]).toEqual(arranged["/code/blog"]);
  });
});
