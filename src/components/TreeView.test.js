import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import TreeView from "./TreeView.vue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// settings.js sets the window's theme as it loads.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
};

test("shows an image in a commit as the image", async () => {
  const image = "data:image/png;base64,AHBuZw==";
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "tree_entries") return [{ name: "logo.png", path: "logo.png", kind: "file" }];
    if (command === "file_contents") return { size: 4, binary: true, too_large: false, text: null, image };
    return null;
  });
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(TreeView, { path: "/repo", commit: { id: "abc123" }, reveal: "logo.png" }) });
  app.mount(root);
  await settle();
  expect(invoke).toHaveBeenCalledWith("file_contents", { path: "/repo", id: "abc123", file: "logo.png" });
  expect(document.querySelector(".image-view img")?.getAttribute("src")).toBe(image);
  expect(document.body.textContent).not.toContain("Binary file, not shown.");
});
