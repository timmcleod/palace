// What was written in a dialog that closed without it being used, canceled or
// failed, by what it was for, so the same dialog starts with it again. Kept while
// Palace runs.
const drafts = new Map();

export const draftFor = (key) => (key ? drafts.get(key) : undefined);

export function keepDraft(key, value) {
  if (key) drafts.set(key, value);
}

export function dropDraft(key) {
  if (key) drafts.delete(key);
}
