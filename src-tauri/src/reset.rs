//! Resetting HEAD, and the branch it's on, to another commit.

use crate::cli::git;
use git2::{BranchType, Oid, Repository};
use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct ResetPreview {
    short_id: String,
    summary: String,
    /// Commits on HEAD that the reset takes off the branch.
    rolled_back: usize,
    /// How many of those are on the branch's upstream already, so the branch would
    /// need force pushing afterwards.
    pushed: usize,
}

/// What resetting `branch` (HEAD's when omitted) to `revision` would do, for the
/// Reset dialog.
#[tauri::command]
pub async fn reset_preview(path: String, revision: String, branch: Option<String>) -> Result<ResetPreview, String> {
    let repo = Repository::discover(&path).map_err(|e| e.message().to_string())?;
    let target = resolve(&repo, &revision)?;
    let commit = repo.find_commit(target).map_err(|e| e.message().to_string())?;

    let tip = match &branch {
        Some(name) => Some(local_branch(&repo, name)?.get().target().ok_or("That branch doesn't point at a commit.")?),
        None => repo.head().ok().and_then(|h| h.target()),
    };
    let mut rolled_back = Vec::new();
    if let Some(head) = tip {
        let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
        walk.push(head).and_then(|_| walk.hide(target)).map_err(|e| e.message().to_string())?;
        rolled_back = walk.flatten().collect();
    }
    let upstream = match &branch {
        Some(name) => local_branch(&repo, name)?.upstream().ok().and_then(|u| u.get().target()),
        None => upstream_tip(&repo),
    };
    let pushed = rolled_back
        .iter()
        .filter(|oid| upstream.is_some_and(|u| u == **oid || repo.graph_descendant_of(u, **oid).unwrap_or(false)))
        .count();

    Ok(ResetPreview {
        short_id: target.to_string()[..7].to_string(),
        summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
        rolled_back: rolled_back.len(),
        pushed,
    })
}

/// Moves HEAD (and the current branch) to `revision`. With `keep_changes`, the
/// changes of the commits rolled back stay in the working copy, uncommitted
/// (`git reset --mixed`); without, they're dropped (`git reset --keep`). Either way,
/// uncommitted changes are kept; if dropping would overwrite one, nothing is reset.
#[tauri::command]
pub async fn reset(path: String, revision: String, keep_changes: bool) -> Result<String, String> {
    let repo = Repository::discover(&path).map_err(|e| e.message().to_string())?;
    let target = resolve(&repo, &revision)?.to_string();
    let mode = if keep_changes { "--mixed" } else { "--keep" };
    git(&path, &["reset", "--quiet", mode, &target], None).map_err(|e| explain(&e))?;

    let head = repo.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().ok().map(str::to_string));
    Ok(format!("Reset {} to {}.", head.unwrap_or_else(|| "HEAD".into()), &target[..7]))
}

/// Moves `branch`, which isn't checked out, to `revision`. Only the branch moves:
/// the working copy belongs to the branch that is checked out.
#[tauri::command]
pub async fn reset_branch(path: String, branch: String, revision: String) -> Result<String, String> {
    let repo = Repository::discover(&path).map_err(|e| e.message().to_string())?;
    if local_branch(&repo, &branch)?.is_head() {
        return Err(format!("{branch} is checked out; reset it with its working copy instead."));
    }
    let target = resolve(&repo, &revision)?.to_string();
    git(&path, &["branch", "--force", &branch, &target], None)?;
    Ok(format!("Reset {branch} to {}.", &target[..7]))
}

fn local_branch<'r>(repo: &'r Repository, name: &str) -> Result<git2::Branch<'r>, String> {
    repo.find_branch(name, BranchType::Local).map_err(|_| format!("There's no branch called {name}."))
}

fn resolve(repo: &Repository, revision: &str) -> Result<Oid, String> {
    repo.revparse_single(revision.trim())
        .and_then(|object| object.peel_to_commit())
        .map(|commit| commit.id())
        .map_err(|_| format!("“{}” isn't a branch, tag or commit in this repository.", revision.trim()))
}

/// Where the current branch's upstream is, if it has one.
fn upstream_tip(repo: &Repository) -> Option<Oid> {
    let head = repo.head().ok().filter(|h| h.is_branch())?;
    let name = head.shorthand().ok()?;
    repo.find_branch(name, BranchType::Local).ok()?.upstream().ok()?.get().target()
}

/// `git reset --keep` refuses when it would overwrite uncommitted changes, naming
/// each file as "Entry 'path' not uptodate".
fn explain(error: &str) -> String {
    let files: Vec<&str> = error
        .lines()
        .filter_map(|line| line.split_once("Entry '")?.1.split_once('\'').map(|(file, _)| file))
        .collect();
    if files.is_empty() {
        return error.to_string();
    }
    format!(
        "Nothing was reset: it would overwrite your uncommitted changes to {}. Commit or stash them first, or keep the changes.",
        files.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;
    use tauri::async_runtime::block_on as run;

    #[test]
    fn keeping_changes_leaves_them_uncommitted() {
        let t = TempRepo::new("reset-keep");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        t.commit(&[("b.txt", Some("2\n"))], "Second");
        t.write(&[("a.txt", Some("edited\n"))]);

        let preview = run(reset_preview(t.path().into(), first.to_string(), None)).unwrap();
        assert_eq!((preview.rolled_back, preview.pushed), (1, 0));

        let message = run(reset(t.path().into(), first.to_string(), true)).unwrap();
        assert_eq!(message, format!("Reset {} to {}.", t.branch(), &first.to_string()[..7]));
        assert_eq!(t.head(), first);
        // The rolled back commit's file is still there, and so is the edit.
        assert_eq!(std::fs::read_to_string(t.dir.join("b.txt")).unwrap(), "2\n");
        assert_eq!(std::fs::read_to_string(t.dir.join("a.txt")).unwrap(), "edited\n");
    }

    #[test]
    fn dropping_changes_keeps_uncommitted_work_or_refuses() {
        let t = TempRepo::new("reset-drop");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let second = t.commit(&[("b.txt", Some("2\n"))], "Second");

        // An uncommitted edit the reset doesn't touch survives it.
        t.write(&[("a.txt", Some("edited\n"))]);
        run(reset(t.path().into(), first.to_string(), false)).unwrap();
        assert_eq!(t.head(), first);
        assert!(!t.dir.join("b.txt").exists());
        assert_eq!(std::fs::read_to_string(t.dir.join("a.txt")).unwrap(), "edited\n");

        // One it would overwrite stops it.
        run(reset(t.path().into(), second.to_string(), true)).unwrap();
        t.write(&[("b.txt", Some("mine\n"))]);
        let refused = run(reset(t.path().into(), first.to_string(), false)).unwrap_err();
        assert!(refused.starts_with("Nothing was reset: it would overwrite your uncommitted changes to b.txt."), "{refused}");
        assert_eq!(t.head(), second);
    }

    #[test]
    fn previewing_counts_pushed_commits() {
        let server = TempRepo::bare("reset-server");
        let local = TempRepo::clone_of("reset-local", &server);
        let first = local.commit(&[("a.txt", Some("1\n"))], "First");
        local.commit(&[("b.txt", Some("2\n"))], "Pushed");
        git(local.path(), &["push", "-u", "origin", "HEAD"], None).unwrap();
        local.commit(&[("c.txt", Some("3\n"))], "Not pushed");

        let preview = run(reset_preview(local.path().into(), first.to_string(), None)).unwrap();
        assert_eq!((preview.rolled_back, preview.pushed), (2, 1));
        assert!(run(reset_preview(local.path().into(), "nope".into(), None)).is_err());
    }

    #[test]
    fn resetting_a_branch_that_isnt_checked_out_leaves_the_working_copy() {
        let t = TempRepo::new("reset-other");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        t.commit(&[("f.txt", Some("f\n"))], "Feature");
        git(t.path(), &["switch", "-q", &main], None).unwrap();
        let head = t.commit(&[("m.txt", Some("m\n"))], "Main");
        t.write(&[("a.txt", Some("edited\n"))]);

        let preview = run(reset_preview(t.path().into(), first.to_string(), Some("feature".into()))).unwrap();
        assert_eq!(preview.rolled_back, 1);
        let message = run(reset_branch(t.path().into(), "feature".into(), first.to_string())).unwrap();
        assert_eq!(message, format!("Reset feature to {}.", &first.to_string()[..7]));
        let feature = t.repo.find_branch("feature", BranchType::Local).unwrap().get().target().unwrap();
        assert_eq!(feature, first);
        // HEAD's branch and the working copy are as they were.
        assert_eq!((t.branch(), t.head()), (main.clone(), head));
        assert_eq!(std::fs::read_to_string(t.dir.join("a.txt")).unwrap(), "edited\n");

        let refused = run(reset_branch(t.path().into(), main, first.to_string())).unwrap_err();
        assert!(refused.contains("is checked out"), "{refused}");
    }
}
