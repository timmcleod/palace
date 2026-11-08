import { expect, test } from "vitest";
import { handoff } from "./scrollHandoff.js";

test("hands off as the heading's last stretch passes under the top edge", () => {
  // A heading ending 200px down, handing off over its last 60.
  expect(handoff(0, 200)).toBe(0);
  expect(handoff(140, 200)).toBe(0);
  expect(handoff(170, 200)).toBe(0.5);
  expect(handoff(200, 200)).toBe(1);
  expect(handoff(900, 200)).toBe(1);
});
