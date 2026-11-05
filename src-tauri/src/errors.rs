//! The prefixes that start an error the page acts on, rather than only shows. The
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
        ] {
            let declared = format!("export const {name} = \"{prefix}\";");
            assert!(page.contains(&declared), "src/lib/errors.js should declare: {declared}");
        }
    }
}
