import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import ToolbarSearch from "./ToolbarSearch.vue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The colorful icons, loaded, as they are in the app: each file's needs its name.
vi.mock("../lib/fileIcons.js", () => ({ fileIconUrl: (name) => `/icons/${name.slice(name.lastIndexOf("/") + 1)}.svg` }));
// settings.js sets the window's theme as it loads.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await nextTick();
};

describe("the toolbar search", () => {
  test("lists matching files and commits once something's typed after it's focused", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "tracked_files" ? ["src/App.vue", "README.md"] : command === "search_commits" ? { commits: [], total: 0 } : null,
    );
    const root = document.createElement("div");
    document.body.append(root);
    let search;
    app = createApp({ render: () => h(ToolbarSearch, { ref: (r) => (search = r), path: "/repo", rev: "HEAD", refreshKey: 0, untracked: false }) });
    app.mount(root);
    search.focus();
    await settle();
    const input = document.querySelector(".toolbar-search input");
    input.value = "vue";
    input.dispatchEvent(new Event("input"));
    await settle();
    expect(document.querySelector(".results")?.textContent).toContain("App.vue");
    expect(document.querySelector(".results img")?.getAttribute("src")).toBe("/icons/App.vue.svg");
  });
});
