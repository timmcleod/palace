import { afterEach, expect, test } from "vitest";
import { nextTick } from "vue";
import { namedIconUrl } from "./fileIcons.js";

afterEach(() => delete document.documentElement.dataset.theme);

// The theme is watched as the page's data-theme changes.
async function theme(name) {
  document.documentElement.dataset.theme = name;
  await new Promise((resolve) => setTimeout(resolve));
  await nextTick();
}

test("an icon by its own name, in the light theme's version only where it has one", async () => {
  await theme("dark");
  expect(namedIconUrl("copilot", true)).toBe("/file-icons/copilot.svg");
  await theme("light");
  expect(namedIconUrl("copilot", true)).toBe("/file-icons/copilot_light.svg");
  expect(namedIconUrl("claude")).toBe("/file-icons/claude.svg");
});
