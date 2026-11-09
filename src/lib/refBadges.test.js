import { describe, expect, test } from "vitest";
import { CARD_NAMES, ROW_NAMES, refBadges } from "./refBadges.js";

const ref = (kind, name) => ({ kind, name });

describe("a commit's branches and tags as badges", () => {
  test("one for each kind it has, in order, with every name", () => {
    const { head, badges } = refBadges([ref("head", "HEAD"), ref("local", "main"), ref("remote", "origin/main"), ref("remote", "upstream/main"), ref("tag", "v1.0")]);
    expect(head).toBe(true);
    expect(badges).toEqual([
      { kind: "local", title: "Branches", names: ["main"], count: 1, shown: ["main"], more: 0 },
      { kind: "remote", title: "Remote branches", names: ["origin/main", "upstream/main"], count: 2, shown: ["origin/main", "upstream/main"], more: 0 },
      { kind: "tag", title: "Tags", names: ["v1.0"], count: 1, shown: ["v1.0"], more: 0 },
    ]);
  });

  test("none for a commit without any", () => {
    expect(refBadges([])).toEqual({ head: false, badges: [], named: { shown: [], more: 0, rest: [] } });
  });

  test("HEAD is said apart from the badges, a detached one with none", () => {
    expect(refBadges([ref("head", "HEAD"), ref("tag", "v2.0")])).toMatchObject({ head: true, badges: [{ kind: "tag", count: 1 }] });
  });
});

test("the card lists so many names of a kind, then says how many more", () => {
  const tags = Array.from({ length: CARD_NAMES + 3 }, (_, i) => ref("tag", `v${i}`));
  const [badge] = refBadges(tags).badges;
  expect(badge.count).toBe(CARD_NAMES + 3);
  expect(badge.shown).toHaveLength(CARD_NAMES);
  expect(badge.more).toBe(3);
});

test("spells out the first few names, in the badges' order, then says how many more", () => {
  // Out of order, with HEAD among them, which isn't one of them.
  const refs = [ref("tag", "v1.0"), ref("remote", "origin/dev"), ref("head", "HEAD")];
  for (let i = 0; i < ROW_NAMES; i++) refs.push(ref("local", `branch-${i}`));
  const inOrder = [...refs.filter((r) => r.kind === "local"), ref("remote", "origin/dev"), ref("tag", "v1.0")];
  expect(refBadges(refs).named).toEqual({
    shown: inOrder.slice(0, ROW_NAMES),
    more: 2,
    rest: ["origin/dev", "v1.0"],
  });
  expect(refBadges([ref("local", "main")]).named).toEqual({ shown: [ref("local", "main")], more: 0, rest: [] });
});
