// New Task: a worktree with a branch of its own, made for a task an agent starts on in a
// window of its own (see newTask in gitActions.js).

/**
 * A branch name for the task `description`, when none is given: its first few words, in
 * lower case, joined with hyphens, as "fix-the-login-redirect". Not one in `taken` (the
 * repository's branches): a number follows, as "fix-the-login-redirect-2". "task" for a
 * description with no words to name it by.
 */
export function branchForTask(description, taken = new Set()) {
  const words = description.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  let base = "";
  for (const word of words.slice(0, 6)) {
    const next = base ? `${base}-${word}` : word;
    if (next.length > 40) break;
    base = next;
  }
  // A first word longer than that is cut short instead.
  base ||= (words[0] ?? "").slice(0, 40) || "task";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}
