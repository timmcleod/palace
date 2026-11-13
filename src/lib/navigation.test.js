import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick, reactive, ref } from "vue";
import { mountComposable } from "../test/mount.js";
import { describe as describePlace, useNavigation } from "./navigation.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setUp({ active } = {}) {
  const view = {
    selected: ref("workspace:history"),
    selectedCommit: ref(null),
    selectedStash: ref(null),
    fileFilter: ref(null),
    detailMode: ref("changeset"),
    treeFile: ref(null),
    treeReveal: ref(null),
    comparison: ref(null),
  };
  const openFiles = reactive({});
  const { result, unmount } = mountComposable(() =>
    useNavigation({
      overview: ref({ path: "/repo" }),
      view,
      fileShown: () => (view.selected.value === "workspace:files" ? (openFiles["/repo"] ?? null) : null),
      showFile: (file) => (openFiles["/repo"] = file),
      active,
    }),
  );
  return { ...result, view, openFiles, unmount };
}

// Lets the views settle, as go() does, after `ms` spent in the place before.
async function moveTo(change, ms = 5000) {
  vi.advanceTimersByTime(ms);
  change();
  await nextTick();
  await nextTick();
}

describe("useNavigation", () => {
  test("goes back and forward through the places visited, the Files view's file too", async () => {
    const { nav, go, view, openFiles } = setUp();
    await moveTo(() => (view.selectedCommit.value = { id: "a", short_id: "aaa" }));
    await moveTo(() => (view.selected.value = "branch:feature/x"));
    await moveTo(() => {
      view.selected.value = "workspace:files";
      view.selectedCommit.value = null;
      openFiles["/repo"] = "src/main.js";
    });
    await moveTo(() => (view.selected.value = "workspace:history"));
    expect(nav.back.map(describePlace)).toEqual(["History › aaa", "feature/x › aaa", "Files › main.js"]);

    openFiles["/repo"] = null;
    await go("back");
    expect(view.selected.value).toBe("workspace:files");
    expect(openFiles["/repo"]).toBe("src/main.js");
    await go("back");
    expect(view.selected.value).toBe("branch:feature/x");
    await go("forward");
    expect(view.selected.value).toBe("workspace:files");
    expect(nav.forward).toHaveLength(1);
  });

  test("reopens a file closed in the Files view going back, and closes it again going forward", async () => {
    const { go, view, openFiles } = setUp();
    await moveTo(() => (view.selected.value = "workspace:files"));
    await moveTo(() => (openFiles["/repo"] = "src/main.js"));
    await moveTo(() => (openFiles["/repo"] = null));
    await go("back");
    expect(openFiles["/repo"]).toBe("src/main.js");
    await go("forward");
    expect(openFiles["/repo"]).toBeNull();
    // Away from the Files view, its file stays as it was.
    await moveTo(() => (openFiles["/repo"] = "src/app.js"));
    await moveTo(() => (view.selected.value = "workspace:history"));
    await moveTo(() => (view.selected.value = "branch:main"));
    await go("back");
    expect(view.selected.value).toBe("workspace:history");
    expect(openFiles["/repo"]).toBe("src/app.js");
  });

  // Where it starts isn't a place until something changes.
  test("keeps only the last of places replaced quickly in the same view", async () => {
    const { nav, view } = setUp();
    await moveTo(() => (view.selected.value = "branch:main"));
    await moveTo(() => (view.selected.value = "workspace:history"));
    await moveTo(() => (view.selectedCommit.value = { id: "b" }), 100);
    await moveTo(() => (view.selectedCommit.value = { id: "c" }), 100);
    await moveTo(() => (view.selected.value = "workspace:stashes"));
    expect(nav.back.map((p) => p.commit?.id ?? p.selected)).toEqual(["branch:main", "c"]);
  });

  test("going somewhere new drops what was forward", async () => {
    const { nav, go, view } = setUp();
    await moveTo(() => (view.selected.value = "branch:main"));
    await moveTo(() => (view.selected.value = "workspace:stashes"));
    await go("back");
    expect(nav.forward).toHaveLength(1);
    await moveTo(() => (view.selected.value = "workspace:files"));
    expect(nav.forward).toHaveLength(0);
  });

  test("the mouse's back and forward buttons go, until unmounted", async () => {
    const { view, unmount } = setUp();
    await moveTo(() => (view.selected.value = "branch:main"));
    await moveTo(() => (view.selected.value = "workspace:stashes"));
    const back = new MouseEvent("mouseup", { button: 3, cancelable: true });
    window.dispatchEvent(back);
    await nextTick();
    expect(back.defaultPrevented).toBe(true);
    expect(view.selected.value).toBe("branch:main");

    unmount();
    window.dispatchEvent(new MouseEvent("mouseup", { button: 4 }));
    await nextTick();
    expect(view.selected.value).toBe("branch:main");
  });

  test("the mouse's buttons go only in the workspace showing", async () => {
    let showing = false;
    const { view } = setUp({ active: () => showing });
    await moveTo(() => (view.selected.value = "branch:main"));
    await moveTo(() => (view.selected.value = "workspace:stashes"));
    window.dispatchEvent(new MouseEvent("mouseup", { button: 3 }));
    await nextTick();
    expect(view.selected.value).toBe("workspace:stashes");
    showing = true;
    window.dispatchEvent(new MouseEvent("mouseup", { button: 3 }));
    await nextTick();
    expect(view.selected.value).toBe("branch:main");
  });

  test("forget starts over, for another repository", async () => {
    const { nav, forget, view } = setUp();
    await moveTo(() => (view.selected.value = "branch:main"));
    await moveTo(() => (view.selected.value = "workspace:stashes"));
    forget();
    expect([nav.back.length, nav.forward.length]).toEqual([0, 0]);
  });
});

describe("describe", () => {
  test("names the view and what's chosen in it", () => {
    expect(describePlace(null)).toBe("");
    expect(describePlace({ selected: "workspace:stashes", stash: 2 })).toBe("Stashes › stash@{2}");
    expect(describePlace({ selected: "workspace:compare", comparison: { head: "a", base: "b" } })).toBe("a with b");
    expect(describePlace({ selected: "tag:v1.0" })).toBe("v1.0");
  });
});
