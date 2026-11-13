import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { CANCELED, CONFLICT, STALE_STEP } from "./errors.js";
import { useStatusCard } from "./statusCard.js";
import { useGitRun } from "./gitRun.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const TITLES = ["Doing…", "Done", "Couldn't do it"];

// The window's part, Workspace.vue's, around running an operation, recorded.
function runner({ open = { path: "/repo", head: { branch: "main" } }, step = null } = {}) {
  const status = useStatusCard();
  let newest = 0;
  const parts = {
    overview: ref(open),
    status,
    stopBackgroundFetch: vi.fn(async () => {}),
    refresh: vi.fn(),
    onConflict: vi.fn(),
    onDone: vi.fn(),
    pull: vi.fn(),
    forcePush: vi.fn(),
    undo: {
      stepFor: vi.fn(() => step),
      newest: () => newest,
      // Recording a step makes it the newest.
      undoable: vi.fn(async (_step, work) => {
        const result = await work();
        newest++;
        return result;
      }),
      undo: vi.fn(),
    },
  };
  return { ...parts, ...useGitRun(parts), card: status.card };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset().mockResolvedValue("All done.");
});
afterEach(() => vi.useRealTimers());

describe("running an operation", () => {
  test("runs it in the open repository, showing it, and says so when it's done", async () => {
    const run = runner();
    let duringCard;
    vi.mocked(invoke).mockImplementation(async () => {
      duringCard = { ...run.card.value };
      return "Merged 3 commits.";
    });
    expect(await run.runGit(TITLES, "merge", { branch: "next" })).toBeNull();
    expect(invoke).toHaveBeenCalledWith("merge", { path: "/repo", branch: "next" });
    expect(duringCard).toMatchObject({ title: "Doing…", state: "running", command: "merge", cancellable: false });
    expect(run.card.value).toMatchObject({ title: "Done", state: "done", message: "Merged 3 commits." });
    expect(run.onDone).toHaveBeenCalledWith(run.card.value, "merge", { branch: "next" }, expect.any(String));
    // A success gets out of the way.
    vi.advanceTimersByTime(5000);
    expect(run.card.value).toBeNull();
  });

  test("stops the background fetch first, and refreshes everything after, done or not", async () => {
    const run = runner();
    const order = [];
    run.stopBackgroundFetch.mockImplementation(async () => order.push("stop"));
    vi.mocked(invoke).mockImplementation(async () => order.push("run"));
    run.refresh.mockImplementation(() => order.push("refresh"));
    await run.runGit(TITLES, "merge");
    expect(order).toEqual(["stop", "run", "refresh"]);

    vi.mocked(invoke).mockRejectedValue("fatal: nope");
    await run.runGit(TITLES, "merge");
    expect(run.refresh).toHaveBeenCalledTimes(2);
  });

  test("can be canceled only when it goes over the network", async () => {
    const run = runner();
    let cancellable;
    vi.mocked(invoke).mockImplementation(async () => (cancellable = run.card.value.cancellable));
    await run.runGit(TITLES, "push");
    expect(cancellable).toBe(true);
    await run.runGit(TITLES, "commit");
    expect(cancellable).toBe(false);
  });

  test("waits for nothing, but won't start while another's running", async () => {
    const run = runner();
    let finish;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const first = run.runGit(TITLES, "fetch");
    await Promise.resolve();
    expect(await run.runGit(TITLES, "merge")).toBe("Another operation is still running.");
    expect(invoke).toHaveBeenCalledTimes(1);
    finish("Fetched.");
    await first;
  });

  test("needs a repository open, or another place to run", async () => {
    const run = runner({ open: null });
    expect(await run.runGit(TITLES, "merge")).toBe("No repository is open.");
    expect(invoke).not.toHaveBeenCalled();
    expect(await run.runGit(TITLES, "clone_repo", { url: "u" }, { path: "/new" })).toBeNull();
    expect(invoke).toHaveBeenCalledWith("clone_repo", { path: "/new", url: "u" });
  });
});

describe("undo", () => {
  test("records a step for what can be undone, and offers to undo it", async () => {
    const step = { label: "Merge" };
    const run = runner({ step });
    await run.runGit(TITLES, "merge", { branch: "next" }, { undo: "Merge next" });
    expect(run.undo.stepFor).toHaveBeenCalledWith("merge", { branch: "next" }, "Merge next");
    expect(run.undo.undoable).toHaveBeenCalledWith(step, expect.any(Function));
    const [undoAction] = run.card.value.actions;
    expect(undoAction.label).toBe("Undo");
    undoAction.run();
    expect(run.undo.undo).toHaveBeenCalled();
  });

  test("offers nothing to undo for what can't be, nor for what's run elsewhere", async () => {
    const run = runner();
    await run.runGit(TITLES, "fetch");
    expect(run.card.value.actions).toBeUndefined();

    const elsewhere = runner({ step: { label: "Clone" } });
    await elsewhere.runGit(TITLES, "clone_repo", {}, { path: "/new" });
    expect(elsewhere.undo.stepFor).not.toHaveBeenCalled();
    expect(elsewhere.undo.undoable).not.toHaveBeenCalled();
  });
});

describe("conflicts", () => {
  test("done, but with changes set aside for it that conflicted when put back", async () => {
    vi.mocked(invoke).mockResolvedValue(`${CONFLICT}a.txt`);
    const run = runner();
    expect(await run.runGit(TITLES, "pull")).toBeNull();
    expect(run.card.value).toMatchObject({ state: "conflict", title: "Done, with conflicts", message: "a.txt" });
    expect(run.onConflict).toHaveBeenCalled();
    expect(run.onDone).not.toHaveBeenCalled();
    // It waits on the user.
    vi.advanceTimersByTime(60000);
    expect(run.card.value).not.toBeNull();
  });

  test("left by an operation that can be undone, offers to undo it", async () => {
    vi.mocked(invoke).mockResolvedValue(`${CONFLICT}a.txt`);
    const run = runner({ step: { label: "Pull" } });
    await run.runGit(TITLES, "pull");
    expect(run.card.value.actions.map((a) => a.label)).toEqual(["Undo"]);
  });

  test("stopped for them, waiting on the user rather than failed", async () => {
    vi.mocked(invoke).mockRejectedValue(`${CONFLICT}b.txt`);
    const run = runner();
    expect(await run.runGit(TITLES, "rebase")).toBe(`${CONFLICT}b.txt`);
    expect(run.card.value).toMatchObject({ state: "conflict", title: "Stopped for conflicts", message: "b.txt" });
    expect(run.onConflict).toHaveBeenCalled();
  });
});

describe("failing", () => {
  test("says so, staying until it's dismissed", async () => {
    vi.mocked(invoke).mockRejectedValue("fatal: not something we can merge");
    const run = runner();
    expect(await run.runGit(TITLES, "merge")).toBe("fatal: not something we can merge");
    expect(run.card.value).toMatchObject({ state: "failed", title: "Couldn't do it", message: "fatal: not something we can merge" });
    expect(run.onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60000);
    expect(run.card.value).not.toBeNull();
  });

  test("saying only why, for an undo step that can't be replayed", async () => {
    vi.mocked(invoke).mockRejectedValue(`${STALE_STEP}The branch has moved since.`);
    const run = runner();
    await run.runGit(TITLES, "merge");
    expect(run.card.value.message).toBe("The branch has moved since.");
  });

  test("canceled, goes quietly", async () => {
    vi.mocked(invoke).mockRejectedValue(CANCELED);
    const run = runner();
    expect(await run.runGit(TITLES, "push")).toBe(CANCELED);
    expect(run.card.value).toBeNull();
    expect(run.onDone).not.toHaveBeenCalled();
  });

  test("goes quietly when the caller says it'll handle the failure itself", async () => {
    vi.mocked(invoke).mockRejectedValue("error: not fully merged");
    const run = runner();
    const quietError = (message) => message.includes("not fully merged");
    expect(await run.runGit(TITLES, "delete_branch", {}, { quietError })).toBe("error: not fully merged");
    expect(run.card.value).toBeNull();
    expect(run.onDone).not.toHaveBeenCalled();
  });

  test("a push rejected for commits the remote has offers to pull them, or to force push a rewritten branch", async () => {
    const run = runner();
    vi.mocked(invoke).mockRejectedValue("! [rejected] main -> main (fetch first)");
    await run.runGit(TITLES, "push");
    expect(run.card.value.actions.map((a) => a.label)).toEqual(["Pull…"]);
    run.card.value.actions[0].run();
    expect(run.pull).toHaveBeenCalled();

    vi.mocked(invoke).mockRejectedValue("! [rejected] main -> main (non-fast-forward)");
    await run.runGit(TITLES, "push");
    expect(run.card.value.actions.map((a) => a.label)).toEqual(["Pull…", "Force Push…"]);
    run.card.value.actions[1].run();
    expect(run.forcePush).toHaveBeenCalled();

    // Not for another failure, nor another command.
    vi.mocked(invoke).mockRejectedValue("fatal: could not read from remote");
    await run.runGit(TITLES, "push");
    expect(run.card.value.actions).toBeUndefined();
    vi.mocked(invoke).mockRejectedValue("(fetch first)");
    await run.runGit(TITLES, "fetch");
    expect(run.card.value.actions).toBeUndefined();
  });
});
