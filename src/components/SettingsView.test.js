import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import SettingsView from "./SettingsView.vue";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command) => (command === "about_palace" ? { copyright: "Copyright © 2026 Tim McLeod", license: "MIT" } : null)),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.3" }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/me" }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

function mount(props) {
  const root = document.createElement("div");
  document.body.append(root);
  let view;
  const events = { back: 0 };
  app = createApp({ render: () => h(SettingsView, { ref: (r) => (view = r), ...props, onBack: () => events.back++ }) });
  app.mount(root);
  return { view: () => view, events };
}

test("on its own, with no repository, sets only the name and email for every one, and goes back", async () => {
  const { events } = mount({ standalone: true });
  await nextTick();
  expect(invoke).toHaveBeenCalledWith("git_identity", { path: null });
  expect(document.body.textContent).toContain("Your name and email");
  expect(document.querySelectorAll(".identity")).toHaveLength(1);
  [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Back").click();
  expect(events.back).toBe(1);
});

test("in a repository, it can set one for that repository alone, and has no way back", async () => {
  mount({ path: "/code/palace", name: "palace" });
  await nextTick();
  expect(document.body.textContent).toContain("For palace only");
  expect(document.querySelectorAll(".identity")).toHaveLength(2);
  expect([...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Back")).toBe(false);
});

test("scrolls back to the top, its About page", async () => {
  const { view } = mount({ path: "/code/palace", name: "palace" });
  await nextTick();
  const scroller = document.querySelector(".settings");
  scroller.scrollTo = vi.fn();
  view().scrollToTop();
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 0 });
});

test("ends with the copyright and license, as the system's About panel had them", async () => {
  mount({ path: "/code/palace", name: "palace" });
  await nextTick();
  await nextTick();
  const colophon = document.querySelector(".colophon");
  expect(colophon.textContent).toContain("Copyright © 2026 Tim McLeod");
  [...colophon.querySelectorAll("button")].find((b) => b.textContent === "MIT License").click();
  expect(openUrl).toHaveBeenCalledWith("https://github.com/timmcleod/palace/blob/main/LICENSE");
});
