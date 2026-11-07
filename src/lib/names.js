/**
 * `name`, or if `taken` (a Set) has it already, the first of "name-2", "name-3"… that it
 * doesn't, as for a new branch that mustn't be one the repository has.
 */
export function untakenName(name, taken) {
  let untaken = name;
  for (let n = 2; taken.has(untaken); n++) untaken = `${name}-${n}`;
  return untaken;
}
