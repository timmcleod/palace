import { createApp } from "vue";

// Runs `composable` in the setup of a component mounted on the stand-in page, as Workspace.vue
// would, so its lifecycle hooks register. Returns what it returned, and unmount(), which
// runs its onBeforeUnmount cleanup.
export function mountComposable(composable) {
  let result;
  const app = createApp({
    setup() {
      result = composable();
      return () => null;
    },
  });
  app.mount(document.createElement("div"));
  return { result, unmount: () => app.unmount() };
}
