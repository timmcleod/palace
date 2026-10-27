// Groups slash-separated names ("feature/login") into nested folders, so branches and
// tags like feature/login and feature/search sit together in the sidebar.
export function buildTree(items, nameOf) {
  const root = { folders: new Map(), leaves: [] };

  for (const item of items) {
    const parts = nameOf(item).split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) {
        node.folders.set(part, { folders: new Map(), leaves: [] });
      }
      node = node.folders.get(part);
    }
    node.leaves.push({ label: parts.at(-1), item });
  }

  return root;
}

// Flattens the visible part of a tree into rows so the sidebar can render it with a
// single v-for. Folders come first, then leaves.
export function flattenTree(node, { depth = 0, keyPrefix, path = "", isOpen, leafRow }) {
  const rows = [];

  const folders = [...node.folders.entries()].sort(([a], [b]) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  for (const [name, child] of folders) {
    const folderPath = `${path}${name}/`;
    const key = keyPrefix + folderPath;
    const open = isOpen(key);
    rows.push({ key, label: name, depth, folder: true, open });
    if (open) {
      rows.push(...flattenTree(child, { depth: depth + 1, keyPrefix, path: folderPath, isOpen, leafRow }));
    }
  }

  for (const leaf of node.leaves) {
    rows.push({ ...leafRow(leaf.item), label: leaf.label, depth });
  }

  return rows;
}
