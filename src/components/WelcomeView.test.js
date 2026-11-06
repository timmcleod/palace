import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { FILTER_RECENTS } from "../lib/storage.js";
import WelcomeView from "./WelcomeView.vue";

// storage.js, for FILTER_RECENTS, listens for Palace's other windows as it loads.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

// Mounts the screen with `props`, and records what it emits.
function show(props) {
  const emitted = [];
  const on = (name) => (...args) => emitted.push([name, ...args]);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    render: () =>
      h(WelcomeView, {
        recents: [],
        ...props,
        onOpenRepository: on("open-repository"),
        onClone: on("clone"),
        onOpen: on("open"),
        onRemove: on("remove"),
      }),
  });
  app.mount(root);
  return { root, emitted };
}

const repos = (n) => Array.from({ length: n }, (_, i) => ({ name: `repo-${i}`, path: `/work/repo-${i}` }));
const rowNames = (root) => [...root.querySelectorAll(".recent .recent-text > div:first-child")].map((d) => d.textContent);

describe("WelcomeView", () => {
  test("shows only a spinner while the last repository reopens", () => {
    const { root } = show({ starting: true, recents: repos(2) });
    expect(root.querySelector(".starting")).not.toBeNull();
    expect(root.querySelector(".welcome-card")).toBeNull();
  });

  test("offers to open or clone a repository, and waits while one opens", () => {
    const { root, emitted } = show({});
    const [open, clone] = root.querySelectorAll(".welcome-buttons button");
    open.click();
    clone.click();
    expect(emitted).toEqual([["open-repository"], ["clone"]]);

    app.unmount();
    const opening = show({ loading: true });
    const [openingButton, cloneButton] = opening.root.querySelectorAll(".welcome-buttons button");
    expect(openingButton.textContent.trim()).toBe("Opening…");
    expect([openingButton.disabled, cloneButton.disabled]).toEqual([true, true]);
  });

  test("says why the last repository couldn't be opened", () => {
    expect(show({}).root.querySelector(".error")).toBeNull();
    app.unmount();
    expect(show({ error: "Couldn't open /gone: not found" }).root.querySelector(".error").textContent).toContain("/gone");
  });

  test("opens a recent repository, or takes it off the list", () => {
    const { root, emitted } = show({ recents: repos(2) });
    expect(root.querySelector(".recent-filter")).toBeNull();
    const rows = root.querySelectorAll(".recent");
    rows[1].click();
    rows[0].querySelector("button").click();
    expect(emitted).toEqual([
      ["open", "/work/repo-1"],
      ["remove", "/work/repo-0"],
    ]);
  });

  test("with more than FILTER_RECENTS, finds them by every word typed, and Enter opens the first", async () => {
    const recents = [...repos(FILTER_RECENTS), { name: "palace", path: "/home/me/code/palace" }];
    const { root, emitted } = show({ recents });
    const filter = root.querySelector(".recent-filter");
    expect(filter).not.toBeNull();

    filter.value = "code pal";
    filter.dispatchEvent(new Event("input"));
    await nextTick();
    expect(rowNames(root)).toEqual(["palace"]);
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(emitted).toEqual([["open", "/home/me/code/palace"]]);

    filter.value = "nothing like it";
    filter.dispatchEvent(new Event("input"));
    await nextTick();
    expect(rowNames(root)).toEqual([]);
    expect(root.querySelector(".recent-none")).not.toBeNull();
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(emitted).toHaveLength(1);
  });
});
