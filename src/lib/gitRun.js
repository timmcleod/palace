import { invoke } from "@tauri-apps/api/core";
import { CANCELED, CONFLICT, STALE_STEP, errorDetail, isError } from "./errors.js";

// Only network operations report progress and can be canceled.
const NETWORK = new Set([
  "fetch",
  "pull",
  "checkout_pull",
  "push",
  "publish_branch",
  "clone_repo",
  "add_remote",
  "delete_remote_tag",
  "delete_remote_branch",
  "rename_remote_branch",
  "finish_remote_rename",
]);

/**
 * Running the tab's git operations, one at a time, each shown in the status card.
 * What it needs from the tab, Workspace.vue:
 *   overview             the open repository's overview ref
 *   status               the status card (see statusCard.js)
 *   undo                 { stepFor, newest, undoable, undo } (see undo.js)
 *   stopBackgroundFetch  stops one under way, as an operation goes first
 *   refresh              reloads everything, after each operation
 *   onConflict(where)    an operation stopped for conflicts, or left some: they're shown
 *   onDone(op, command, args, where)  one finished: what follows from it, such as
 *                        offering a pull request for a branch just pushed. `where` is
 *                        the repository it ran in, which may no longer be the open one
 *   pull, forcePush      what a push rejected for the remote's commits offers
 * Returns runGit.
 */
export function useGitRun({ overview, status, undo, stopBackgroundFetch, refresh, onConflict, onDone, pull, forcePush }) {
  /**
   * Runs a backend command against the open repository, showing it in the status card
   * and refreshing everything afterwards. Resolves to the error message, or null.
   *
   * titles: [while running, on success, on failure]. options.quietError(message)
   * returning true hides that failure, for callers that handle it themselves.
   * options.path runs it somewhere other than the open repository, or with none open.
   * Commands undo.js knows can be undone afterwards; options.undo names the step.
   */
  async function runGit([running, done, failed], command, args = {}, { quietError, path, undo: undoLabel } = {}) {
    if (status.busy.value) return "Another operation is still running.";
    if (!overview.value && !path) return "No repository is open.";
    // Where it runs, which its progress comes from and canceling names.
    const where = path ?? overview.value.path;
    const op = status.show({ command, path: where, title: running, line: "", state: "running", message: "", cancellable: NETWORK.has(command) });

    // Only what's done in the open repository can be undone. Told before waiting, when
    // the repository's still the one it runs in.
    const step = path ? null : undo.stepFor(command, args, undoLabel, where);
    const newestBefore = undo.newest();
    try {
      await stopBackgroundFetch();
      const work = () => invoke(command, { path: where, ...args });
      const message = await (step ? undo.undoable(step, work, where) : work());
      // Undo is offered for what it did, while its repository's still the open one: after
      // another's opened, undo would undo that one's newest step.
      if (overview.value?.path === where && undo.newest() !== newestBefore) op.actions = [{ label: "Undo", run: undo.undo }];
      // Done, but changes set aside for it conflicted when put back.
      if (isError(message, CONFLICT)) {
        op.state = "conflict";
        op.title = `${done}, with conflicts`;
        op.message = errorDetail(message, CONFLICT);
        onConflict(where);
        return null;
      }
      op.message = message;
      op.state = "done";
      op.title = done;
      onDone(op, command, args, where);
      // Successes get out of the way; failures stay until dismissed.
      status.dismissLater(op, 5000);
      return null;
    } catch (e) {
      const message = String(e);
      if (message === CANCELED) {
        status.dismiss();
      } else if (quietError?.(message)) {
        status.dismiss();
      } else if (isError(message, CONFLICT)) {
        // The operation is under way and waiting on the user, not failed.
        op.state = "conflict";
        op.title = "Stopped for conflicts";
        op.message = errorDetail(message, CONFLICT);
        onConflict(where);
      } else {
        op.state = "failed";
        op.title = failed;
        op.message = isError(message, STALE_STEP) ? errorDetail(message, STALE_STEP) : message;
        // A push rejected because the remote has commits this branch doesn't is usually
        // fixed by pulling them in. If the branch was rewritten (amend, rebase) instead,
        // force pushing publishes it.
        // Not once another repository's open, which they'd run in.
        if (command === "push" && overview.value?.path === where) {
          const fetchFirst = message.includes("(fetch first)");
          const nonFastForward = message.includes("non-fast-forward");
          if (fetchFirst || nonFastForward) {
            op.actions = [{ label: "Pull…", run: () => pull() }];
            if (nonFastForward) op.actions.push({ label: "Force Push…", run: () => forcePush() });
          }
        }
      }
      return message;
    } finally {
      refresh();
    }
  }

  return { runGit };
}
