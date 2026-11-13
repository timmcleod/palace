import { inject, provide } from "vue";

// Whether the workspace a component is in is the one showing in its window. A window can
// hold several, each kept running while another shows (see Workspace.vue), so what
// listens to the whole window, as for a key, acts only in the one showing.

const ACTIVE = Symbol("active workspace");

/** Says, to the components in the calling workspace, whether it's showing: `active()`. */
export const provideActive = (active) => provide(ACTIVE, active);

/** Whether the workspace the calling component is in is showing; true outside one. */
export function inActiveWorkspace() {
  const active = inject(ACTIVE, () => true);
  return () => active();
}
