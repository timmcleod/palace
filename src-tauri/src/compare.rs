//! Comparing two revisions: how many commits each has that the other doesn't, and the
//! changes `head` would bring to `base`.
//!
//! Like a pull request, the changes are those made on `head` since it split from
//! `base` (`git diff base...head`), so work that landed on `base` meanwhile doesn't
//! show up as being undone.

use crate::commit::{ChangedFile, FileDiff, changed_files, file_diff_at, tree_diff};
use git2::{Commit, Diff, Repository};
use serde::Serialize;

#[derive(Serialize)]
pub struct Comparison {
    base_id: String,
    head_id: String,
    /// Where the two split; None when they share no history.
    merge_base: Option<String>,
    /// Commits on `head` that `base` doesn't have.
    ahead: usize,
    /// Commits on `base` that `head` doesn't have.
    behind: usize,
    files: Vec<ChangedFile>,
    additions: usize,
    deletions: usize,
}

#[tauri::command]
pub async fn compare(path: String, base: String, head: String) -> Result<Comparison, String> {
    read_comparison(&path, &base, &head).map_err(|e| e.message().to_string())
}

/// The diff of one file in a comparison. `index` is the file's position in the
/// `files` list returned by `compare`.
#[tauri::command]
pub async fn compare_file_diff(
    path: String,
    base: String,
    head: String,
    index: usize,
    max_lines: Option<usize>,
) -> Result<FileDiff, String> {
    read_file_diff(&path, &base, &head, index, max_lines).map_err(|e| e.message().to_string())
}

fn read_comparison(path: &str, base: &str, head: &str) -> Result<Comparison, git2::Error> {
    let repo = Repository::discover(path)?;
    let (base, head) = (resolve(&repo, base)?, resolve(&repo, head)?);
    let merge_base = repo.merge_base(base.id(), head.id()).ok();
    let (ahead, behind) = repo.graph_ahead_behind(head.id(), base.id())?;
    let files = changed_files(&changes(&repo, &base, &head)?)?;
    Ok(Comparison {
        base_id: base.id().to_string(),
        head_id: head.id().to_string(),
        merge_base: merge_base.map(|id| id.to_string()),
        ahead,
        behind,
        additions: files.iter().map(|f| f.additions).sum(),
        deletions: files.iter().map(|f| f.deletions).sum(),
        files,
    })
}

fn read_file_diff(path: &str, base: &str, head: &str, index: usize, max_lines: Option<usize>) -> Result<FileDiff, git2::Error> {
    let repo = Repository::discover(path)?;
    let (base, head) = (resolve(&repo, base)?, resolve(&repo, head)?);
    let diff = changes(&repo, &base, &head)?;
    file_diff_at(&repo, &diff, index, max_lines)
}

fn resolve<'r>(repo: &'r Repository, rev: &str) -> Result<Commit<'r>, git2::Error> {
    repo.revparse_single(rev)
        .and_then(|o| o.peel_to_commit())
        .map_err(|_| git2::Error::from_str(&format!("There's no branch, tag or commit called “{rev}”.")))
}

/// What `head` changed since it split from `base`. Unrelated histories have no such
/// point, so they're compared directly.
fn changes<'r>(repo: &'r Repository, base: &Commit, head: &Commit) -> Result<Diff<'r>, git2::Error> {
    let from = match repo.merge_base(base.id(), head.id()) {
        Ok(id) => repo.find_commit(id)?,
        Err(_) => base.clone(),
    };
    tree_diff(repo, Some(&from.tree()?), &head.tree()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    #[test]
    fn compares_from_where_the_branches_split() {
        let t = TempRepo::new("compare");
        t.commit(&[("a.txt", Some("one\n"))], "First");
        let main = t.branch();
        git(&t, &["switch", "-q", "-c", "feature"]);
        t.commit(&[("b.txt", Some("new\n"))], "Add b");
        t.commit(&[("a.txt", Some("one\ntwo\n"))], "Change a");
        git(&t, &["switch", "-q", &main]);
        // On main since the split; not one of feature's changes.
        t.commit(&[("c.txt", Some("main only\n"))], "Add c");

        let c = read_comparison(t.path(), &main, "feature").unwrap();
        assert_eq!((c.ahead, c.behind), (2, 1));
        let files: Vec<_> = c.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files, ["a.txt", "b.txt"]);
        assert_eq!((c.additions, c.deletions), (2, 0));

        let diff = read_file_diff(t.path(), &main, "feature", 0, None).unwrap();
        assert!(diff.hunks[0].lines.iter().any(|l| l.kind == '+' && l.text == "two"));

        // The other way round, only main's commit is new.
        let c = read_comparison(t.path(), "feature", &main).unwrap();
        assert_eq!((c.ahead, c.behind), (1, 2));
        assert_eq!(c.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["c.txt"]);
    }

    #[test]
    fn an_unknown_revision_says_so() {
        let t = TempRepo::new("compare-unknown");
        t.commit(&[("a.txt", Some("one\n"))], "First");
        let error = read_comparison(t.path(), "HEAD", "nope").err().unwrap();
        assert_eq!(error.message(), "There's no branch, tag or commit called “nope”.");
    }

    fn git(t: &TempRepo, args: &[&str]) {
        crate::cli::git(t.path(), args, None).unwrap();
    }
}
