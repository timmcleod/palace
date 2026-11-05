//! Worktrees: more working copies of the same repository, each with a branch of its
//! own checked out, added with `git worktree add`. They share the repository's
//! branches, tags and commits, so a branch checked out in one can't be in another.

use crate::cli::git;
use git2::{Repository, WorktreeLockStatus};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct Worktree {
    /// Its folder.
    pub path: String,
    /// The branch checked out in it, or None with HEAD detached.
    pub branch: Option<String>,
    /// Whether it's the repository's own working copy, rather than one added to it.
    pub main: bool,
    /// Whether it's the one open.
    pub current: bool,
    /// Whether it's locked against being pruned or removed, as for one on a drive that
    /// isn't always there.
    pub locked: bool,
    /// Whether its folder is gone, so `git worktree prune` would forget it.
    pub prunable: bool,
}

/// The repository's worktrees, its own first, or none when it has only that one.
pub(crate) fn read_worktrees(repo: &Repository) -> Vec<Worktree> {
    let Ok(names) = repo.worktrees() else { return Vec::new() };
    if names.is_empty() {
        return Vec::new();
    }
    let here = repo.workdir().map(tidy);
    let mut list = Vec::new();

    // The repository's own working copy: the folder its shared .git is in.
    let common = repo.commondir();
    if let Some(main) = common.parent().filter(|_| common.file_name().is_some_and(|n| n == ".git")) {
        let path = tidy(main);
        let branch = Repository::open(main).ok().and_then(|r| branch_of(&r));
        list.push(Worktree { current: here.as_ref() == Some(&path), path: show(&path), branch, main: true, locked: false, prunable: false });
    }

    for name in names.iter().flatten().flatten() {
        let Ok(worktree) = repo.find_worktree(name) else { continue };
        let path = tidy(worktree.path());
        let prunable = worktree.validate().is_err();
        let branch = if prunable { None } else { Repository::open_from_worktree(&worktree).ok().and_then(|r| branch_of(&r)) };
        list.push(Worktree {
            current: here.as_ref() == Some(&path),
            path: show(&path),
            branch,
            main: false,
            locked: matches!(worktree.is_locked(), Ok(WorktreeLockStatus::Locked(_))),
            prunable,
        });
    }
    list
}

fn branch_of(repo: &Repository) -> Option<String> {
    // A branch with no commits yet still names itself in HEAD.
    let head = repo.find_reference("HEAD").ok()?;
    head.symbolic_target().ok()??.strip_prefix("refs/heads/").map(str::to_string)
}

/// A folder as the overview names it: without a trailing separator, so the same folder
/// is always the same path.
fn tidy(path: &Path) -> PathBuf {
    path.components().collect()
}

fn show(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Adds a worktree at `folder`. With `create`, it's a new branch of that name, started
/// at `branch` (a branch, remote branch or commit); without, it checks out the local
/// branch `branch`, or for a remote branch, a new local branch tracking it.
#[tauri::command]
pub async fn add_worktree(path: String, folder: String, branch: String, create: Option<String>, remote: bool) -> Result<String, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("Choose a folder for the worktree.".into());
    }
    if Path::new(folder).exists() && Path::new(folder).read_dir().map_or(true, |mut d| d.next().is_some()) {
        return Err(format!("{folder} already exists and isn't empty. Choose a new folder for the worktree."));
    }
    match (create.as_deref().map(str::trim), remote) {
        (Some(name), _) => {
            crate::branch::validate_branch_name(&path, name)?;
            git(&path, &["worktree", "add", "-b", name, folder, &branch], None)?;
        }
        (None, true) => {
            let local = branch.split_once('/').map(|(_, b)| b).unwrap_or(&branch);
            git(&path, &["worktree", "add", "--track", "-b", local, folder, &branch], None)?;
        }
        (None, false) => {
            git(&path, &["worktree", "add", folder, &branch], None)?;
        }
    }
    Ok(format!("Added a worktree at {folder}."))
}

/// Removes the worktree at `worktree`: its folder, and the repository's note of it.
/// With `force`, even with changes in it that would be lost, or while it's locked.
#[tauri::command]
pub async fn remove_worktree(path: String, worktree: String, force: bool) -> Result<String, String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        // Twice, to remove a locked one too.
        args.extend(["--force", "--force"]);
    }
    args.push(&worktree);
    git(&path, &args, None)?;
    Ok(format!("Removed the worktree at {worktree}."))
}

/// Whether the worktree at `worktree` has changes that removing it would lose:
/// modified or untracked files.
#[tauri::command]
pub async fn worktree_has_changes(worktree: String) -> Result<bool, String> {
    let repo = Repository::open(&worktree).map_err(|e| e.message().to_string())?;
    Ok(!crate::working::read_status(&repo).map_err(|e| e.message().to_string())?.is_empty())
}

#[tauri::command]
pub async fn lock_worktree(path: String, worktree: String, lock: bool) -> Result<String, String> {
    git(&path, &["worktree", if lock { "lock" } else { "unlock" }, &worktree], None)?;
    Ok(if lock { "Locked the worktree." } else { "Unlocked the worktree." }.into())
}

/// Forgets worktrees whose folders are gone.
#[tauri::command]
pub async fn prune_worktrees(path: String) -> Result<String, String> {
    git(&path, &["worktree", "prune"], None)?;
    Ok("Forgot worktrees whose folders are gone.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    fn block<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn listing_adding_and_removing_worktrees() {
        let t = TempRepo::new("worktrees");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let main = t.branch();
        assert!(read_worktrees(&t.repo).is_empty());

        let folder = t.dir.with_file_name(format!("{}-feature", t.dir.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&folder);
        let folder_str = folder.to_string_lossy().into_owned();
        block(add_worktree(t.path().into(), folder_str.clone(), main.clone(), Some("feature".into()), false)).unwrap();

        let list = read_worktrees(&t.repo);
        assert_eq!(list.len(), 2);
        assert!(list[0].main && list[0].current);
        assert_eq!(list[0].branch.as_deref(), Some(main.as_str()));
        assert!(!list[1].main && !list[1].current && !list[1].locked);
        assert_eq!(list[1].branch.as_deref(), Some("feature"));
        // git notes its real path: on macOS, the temporary folder is reached through a link.
        assert_eq!(list[1].path, show(&tidy(&folder.canonicalize().unwrap())));

        // Seen from the worktree, it's the current one, and the main one is still first.
        let inside = Repository::open(&folder).unwrap();
        let list = read_worktrees(&inside);
        assert!(list[0].main && !list[0].current);
        assert!(list[1].current);

        block(lock_worktree(t.path().into(), folder_str.clone(), true)).unwrap();
        assert!(read_worktrees(&t.repo)[1].locked);

        // Changes in it, or its lock, stop a plain removal.
        std::fs::write(folder.join("new.txt"), "new\n").unwrap();
        assert!(block(worktree_has_changes(folder_str.clone())).unwrap());
        assert!(block(remove_worktree(t.path().into(), folder_str.clone(), false)).is_err());
        block(remove_worktree(t.path().into(), folder_str.clone(), true)).unwrap();
        assert!(!folder.exists());
        assert!(read_worktrees(&t.repo).is_empty());
    }

    #[test]
    fn a_worktree_whose_folder_is_gone_can_be_pruned() {
        let t = TempRepo::new("worktrees-prune");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let folder = t.dir.with_file_name(format!("{}-gone", t.dir.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&folder);
        let folder_str = folder.to_string_lossy().into_owned();
        block(add_worktree(t.path().into(), folder_str, t.branch(), Some("gone".into()), false)).unwrap();
        std::fs::remove_dir_all(&folder).unwrap();

        let list = read_worktrees(&t.repo);
        assert!(list[1].prunable);
        block(prune_worktrees(t.path().into())).unwrap();
        assert!(read_worktrees(&t.repo).is_empty());
    }

    #[test]
    fn adding_a_worktree_for_a_branch_checked_out_elsewhere_is_refused() {
        let t = TempRepo::new("worktrees-busy");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let folder = t.dir.with_file_name(format!("{}-busy", t.dir.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&folder);
        let refused = block(add_worktree(t.path().into(), folder.to_string_lossy().into_owned(), t.branch(), None, false));
        assert!(refused.is_err());
    }
}
