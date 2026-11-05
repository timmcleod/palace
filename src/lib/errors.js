// The prefixes that start an error the backend means for the page to act on, rather
// than only show. src-tauri/src/errors.rs has the same ones, and a test there checks
// that the two match; see it for what each means.

export const CONFLICT = "CONFLICT: ";
export const NOT_A_REPOSITORY = "NOT_A_REPOSITORY: ";
export const PULL_REWRITTEN = "PULL_REWRITTEN: ";
export const CHANGED_ON_DISK = "CHANGED_ON_DISK: ";

// Whether `error` (a message, or whatever a failed invoke threw) starts with `prefix`.
export const isError = (error, prefix) => String(error).startsWith(prefix);

// What `error` says after `prefix`.
export const errorDetail = (error, prefix) => String(error).slice(prefix.length);
