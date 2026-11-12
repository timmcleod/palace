import { readJson } from "./storage.js";

// The order Working Copy lists its files in, for what goes by them in that order, as
// going on to the next conflicted file does, to match what's seen.

// Whether Working Copy shows its files as a tree, rather than a list (its View menu).
export const TREE_KEY = "palace.workingCopyTree";
export const listsAsTree = () => readJson(TREE_KEY, false) === true;

/**
 * `files` in the order Working Copy lists them: as git gives them, or in the tree, each
 * folder's folders first, by name whatever its case, then its files, as given. Folders
 * closed in the tree don't change it: what's in them is still in its place.
 */
export function listedOrder(files, asTree = listsAsTree()) {
  if (!asTree) return files;
  // A repository inside this one is listed as a folder, "nested/": a row of its own.
  const parts = new Map(files.map((file) => [file, file.path.replace(/\/$/, "").split("/")]));
  const given = new Map(files.map((file, i) => [file, i]));
  return [...files].sort((a, b) => {
    const [pa, pb] = [parts.get(a), parts.get(b)];
    for (let i = 0; ; i++) {
      const [aFile, bFile] = [i === pa.length - 1, i === pb.length - 1];
      if (aFile && bFile) return given.get(a) - given.get(b);
      // A folder before a file beside it.
      if (aFile !== bFile) return aFile ? 1 : -1;
      if (pa[i] !== pb[i]) return pa[i].localeCompare(pb[i], undefined, { sensitivity: "base" }) || (pa[i] < pb[i] ? -1 : 1);
    }
  });
}
