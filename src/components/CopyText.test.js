import { afterEach, expect, test, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import CopyText from "./CopyText.vue";

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

async function copyAt(right) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });
  // Where the note would end, were it on the right.
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ right });
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(CopyText, { value: "Claude Opus 5.5 <noreply@anthropic.com>" }, () => "Claude Opus 5.5") });
  app.mount(root);
  root.querySelector(".copy-text").click();
  for (let i = 0; i < 4; i++) await nextTick();
  rect.mockRestore();
  return root.querySelector(".copied-note");
}

test("says it's copied on its right, where there's room", async () => {
  const note = await copyAt(200);
  expect(note.textContent).toContain("Copied");
  expect(note.classList.contains("left")).toBe(false);
});

test("says it on its left at the window's edge, rather than cut off", async () => {
  expect((await copyAt(window.innerWidth + 30)).classList.contains("left")).toBe(true);
});
