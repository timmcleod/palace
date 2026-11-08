import { afterEach, expect, test } from "vitest";
import { createApp, h } from "vue";
import AgentIcon from "./AgentIcon.vue";

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

function render(name) {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(AgentIcon, { name }) });
  app.mount(root);
  return root;
}

test("shows an agent's own icon, its shape in the text's color", () => {
  expect(render("Claude").querySelector(".agent-icon").style.getPropertyValue("--shape")).toBe("url(/file-icons/claude.svg)");
});

test("a sparkle for an agent without one", () => {
  const root = render("Codex");
  expect(root.querySelector(".agent-icon")).toBeNull();
  expect(root.querySelector("svg")).not.toBeNull();
});
