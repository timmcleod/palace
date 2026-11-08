import { expect, test } from "vitest";
import { folderName } from "./format.js";

test("names a folder by its last part", () => {
  expect(folderName("/code/palace")).toBe("palace");
  expect(folderName("/code/palace/")).toBe("palace");
  expect(folderName("C:\\code\\palace")).toBe("palace");
  expect(folderName("/")).toBe("/");
});
