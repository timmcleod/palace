import { afterEach, expect, test } from "vitest";
import { createApp, h } from "vue";
import RefName from "./RefName.vue";

let app;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

const render = (props) => {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({ render: () => h(RefName, props) });
  app.mount(root);
  return root;
};

test("spells a branch or tag out in full, with its kind's icon", () => {
  const root = render({ kind: "remote", name: "deploy-tickets.warrenlamb.com/main" });
  expect(root.querySelector(".ref-name.remote").textContent).toBe("deploy-tickets.warrenlamb.com/main");
  expect(root.querySelector("svg")).not.toBeNull();
});

test("shows HEAD as a pill", () => {
  const root = render({ kind: "head", name: "HEAD" });
  expect(root.querySelector(".head-pill").textContent).toBe("HEAD");
  expect(root.querySelector(".ref-name")).toBeNull();
});
