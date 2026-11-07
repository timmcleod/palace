//! Commits a branch has lost: when, outside Palace, a branch is moved back, as by
//! `git reset --hard`, or deleted, its commits that nothing else has go with it, and git
//! keeps them only in its reflog until it clears them away. The page asks about each
//! branch that moved back or went, and says so while they can still be had back (see
//! lostCommits.js).
//!
//! A branch rewritten (amended, rebased, squashed) leaves its old commits behind too,
//! but what they held lives on in the new ones, so that isn't counted: only a branch
//! moved back to a commit it already had, or deleted.

use git2::{Oid, Repository, Revwalk};
use std::path::Path;

/// The most counted, as a branch deleted from a long history could leave a great many.
const MOST: usize = 1000;

/// How many commits the branch that was at `old` left on nothing else, now that it's at
/// `new`, or with None, gone: 0 when it moved forward, or was rewritten, rather than
/// moved back, and up to a thousand otherwise.
///
/// A branch reset back and then committed on before Palace looks again isn't counted:
/// its new tip doesn't descend from where it went back to, so it looks rewritten. The
/// branch's reflog could tell them apart, at the cost of reading it each time.
#[tauri::command]
pub async fn commits_left_behind(path: String, old: String, new: Option<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = Repository::discover(Path::new(&path)).map_err(|e| e.message().to_string())?;
        left_behind(&repo, &old, new.as_deref()).map_err(|e| e.message().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn left_behind(repo: &Repository, old: &str, new: Option<&str>) -> Result<usize, git2::Error> {
    let old = Oid::from_str(old)?;
    // Gone already, as git cleared it away: nothing to have back.
    if repo.find_commit(old).is_err() {
        return Ok(0);
    }
    if let Some(new) = new {
        let new = Oid::from_str(new)?;
        // Moved back means to a commit it already had.
        if new == old || !repo.graph_descendant_of(old, new)? {
            return Ok(0);
        }
    }
    unkept(repo, old, true, MOST)
}

/// How many commits from `from`, back through its history, nothing else keeps, up to
/// `most`: no reference (branch, tag, remote branch, any stash, anything else under
/// refs/), no other worktree's HEAD, and with `own_head`, not this one's either. As for a
/// branch's lost commits, or what a detached HEAD would leave behind (branch.rs).
pub(crate) fn unkept(repo: &Repository, from: Oid, own_head: bool, most: usize) -> Result<usize, git2::Error> {
    let mut walk = repo.revwalk()?;
    walk.push(from)?;
    hide_kept(repo, &mut walk, own_head)?;
    Ok(walk.take(most).filter(Result::is_ok).count())
}

fn hide_kept(repo: &Repository, walk: &mut Revwalk, own_head: bool) -> Result<(), git2::Error> {
    // A reference may name a tag object, or be one that can't be read: it keeps the
    // commit it comes to, if any.
    for reference in repo.references()?.flatten() {
        if let Ok(commit) = reference.peel_to_commit() {
            walk.hide(commit.id())?;
        }
    }
    // Each stash, not only the newest, which is all refs/stash names.
    if let Ok(stashes) = repo.reflog("refs/stash") {
        for entry in stashes.iter() {
            let _ = walk.hide(entry.id_new());
        }
    }
    let mut heads = Vec::new();
    if own_head && let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) {
        heads.push(head.id());
    }
    // Another worktree's HEAD, detached, keeps what it's on.
    let names = repo.worktrees()?;
    for name in names.iter().flatten().flatten() {
        let head = repo
            .find_worktree(name)
            .and_then(|w| Repository::open_from_worktree(&w))
            .and_then(|r| r.head().and_then(|h| h.peel_to_commit()).map(|c| c.id()));
        if let Ok(head) = head {
            heads.push(head);
        }
    }
    for head in heads {
        walk.hide(head)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::git_in;
    use crate::test_support::TempRepo;

    // main with three commits, as `git log` lists them: a, then b, then c.
    fn three_commits(name: &str) -> (TempRepo, Oid, Oid, Oid) {
        let t = TempRepo::new(name);
        let a = t.commit(&[("a.txt", Some("a\n"))], "a");
        let b = t.commit(&[("b.txt", Some("b\n"))], "b");
        let c = t.commit(&[("c.txt", Some("c\n"))], "c");
        (t, a, b, c)
    }

    fn count(t: &TempRepo, old: Oid, new: Option<Oid>) -> usize {
        left_behind(&t.repo, &old.to_string(), new.map(|n| n.to_string()).as_deref()).unwrap()
    }

    #[test]
    fn counting_what_a_branch_moved_back_left_on_nothing_else() {
        let (t, a, _, c) = three_commits("lost-reset");
        git_in(Path::new(t.path()), &["reset", "-q", "--hard", &a.to_string()]).unwrap();
        assert_eq!(count(&t, c, Some(a)), 2);
        // Kept by a tag, it isn't lost.
        git_in(Path::new(t.path()), &["tag", "kept", &c.to_string()]).unwrap();
        assert_eq!(count(&t, c, Some(a)), 0);
    }

    #[test]
    fn not_counting_what_a_rewrite_or_a_step_forward_leaves() {
        let (t, a, b, c) = three_commits("lost-rewrite");
        // Forward: nothing left behind.
        assert_eq!(count(&t, b, Some(c)), 0);
        // Amended: the old commit's left, but what it held lives on in the new one.
        git_in(Path::new(t.path()), &["commit", "-q", "--amend", "-m", "c, reworded"]).unwrap();
        assert_eq!(count(&t, c, Some(t.head())), 0);
        // Unmoved: nothing.
        assert_eq!(count(&t, a, Some(a)), 0);
    }

    #[test]
    fn counting_what_an_annotated_tag_keeps_as_kept() {
        let (t, a, _, c) = three_commits("lost-kept");
        // An annotated tag names a tag object, which names the commit.
        git_in(Path::new(t.path()), &["tag", "-a", "-m", "kept", "release", &c.to_string()]).unwrap();
        git_in(Path::new(t.path()), &["reset", "-q", "--hard", &a.to_string()]).unwrap();
        assert_eq!(count(&t, c, Some(a)), 0);
    }

    #[test]
    fn counting_what_an_older_stash_keeps_as_kept() {
        let (t, a, _, c) = three_commits("lost-stash");
        let dir = Path::new(t.path());
        // A stash made on c, then a newer one made after going back to a: only the
        // older keeps c.
        t.write(&[("c.txt", Some("changed\n"))]);
        git_in(dir, &["stash", "-q"]).unwrap();
        git_in(dir, &["reset", "-q", "--hard", &a.to_string()]).unwrap();
        t.write(&[("a.txt", Some("changed\n"))]);
        git_in(dir, &["stash", "-q"]).unwrap();
        assert_eq!(count(&t, c, Some(a)), 0);
        // Dropped, it no longer does.
        git_in(dir, &["stash", "drop", "-q", "stash@{1}"]).unwrap();
        assert_eq!(count(&t, c, Some(a)), 2);
    }

    #[test]
    fn counting_what_a_branch_deleted_left_on_nothing_else() {
        let (t, a, _, c) = three_commits("lost-deleted");
        let main = t.branch();
        git_in(Path::new(t.path()), &["checkout", "-q", "-b", "other", &a.to_string()]).unwrap();
        git_in(Path::new(t.path()), &["branch", "-q", "-D", &main]).unwrap();
        assert_eq!(count(&t, c, None), 2);
    }
}
