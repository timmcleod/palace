import { expect, test } from "vitest";
import { splitKey } from "./sidebarKeys.js";

test("splitKey splits at the first colon, so names can have their own", () => {
  expect(splitKey("branch:main")).toEqual(["branch", "main"]);
  expect(splitKey("workspace:history")).toEqual(["workspace", "history"]);
  expect(splitKey("tag:release:2026")).toEqual(["tag", "release:2026"]);
  expect(splitKey("remote-branch:origin/feature/x")).toEqual(["remote-branch", "origin/feature/x"]);
});
