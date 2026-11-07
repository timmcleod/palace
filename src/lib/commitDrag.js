import { shallowRef } from "vue";

// A commit being dragged from the history of another branch, a tag or a remote branch,
// to the sidebar's current branch, which cherry-picks it there. The history sets it as
// the drag starts and clears it as it ends; the sidebar reads it, as the web view only
// says what's dragged once it's dropped.
export const draggedCommit = shallowRef(null);

// The drag's own type, which the web view does say as it goes: a drag that hasn't it,
// such as a file's, isn't the commit's, even with draggedCommit left set by one whose
// end went unheard (its row gone as the history scrolled or reloaded, say).
export const COMMIT_TYPE = "application/x-palace-commit";

/** Whether `event`, a drag over something, is a commit's from the history. */
export const isCommitDrag = (event) => !!draggedCommit.value && !!event.dataTransfer?.types?.includes(COMMIT_TYPE);
