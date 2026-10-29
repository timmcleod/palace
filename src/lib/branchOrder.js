import { reactive } from "vue";
import { readJson, writeJson } from "./storage.js";
import { buildTree, flattenTree } from "./tree.js";

// The order the sidebar lists local branches in once they've been dragged around, and
// the dividers between them, per repository. Only Palace's sidebar uses it; git knows
// nothing of it.
//
// `order` holds sidebar keys: "branch:name", "branch-folder:path/" and
// "branch-divider:id". Only the order of keys in the same folder matters. Branches it
// doesn't mention, such as new ones, follow the arranged ones in the usual order, and
// keys of deleted branches are ignored. Dividers only go between top-level rows, and
// may have a label.
const KEY = "palace.branchOrder";
const stored = readJson(KEY, {});
const arrangements = reactive(stored && typeof stored === "object" ? stored : {});

const DIVIDER = "branch-divider:";
export const isDivider = (key) => key.startsWith(DIVIDER);

function arrangement(path) {
  const a = arrangements[path];
  return Array.isArray(a?.order) ? a : { order: [], labels: {} };
}

function save(path, order, labels) {
  if (order.length) arrangements[path] = { order, labels };
  else delete arrangements[path];
  writeJson(KEY, arrangements);
}

export const branchOrder = (path) => arrangement(path).order;
export const isArranged = (path) => branchOrder(path).length > 0;

/** The dividers, as sidebar rows. */
export function dividerRows(path) {
  const { order, labels } = arrangement(path);
  return order.filter(isDivider).map((key) => ({ key, divider: true, label: labels?.[key] ?? "" }));
}

/** The keys of the top-level rows, in the order the sidebar lists them. */
export function topLevelKeys(path, branches) {
  return flattenTree(buildTree(branches, (b) => b.name), {
    keyPrefix: "branch-folder:",
    isOpen: () => false,
    leafRow: (b) => ({ key: `branch:${b.name}` }),
    order: branchOrder(path),
    extraRows: dividerRows(path),
  }).map((row) => row.key);
}

// The saved order with `siblings` (keys listed beside each other, in the sidebar's
// order) all in it, so a key can be placed relative to any of them.
function withSiblings(path, siblings) {
  const order = branchOrder(path).slice();
  for (const key of siblings) if (!order.includes(key)) order.push(key);
  return order;
}

/** Moves `key` to just before, or after, `target`, one of `siblings`. */
export function moveKey(path, key, target, after, siblings) {
  if (key === target) return;
  const order = withSiblings(path, siblings).filter((k) => k !== key);
  order.splice(order.indexOf(target) + (after ? 1 : 0), 0, key);
  save(path, order, arrangement(path).labels);
}

/** Adds a divider after `afterKey`, or after the last of `siblings` when it's null. */
export function addDivider(path, label, afterKey, siblings) {
  const order = withSiblings(path, siblings);
  const key = DIVIDER + Date.now().toString(36);
  const at = afterKey ? order.indexOf(afterKey) + 1 : Math.max(...siblings.map((k) => order.indexOf(k)), -1) + 1;
  order.splice(at, 0, key);
  save(path, order, { ...arrangement(path).labels, ...(label ? { [key]: label } : {}) });
}

export function labelDivider(path, key, label) {
  const { order, labels } = arrangement(path);
  const next = { ...labels };
  if (label) next[key] = label;
  else delete next[key];
  save(path, order, next);
}

/** Forgets a divider, or a deleted branch's place. */
export function removeKey(path, key) {
  const { order, labels } = arrangement(path);
  const next = { ...labels };
  delete next[key];
  save(path, order.filter((k) => k !== key), next);
}

/** Keeps a renamed branch where it was. */
export function renameKey(path, oldName, newName) {
  const { order, labels } = arrangement(path);
  save(path, order.map((k) => (k === `branch:${oldName}` ? `branch:${newName}` : k)), labels);
}

export function resetOrder(path) {
  save(path, [], {});
}
