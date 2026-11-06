//! The prefixes that start an error the page acts on, rather than only shows, and the
//! whole message for one canceled. The
//! page checks for them in src/lib/errors.js, which has the same ones; the test below
//! keeps the two in step.

/// Starts the message for an operation that stopped for conflicts and is waiting on
/// the user, rather than failed. Also for one that finished, but whose changes set
/// aside for it conflicted when put back.
pub(crate) const CONFLICT: &str = "CONFLICT: ";

/// Starts the refusal for a folder that isn't in a repository, so Palace can offer to
/// create one there.
pub(crate) const NOT_A_REPOSITORY: &str = "NOT_A_REPOSITORY: ";

/// Starts the refusal to replace pr-N's own commits with a rewritten pull request: then
/// how many of them there are, or "?" when Palace can't tell which are the user's.
pub(crate) const PULL_REWRITTEN: &str = "PULL_REWRITTEN: ";

/// Starts the refusal to save over a file that changed on disk since it was read, so
/// the page can offer to reload it instead.
pub(crate) const CHANGED_ON_DISK: &str = "CHANGED_ON_DISK: ";

/// Starts the refusal to undo or redo a step whose changes something else has changed
/// since, or whose saved copies git has since cleared away: it never can be, so the
/// page drops it.
pub(crate) const STALE_STEP: &str = "STALE_STEP: ";

/// The whole message for an operation the user canceled, as a fetch stopped partway:
/// the page lets it go quietly rather than showing it as a failure. The page returns it
/// too, for an operation declined before it started.
pub(crate) const CANCELED: &str = "Canceled.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_checks_for_the_same_prefixes() {
        let page = include_str!("../../src/lib/errors.js");
        for (name, prefix) in [
            ("CONFLICT", CONFLICT),
            ("NOT_A_REPOSITORY", NOT_A_REPOSITORY),
            ("PULL_REWRITTEN", PULL_REWRITTEN),
            ("CHANGED_ON_DISK", CHANGED_ON_DISK),
            ("STALE_STEP", STALE_STEP),
            ("CANCELED", CANCELED),
        ] {
            let declared = format!("export const {name} = \"{prefix}\";");
            assert!(page.contains(&declared), "src/lib/errors.js should declare: {declared}");
        }
    }
}
