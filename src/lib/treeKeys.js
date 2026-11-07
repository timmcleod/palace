// The keys in a tree of files and folders, as in a file manager: Up and Down move from
// row to row, Home and End to the first and last; Right opens a folder, or steps into
// it once it's open, and Left closes it, or steps out to the folder a row's in; Enter
// and Space open what the cursor's on. The Files view and a commit's Files tab both use
// them, so they behave alike.

const folderOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * What `key` does in `rows` (each { path, kind, depth }, as shown, top to bottom), with
 * the cursor on the row at `at` (-1 for none), and `isOpen(row)` saying whether a folder
 * is: { move: row } to put the cursor there, { toggle: row } to open or close a folder,
 * { activate: row } to open it, or {} for a key that's the tree's with nothing to do
 * here. Null for a key that isn't the tree's.
 */
export function treeKey(key, rows, at, isOpen) {
  if (!rows.length) return null;
  const row = rows[at];
  switch (key) {
    case "ArrowDown":
      return { move: rows[at < 0 ? 0 : Math.min(at + 1, rows.length - 1)] };
    case "ArrowUp":
      return { move: rows[at < 0 ? 0 : Math.max(at - 1, 0)] };
    case "Home":
      return { move: rows[0] };
    case "End":
      return { move: rows.at(-1) };
    case "ArrowRight":
      if (row?.kind !== "dir") return {};
      if (!isOpen(row)) return { toggle: row };
      return rows[at + 1]?.depth > row.depth ? { move: rows[at + 1] } : {};
    case "ArrowLeft": {
      if (!row) return {};
      if (row.kind === "dir" && isOpen(row)) return { toggle: row };
      const folder = rows.find((r) => r.path === folderOf(row.path));
      return folder ? { move: folder } : {};
    }
    case "Enter":
    case " ":
      return row ? { activate: row } : {};
    default:
      return null;
  }
}
