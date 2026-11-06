import { expect, test } from "vitest";
import { shellEscape } from "./shell.js";

test("a path is escaped as Terminal.app types a dropped file's", () => {
  expect(shellEscape("/Users/me/Desktop/Screenshot 2026-11-06 at 4.43.29 PM.png")).toBe(
    String.raw`/Users/me/Desktop/Screenshot\ 2026-11-06\ at\ 4.43.29\ PM.png`,
  );
  expect(shellEscape("/tmp/it's (1) & $HOME;*.txt")).toBe(String.raw`/tmp/it\'s\ \(1\)\ \&\ \$HOME\;\*.txt`);
  // Letters beyond ASCII stay as they are.
  expect(shellEscape("/home/me/café/résumé.pdf")).toBe("/home/me/café/résumé.pdf");
});
