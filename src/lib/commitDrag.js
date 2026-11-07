import { shallowRef } from "vue";

// Commits being dragged from the history of another branch, a tag or a remote branch,
// to the sidebar's current branch, which cherry-picks them there: the one dragged, or the
// several chosen with it, oldest first. The history sets them as the drag starts and
// clears them as it ends; the sidebar reads them, as the web view only says what's
// dragged once it's dropped.
export const draggedCommits = shallowRef(null);

// The drag's own type, which the web view does say as it goes: a drag that hasn't it,
// such as a file's, isn't the commits', even with draggedCommits left set by one whose
// end went unheard (its row gone as the history scrolled or reloaded, say).
export const COMMIT_TYPE = "application/x-palace-commit";

/** Whether `event`, a drag over something, is commits' from the history. */
export const isCommitDrag = (event) => !!draggedCommits.value?.length && !!event.dataTransfer?.types?.includes(COMMIT_TYPE);
