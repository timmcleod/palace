import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { COMMIT_TYPE, draggedCommit } from "../lib/commitDrag.js";
import Sidebar from "./Sidebar.vue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));

// A repository with main checked out, and a feature branch.
const overview = (more = {}) => ({
  path: "/repo",
  name: "repo",
  head: { branch: "main" },
  changes: 0,
  branches: [
    { name: "feature", is_head: false, ahead: 0, behind: 0, upstream: null, worktree: null, tip: "f1" },
    { name: "main", is_head: true, ahead: 0, behind: 0, upstream: null, worktree: null, tip: "m1" },
  ],
  tags: [],
  remotes: [],
  stashes: [],
  submodules: [],
  worktrees: [],
  operation: null,
  ...more,
});

let app;
afterEach(() => {
  app?.unmount();
  draggedCommit.value = null;
  document.body.innerHTML = "";
});

function sidebar(more) {
  const onCherryPick = vi.fn();
  const shown = ref(overview(more));
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(Sidebar, { overview: shown.value, onCherryPick }) });
  app.mount(root);
  return { onCherryPick };
}

// A drag event of the web view's own: a commit's from the history, unless `types` says
// otherwise, as a file's.
function dragEvent(type, types = ["text/plain", COMMIT_TYPE]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { dropEffect: "none", types } });
  return event;
}
const row = (key) => document.querySelector(`[data-row="${key}"]`);
const commit = { id: "abc1234def", short_id: "abc1234", summary: "Fix the login redirect" };

describe("a commit dragged from another branch's history", () => {
  test("drops on the current branch, said and shown, and is cherry-picked there", async () => {
    const { onCherryPick } = sidebar();
    draggedCommit.value = commit;
    const over = dragEvent("dragover");
    row("branch:main").dispatchEvent(over);
    await nextTick();
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("copy");
    expect(row("branch:main").classList.contains("drop-target")).toBe(true);
    expect(row("branch:main").textContent).toContain("Cherry-pick Fix the login redirect into main");

    row("branch:main").dispatchEvent(dragEvent("drop"));
    await nextTick();
    expect(onCherryPick).toHaveBeenCalledWith(commit);
    expect(row("branch:main").classList.contains("drop-target")).toBe(false);
  });

  test("doesn't drop on another branch", async () => {
    sidebar();
    draggedCommit.value = commit;
    const over = dragEvent("dragover");
    row("branch:feature").dispatchEvent(over);
    await nextTick();
    expect(over.defaultPrevented).toBe(false);
    expect(row("branch:feature").classList.contains("drop-target")).toBe(false);
  });

  test("doesn't drop while a merge or rebase waits on the user", async () => {
    const { onCherryPick } = sidebar({ operation: "rebase" });
    draggedCommit.value = commit;
    const over = dragEvent("dragover");
    row("branch:main").dispatchEvent(over);
    row("branch:main").dispatchEvent(dragEvent("drop"));
    await nextTick();
    expect(over.defaultPrevented).toBe(false);
    expect(onCherryPick).not.toHaveBeenCalled();
  });

  test("lets go of the row once the drag ends elsewhere", async () => {
    sidebar();
    draggedCommit.value = commit;
    row("branch:main").dispatchEvent(dragEvent("dragover"));
    await nextTick();
    draggedCommit.value = null;
    await nextTick();
    expect(row("branch:main").classList.contains("drop-target")).toBe(false);
  });

  test("isn't taken for a file, or another drag, even with a commit's left from a drag whose end went unheard", async () => {
    const { onCherryPick } = sidebar();
    draggedCommit.value = commit;
    const over = dragEvent("dragover", ["Files"]);
    row("branch:main").dispatchEvent(over);
    row("branch:main").dispatchEvent(dragEvent("drop", ["Files"]));
    await nextTick();
    expect(over.defaultPrevented).toBe(false);
    expect(onCherryPick).not.toHaveBeenCalled();
  });

  test("isn't anything to the sidebar when nothing's dragged from the history", async () => {
    sidebar();
    const over = dragEvent("dragover");
    row("branch:main").dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
  });
});
