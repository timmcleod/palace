// A sidebar item's key is "kind:name", as "branch:main" or "workspace:history". The
// name can have colons of its own; the kind can't.
export function splitKey(key) {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}
