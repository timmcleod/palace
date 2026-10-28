//! Branches, merging and rebasing, plus continuing or aborting whatever operation a
//! repository is in the middle of. Every change runs the git CLI.

use crate::cli::git;
use git2::{Repository, RepositoryState};

/// The multi-step operation the repository is in the middle of, if any: "merge",
/// "rebase", "cherry-pick" or "revert".
pub(crate) fn operation(repo: &Repository) -> Option<&'static str> {
    match repo.state() {
        RepositoryState::Merge => Some("merge"),
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge
        | RepositoryState::ApplyMailboxOrRebase => Some("rebase"),
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => Some("cherry-pick"),
        RepositoryState::Revert | RepositoryState::RevertSequence => Some("revert"),
        _ => None,
    }
}

/// Checks out a ref. `kind` is how the sidebar names it: "branch", "remote-branch",
/// "tag" or "commit".
#[tauri::command]
pub async fn checkout(path: String, kind: String, name: String) -> Result<String, String> {
    match kind.as_str() {
        "branch" => {
            git(&path, &["switch", &name], None)?;
            Ok(format!("Switched to {name}."))
        }
        "remote-branch" => checkout_remote_branch(&path, &name),
        _ => {
            git(&path, &["switch", "--detach", &name], None)?;
            Ok(format!("Checked out {name}. HEAD is now detached; create a branch to keep any new commits."))
        }
    }
}

/// Checks out a remote branch as a local branch of the same name that tracks it,
/// reusing the local branch if one already exists.
fn checkout_remote_branch(path: &str, remote_branch: &str) -> Result<String, String> {
    let repo = open(path)?;
    let local = remote_branch.split_once('/').map(|(_, b)| b).unwrap_or(remote_branch);
    if repo.find_branch(local, git2::BranchType::Local).is_ok() {
        git(path, &["switch", local], None)?;
        return Ok(format!("Switched to {local}."));
    }
    git(path, &["switch", "--create", local, "--track", remote_branch], None)?;
    Ok(format!("Created {local}, tracking {remote_branch}, and switched to it."))
}

#[tauri::command]
pub async fn create_branch(
    path: String,
    name: String,
    start: Option<String>,
    checkout: bool,
) -> Result<String, String> {
    validate_branch_name(&path, &name)?;
    let mut args = if checkout { vec!["switch", "--create", &name] } else { vec!["branch", &name] };
    if let Some(start) = &start {
        // Don't set up tracking just because the starting point is a remote branch;
        // a new branch gets its upstream when it's first pushed.
        args.extend(["--no-track", start.as_str()]);
    }
    git(&path, &args, None)?;
    Ok(if checkout { format!("Created {name} and switched to it.") } else { format!("Created {name}.") })
}

#[tauri::command]
pub async fn rename_branch(path: String, old: String, new: String) -> Result<String, String> {
    validate_branch_name(&path, &new)?;
    git(&path, &["branch", "--move", &old, &new], None)?;
    Ok(format!("Renamed {old} to {new}."))
}

/// Deletes a local branch. Without `force`, git refuses to delete a branch whose
/// commits aren't merged anywhere, and that refusal is returned as the error.
#[tauri::command]
pub async fn delete_branch(path: String, name: String, force: bool) -> Result<String, String> {
    git(&path, &["branch", if force { "-D" } else { "-d" }, &name], None)?;
    Ok(format!("Deleted {name}."))
}

/// Merges `branch` into the current branch.
#[tauri::command]
pub async fn merge(path: String, branch: String) -> Result<String, String> {
    let output = git(&path, &["merge", "--no-edit", &branch], None).map_err(|e| stopped_or(&path, e))?;
    Ok(if output.contains("Already up to date") {
        format!("Already up to date with {branch}.")
    } else {
        format!("Merged {branch}.")
    })
}

/// Rebases the current branch onto `onto`.
#[tauri::command]
pub async fn rebase(path: String, onto: String) -> Result<String, String> {
    let output = git(&path, &["rebase", &onto], None).map_err(|e| stopped_or(&path, e))?;
    Ok(if output.contains("is up to date") {
        format!("Already up to date with {onto}.")
    } else {
        format!("Rebased onto {onto}.")
    })
}

/// Continues, aborts or skips (rebase only) the operation in progress.
#[tauri::command]
pub async fn control_operation(path: String, action: String) -> Result<String, String> {
    let repo = open(&path)?;
    let operation = operation(&repo).ok_or("Nothing is in progress.")?;

    let args: Vec<&str> = match (operation, action.as_str()) {
        // A merge is finished by committing; MERGE_MSG already holds the message.
        ("merge", "continue") => vec!["commit", "--no-edit"],
        ("merge", "abort") => vec!["merge", "--abort"],
        // core.editor=true keeps each replayed commit's message without opening an editor.
        (op @ ("rebase" | "cherry-pick" | "revert"), "continue") => vec!["-c", "core.editor=true", op, "--continue"],
        (op @ ("rebase" | "cherry-pick" | "revert"), "abort") => vec![op, "--abort"],
        ("rebase", "skip") => vec!["-c", "core.editor=true", "rebase", "--skip"],
        _ => return Err(format!("Can't {action} a {operation}.")),
    };

    git(&path, &args, None).map_err(|e| stopped_or(&path, e))?;
    Ok(match action.as_str() {
        "abort" => format!("Aborted the {operation}."),
        _ if self::operation(&open(&path)?).is_some() => format!("The {operation} continued and stopped again."),
        _ => format!("Finished the {operation}."),
    })
}

/// When a merge or rebase stops for conflicts, git exits with an error, but the
/// operation is under way and waiting for the user. Say that instead of failing.
pub(crate) fn stopped_or(path: &str, error: String) -> String {
    let Ok(repo) = open(path) else { return error };
    let Some(operation) = operation(&repo) else { return error };
    let conflicts = repo.index().map(|i| i.conflicts().map(|c| c.count()).unwrap_or(0)).unwrap_or(0);
    if conflicts == 0 {
        return error;
    }
    let files = if conflicts == 1 { "1 file".to_string() } else { format!("{conflicts} files") };
    format!(
        "CONFLICT: The {operation} stopped because {files} conflicted. Resolve them in the working copy, then continue the {operation}, or abort it."
    )
}

fn validate_branch_name(path: &str, name: &str) -> Result<(), String> {
    git(path, &["check-ref-format", "--branch", name], None)
        .map(drop)
        .map_err(|_| format!("“{name}” isn't a valid branch name."))
}

fn open(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| e.message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    // Commands are async for Tauri; tests just run them to completion.
    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn branches(t: &TempRepo) -> Vec<String> {
        let mut names: Vec<String> = t
            .repo
            .branches(Some(git2::BranchType::Local))
            .unwrap()
            .map(|b| b.unwrap().0.name().unwrap().unwrap().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn creating_renaming_and_deleting_branches() {
        let t = TempRepo::new("branches");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let main = t.branch();

        run(create_branch(t.path().into(), "feature".into(), None, true)).unwrap();
        assert_eq!(t.branch(), "feature");
        run(rename_branch(t.path().into(), "feature".into(), "feature-2".into())).unwrap();
        assert_eq!(t.branch(), "feature-2");

        run(checkout(t.path().into(), "branch".into(), main.clone())).unwrap();
        run(delete_branch(t.path().into(), "feature-2".into(), false)).unwrap();
        assert_eq!(branches(&t), [main]);

        let invalid = run(create_branch(t.path().into(), "bad..name".into(), None, false)).unwrap_err();
        assert!(invalid.contains("isn't a valid branch name"), "{invalid}");
    }

    #[test]
    fn deleting_an_unmerged_branch_needs_force() {
        let t = TempRepo::new("delete-unmerged");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let main = t.branch();
        run(create_branch(t.path().into(), "work".into(), None, true)).unwrap();
        t.commit(&[("b.txt", Some("b\n"))], "Unmerged work");
        run(checkout(t.path().into(), "branch".into(), main)).unwrap();

        let refused = run(delete_branch(t.path().into(), "work".into(), false)).unwrap_err();
        assert!(refused.contains("not fully merged"), "{refused}");
        run(delete_branch(t.path().into(), "work".into(), true)).unwrap();
    }

    #[test]
    fn checking_out_a_remote_branch_creates_a_tracking_branch() {
        let server = TempRepo::bare("remote-checkout-server");
        let t = TempRepo::new("remote-checkout");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        t.repo.remote("origin", server.path()).unwrap();
        git(t.path(), &["push", "origin", "HEAD:refs/heads/shared"], None).unwrap();
        git(t.path(), &["fetch", "origin"], None).unwrap();

        let message = run(checkout(t.path().into(), "remote-branch".into(), "origin/shared".into())).unwrap();
        assert!(message.contains("tracking origin/shared"), "{message}");
        assert_eq!(t.branch(), "shared");
        let upstream = t.repo.find_branch("shared", git2::BranchType::Local).unwrap().upstream().unwrap();
        assert_eq!(upstream.name().unwrap(), Some("origin/shared"));
    }

    #[test]
    fn checking_out_a_tag_detaches_head() {
        let t = TempRepo::new("tag-checkout");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        git(t.path(), &["tag", "v1"], None).unwrap();
        t.commit(&[("b.txt", Some("b\n"))], "Second");

        run(checkout(t.path().into(), "tag".into(), "v1".into())).unwrap();
        assert!(t.repo.head_detached().unwrap());
    }

    /// A repository where `theirs` and the main branch both changed a.txt's only line.
    fn conflicting(name: &str) -> (TempRepo, String) {
        let t = TempRepo::new(name);
        t.commit(&[("a.txt", Some("base\n"))], "Base");
        let main = t.branch();
        run(create_branch(t.path().into(), "theirs".into(), None, true)).unwrap();
        t.commit(&[("a.txt", Some("theirs\n"))], "Their change");
        run(checkout(t.path().into(), "branch".into(), main.clone())).unwrap();
        t.commit(&[("a.txt", Some("ours\n"))], "Our change");
        (t, main)
    }

    #[test]
    fn a_clean_merge_finishes_immediately() {
        let t = TempRepo::new("merge-clean");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let main = t.branch();
        run(create_branch(t.path().into(), "feature".into(), None, true)).unwrap();
        t.commit(&[("b.txt", Some("b\n"))], "Feature");
        run(checkout(t.path().into(), "branch".into(), main)).unwrap();

        assert_eq!(run(merge(t.path().into(), "feature".into())).unwrap(), "Merged feature.");
        assert!(t.dir.join("b.txt").exists());
        assert_eq!(operation(&t.repo), None);
    }

    #[test]
    fn a_conflicted_merge_waits_and_can_be_aborted_or_finished() {
        let (t, _) = conflicting("merge-conflict");

        let stopped = run(merge(t.path().into(), "theirs".into())).unwrap_err();
        assert!(stopped.starts_with("CONFLICT: The merge stopped because 1 file conflicted"), "{stopped}");
        assert_eq!(operation(&t.repo), Some("merge"));

        run(control_operation(t.path().into(), "abort".into())).unwrap();
        assert_eq!(operation(&t.repo), None);
        assert_eq!(std::fs::read_to_string(t.dir.join("a.txt")).unwrap(), "ours\n");

        run(merge(t.path().into(), "theirs".into())).unwrap_err();
        std::fs::write(t.dir.join("a.txt"), "both\n").unwrap();
        git(t.path(), &["add", "a.txt"], None).unwrap();
        let finished = run(control_operation(t.path().into(), "continue".into())).unwrap();
        assert_eq!(finished, "Finished the merge.");
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
    }

    #[test]
    fn a_conflicted_rebase_continues_with_the_original_message() {
        let (t, main) = conflicting("rebase-conflict");
        run(checkout(t.path().into(), "branch".into(), "theirs".into())).unwrap();

        let stopped = run(rebase(t.path().into(), main)).unwrap_err();
        assert!(stopped.starts_with("CONFLICT: The rebase stopped"), "{stopped}");
        assert_eq!(operation(&t.repo), Some("rebase"));

        std::fs::write(t.dir.join("a.txt"), "both\n").unwrap();
        git(t.path(), &["add", "a.txt"], None).unwrap();
        run(control_operation(t.path().into(), "continue".into())).unwrap();

        assert_eq!(operation(&t.repo), None);
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap().trim_end(), "Their change");
        assert_eq!(head.parent(0).unwrap().message().unwrap().trim_end(), "Our change");
        assert_eq!(t.branch(), "theirs");
    }
}
