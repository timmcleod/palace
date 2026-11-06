import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isReactive } from "vue";
import { useStatusCard } from "./statusCard.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useStatusCard", () => {
  test("a running operation stays, counts as busy, and shows what changes on it", () => {
    const status = useStatusCard();
    const op = status.show({ title: "Pushing…", state: "running" });
    expect(isReactive(op)).toBe(true);
    expect(status.card.value).toBe(op);
    expect(status.busy.value).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(status.card.value).toBe(op);
    op.state = "done";
    expect(status.busy.value).toBe(false);
  });

  test("a card goes once its countdown ends", () => {
    const status = useStatusCard();
    const op = status.show({ title: "Fetched", state: "done" }, { dismissAfter: 5000 });
    vi.advanceTimersByTime(4999);
    expect(status.card.value).toBe(op);
    vi.advanceTimersByTime(1);
    expect(status.card.value).toBeNull();
  });

  test("a card replaced before its countdown ends isn't dismissed by it", () => {
    const status = useStatusCard();
    status.show({ title: "A", state: "done" }, { dismissAfter: 5000 });
    vi.advanceTimersByTime(2000);
    const failed = status.show({ title: "B", state: "failed" });
    vi.advanceTimersByTime(10_000);
    expect(status.card.value).toBe(failed);
  });

  // As when offerPullRequest, having waited on GitHub, gives a card that's since been
  // replaced more time.
  test("dismissLater for a card no longer shown leaves the one that is", () => {
    const status = useStatusCard();
    const pushed = status.show({ title: "Pushed", state: "done" });
    const failed = status.show({ title: "Fetch failed", state: "failed" });
    status.dismissLater(pushed, 10_000);
    vi.advanceTimersByTime(10_000);
    expect(status.card.value).toBe(failed);
  });

  // As a push finishing after a merged pull request's card has taken its place.
  test("dismissLater for a card no longer shown keeps the countdown of the one that is", () => {
    const status = useStatusCard();
    const pushing = status.show({ title: "Pushing…", state: "running" });
    const merged = status.show({ title: "Merged pull request", state: "done" }, { dismissAfter: 15_000 });
    status.dismissLater(pushing, 5000);
    vi.advanceTimersByTime(14_999);
    expect(status.card.value).toBe(merged);
    vi.advanceTimersByTime(1);
    expect(status.card.value).toBeNull();
  });

  test("dismissLater restarts the countdown", () => {
    const status = useStatusCard();
    const op = status.show({ title: "Pushed", state: "done" }, { dismissAfter: 5000 });
    vi.advanceTimersByTime(4000);
    status.dismissLater(op, 10_000);
    vi.advanceTimersByTime(9000);
    expect(status.card.value).toBe(op);
    vi.advanceTimersByTime(1000);
    expect(status.card.value).toBeNull();
  });

  test("dismiss closes the card", () => {
    const status = useStatusCard();
    status.show({ title: "Failed", state: "failed" });
    status.dismiss();
    expect(status.card.value).toBeNull();
  });
});
