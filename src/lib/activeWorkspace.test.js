import { afterEach, expect, test } from "vitest";
import { createApp, h, ref } from "vue";
import { inActiveWorkspace, provideActive } from "./activeWorkspace.js";

let app;
afterEach(() => app?.unmount());

// A component inside a workspace whose `active` is given, reading it as it changes.
function within(active) {
  let read;
  const Inside = { setup: () => ((read = inActiveWorkspace()), () => h("div")) };
  app = createApp({
    setup() {
      if (active) provideActive(() => active.value);
      return () => h(Inside);
    },
  });
  app.mount(document.createElement("div"));
  return () => read();
}

test("a component reads whether its workspace is the one showing, as it changes", () => {
  const active = ref(true);
  const read = within(active);
  expect(read()).toBe(true);
  active.value = false;
  expect(read()).toBe(false);
});

test("outside a workspace, it's showing", () => {
  expect(within(null)()).toBe(true);
});
