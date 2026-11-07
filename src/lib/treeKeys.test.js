import { describe, expect, test } from "vitest";
import { treeKey } from "./treeKeys.js";

// A tree as shown: src/ open, with lib/ closed inside it, then README.md.
const rows = [
  { path: "src", kind: "dir", depth: 0 },
  { path: "src/lib", kind: "dir", depth: 1 },
  { path: "src/main.js", kind: "file", depth: 1 },
  { path: "README.md", kind: "file", depth: 0 },
];
const open = new Set(["src"]);
const isOpen = (row) => open.has(row.path);
const press = (key, at) => treeKey(key, rows, at, isOpen);
const at = (path) => rows.findIndex((r) => r.path === path);

describe("treeKey", () => {
  test("Up and Down go row to row, staying in the tree, from the top with no cursor yet", () => {
    expect(press("ArrowDown", -1)).toEqual({ move: rows[0] });
    expect(press("ArrowUp", -1)).toEqual({ move: rows[0] });
    expect(press("ArrowDown", at("src"))).toEqual({ move: rows[1] });
    expect(press("ArrowDown", at("README.md"))).toEqual({ move: rows[3] });
    expect(press("ArrowUp", at("src"))).toEqual({ move: rows[0] });
  });

  test("Home and End go to the first row and the last", () => {
    expect(press("Home", at("src/main.js"))).toEqual({ move: rows[0] });
    expect(press("End", at("src"))).toEqual({ move: rows[3] });
  });

  test("Right opens a closed folder, then steps into it", () => {
    expect(press("ArrowRight", at("src/lib"))).toEqual({ toggle: rows[1] });
    expect(press("ArrowRight", at("src"))).toEqual({ move: rows[1] });
    // A file, or an open folder with nothing in it, has nowhere to go.
    expect(press("ArrowRight", at("README.md"))).toEqual({});
  });

  test("Left closes an open folder, or steps out to the folder a row's in", () => {
    expect(press("ArrowLeft", at("src"))).toEqual({ toggle: rows[0] });
    expect(press("ArrowLeft", at("src/main.js"))).toEqual({ move: rows[0] });
    expect(press("ArrowLeft", at("src/lib"))).toEqual({ move: rows[0] });
    // At the top, there's nowhere further out.
    expect(press("ArrowLeft", at("README.md"))).toEqual({});
  });

  test("Enter and Space open what the cursor's on", () => {
    expect(press("Enter", at("src/main.js"))).toEqual({ activate: rows[2] });
    expect(press(" ", at("src"))).toEqual({ activate: rows[0] });
    expect(press("Enter", -1)).toEqual({});
  });

  test("leaves other keys, and an empty tree, alone", () => {
    expect(press("a", 0)).toBeNull();
    expect(press("Tab", 0)).toBeNull();
    expect(treeKey("ArrowDown", [], -1, isOpen)).toBeNull();
  });
});
