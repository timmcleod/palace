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
// single v-for. Folders come first, then leaves, unless `order` (a list of row keys)
// says otherwise: rows in it come first, in its order. `extraRows`, such as dividers,
// join the top level. Each row's `parent` is the path of the folder it's in.
export function flattenTree(node, { depth = 0, keyPrefix, path = "", isOpen, leafRow, order = null, extraRows = [] }) {
  const entries = [];

  const folders = [...node.folders.entries()].sort(([a], [b]) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  for (const [name, child] of folders) {
    const folderPath = `${path}${name}/`;
    const key = keyPrefix + folderPath;
    const open = isOpen(key);
    entries.push({
      key,
      rows: () => [
        { key, label: name, depth, parent: path, folder: true, open },
        ...(open ? flattenTree(child, { depth: depth + 1, keyPrefix, path: folderPath, isOpen, leafRow, order }) : []),
      ],
    });
  }

  for (const leaf of node.leaves) {
    const row = { ...leafRow(leaf.item), label: leaf.label, depth, parent: path };
    entries.push({ key: row.key, rows: () => [row] });
  }

  for (const extra of extraRows) {
    entries.push({ key: extra.key, rows: () => [{ ...extra, depth, parent: path }] });
  }

  if (order?.length) {
    const rank = new Map(order.map((key, i) => [key, i]));
    const rankOf = (key) => rank.get(key) ?? order.length;
    entries.sort((a, b) => rankOf(a.key) - rankOf(b.key));
  }

  return entries.flatMap((entry) => entry.rows());
}
