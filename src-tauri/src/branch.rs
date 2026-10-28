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

/// Applies the changes commit `id` made on top of the current branch, as a new commit.
#[tauri::command]
pub async fn cherry_pick(path: String, id: String) -> Result<String, String> {
    apply_commit(&path, "cherry-pick", &id)?;
    Ok(format!("Cherry-picked {}.", short(&id)))
}

/// Adds a commit that undoes the changes commit `id` made.
#[tauri::command]
pub async fn revert(path: String, id: String) -> Result<String, String> {
    apply_commit(&path, "revert", &id)?;
    Ok(format!("Reverted {}.", short(&id)))
}

/// Runs `git cherry-pick` or `git revert` for one commit. A merge commit's changes
/// are taken relative to its first parent, the branch it was merged into.
fn apply_commit(path: &str, operation: &str, id: &str) -> Result<(), String> {
    let merge = open(path)?
        .revparse_single(id)
        .and_then(|o| o.peel_to_commit())
        .map(|c| c.parent_count() > 1)
        .map_err(|e| e.message().to_string())?;
    let mut args = vec![operation, "--no-edit"];
    if merge {
        args.extend(["-m", "1"]);
    }
    args.push(id);

    match git(path, &args, None) {
        Ok(_) => Ok(()),
        // The branch already has these changes (or already lacks them, for a revert).
        // Git stops with nothing to commit; skip the empty commit and say so.
        Err(e) if e.contains("is now empty") || e.contains("nothing to commit") => {
            if operation_in_progress(path) {
                let _ = git(path, &[operation, "--skip"], None);
            }
            Err(if operation == "revert" {
                format!("Nothing to revert: the changes from {} aren't on this branch.", short(id))
            } else {
                format!("Nothing to cherry-pick: the changes from {} are already on this branch.", short(id))
            })
        }
        Err(e) => Err(stopped_or(path, e)),
    }
}

fn operation_in_progress(path: &str) -> bool {
    open(path).map(|repo| operation(&repo).is_some()).unwrap_or(false)
}

fn short(id: &str) -> &str {
    &id[..id.len().min(7)]
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

    #[test]
    fn cherry_picking_and_reverting() {
        let t = TempRepo::new("pick");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-c", "feature"], None).unwrap();
        let feature = t.commit(&[("f.txt", Some("f\n"))], "Feature").to_string();
        git(t.path(), &["switch", &main], None).unwrap();

        let message = run(cherry_pick(t.path().into(), feature.clone())).unwrap();
        assert_eq!(message, format!("Cherry-picked {}.", &feature[..7]));
        assert!(t.dir.join("f.txt").exists());
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Feature"));

        // Picking it again would change nothing.
        let empty = run(cherry_pick(t.path().into(), feature)).unwrap_err();
        assert!(empty.starts_with("Nothing to cherry-pick"), "{empty}");
        assert!(operation(&t.repo).is_none());

        let picked = head.id().to_string();
        run(revert(t.path().into(), picked.clone())).unwrap();
        assert!(!t.dir.join("f.txt").exists());
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert!(head.summary().unwrap().unwrap().starts_with("Revert"), "{:?}", head.summary());
    }

    #[test]
    fn a_conflicting_cherry_pick_waits_for_the_user() {
        let t = TempRepo::new("pick-conflict");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-c", "feature"], None).unwrap();
        let feature = t.commit(&[("a.txt", Some("theirs\n"))], "Theirs").to_string();
        git(t.path(), &["switch", &main], None).unwrap();
        t.commit(&[("a.txt", Some("ours\n"))], "Ours");

        let stopped = run(cherry_pick(t.path().into(), feature)).unwrap_err();
        assert!(stopped.starts_with("CONFLICT: The cherry-pick stopped because 1 file conflicted"), "{stopped}");
        run(control_operation(t.path().into(), "abort".into())).unwrap();
        assert!(operation(&t.repo).is_none());
    }

    #[test]
    fn reverting_a_merge_undoes_what_it_brought_in() {
        let t = TempRepo::new("revert-merge");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let main = t.branch();
        // Committed with the git CLI throughout, as a real merge would be.
        let commit = |file: &str, message: &str| {
            t.write(&[(file, Some("x\n"))]);
            git(t.path(), &["add", file], None).unwrap();
            git(t.path(), &["commit", "-m", message], None).unwrap();
        };
        git(t.path(), &["switch", "-c", "feature"], None).unwrap();
        commit("f.txt", "Feature");
        git(t.path(), &["switch", &main], None).unwrap();
        commit("m.txt", "Main");
        git(t.path(), &["merge", "--no-edit", "feature"], None).unwrap();
        let merge = t.head().to_string();

        run(revert(t.path().into(), merge)).unwrap();
        assert!(!t.dir.join("f.txt").exists());
        assert!(t.dir.join("m.txt").exists());
    }
}
