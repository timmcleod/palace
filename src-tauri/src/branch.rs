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

/// How many commits a detached HEAD has that no branch, tag or remote branch has:
/// what checking out something else would leave behind.
#[tauri::command]
pub async fn commits_only_at_head(path: String) -> Result<usize, String> {
    let repo = open(&path)?;
    if !repo.head_detached().unwrap_or(false) {
        return Ok(0);
    }
    let head = repo.head().ok().and_then(|h| h.target()).ok_or("HEAD doesn't point at a commit.")?;
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.push(head).map_err(|e| e.message().to_string())?;
    for reference in repo.references().map_err(|e| e.message().to_string())?.flatten() {
        let kept = reference.is_branch() || reference.is_tag() || reference.is_remote();
        if let Some(id) = kept.then(|| reference.peel_to_commit().ok()).flatten().map(|c| c.id()) {
            walk.hide(id).map_err(|e| e.message().to_string())?;
        }
    }
    Ok(walk.count())
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

/// After `remote`'s branch `old` was renamed to `new` there, points the local branches
/// that tracked it at the new name, and renames a local branch called `old` to match,
/// unless `new` is taken. Says what changed locally, or nothing.
pub(crate) fn retrack(path: &str, remote: &str, old: &str, new: &str) -> Result<String, String> {
    let repo = open(path)?;
    let config = repo.config().and_then(|mut c| c.snapshot()).map_err(|e| e.message().to_string())?;
    let setting = |branch: &str, key: &str| config.get_string(&format!("branch.{branch}.{key}")).ok();
    let mut tracking = Vec::new();
    for (branch, _) in repo.branches(Some(git2::BranchType::Local)).map_err(|e| e.message().to_string())?.flatten() {
        let Ok(Some(name)) = branch.name() else { continue };
        if setting(name, "remote").as_deref() == Some(remote) && setting(name, "merge") == Some(format!("refs/heads/{old}")) {
            tracking.push(name.to_string());
        }
    }
    for branch in &tracking {
        git(path, &["config", &format!("branch.{branch}.merge"), &format!("refs/heads/{new}")], None)?;
    }
    let taken = repo.find_branch(new, git2::BranchType::Local).is_ok();
    if tracking.iter().any(|b| b == old) && !taken {
        git(path, &["branch", "--move", old, new], None)?;
        return Ok(format!("Renamed your local {old} to match."));
    }
    Ok(match tracking.as_slice() {
        [] => String::new(),
        [one] => format!("Your local {one} now tracks {remote}/{new}."),
        many => format!("Your local branches {} now track {remote}/{new}.", many.join(", ")),
    })
}

/// Deletes a local branch. Without `force`, git refuses to delete a branch whose
/// commits aren't merged anywhere, and that refusal is returned as the error.
#[tauri::command]
pub async fn delete_branch(path: String, name: String, force: bool) -> Result<String, String> {
    crate::undo::keep(&path, &format!("refs/heads/{name}"));
    git(&path, &["branch", if force { "-D" } else { "-d" }, &name], None)?;
    Ok(format!("Deleted {name}."))
}

/// Whether everything on local `branch` is in `commit`: its tip is that commit or one
/// before it. False when `commit` isn't here.
fn within(repo: &Repository, branch: &str, commit: &str) -> bool {
    let tip = repo.find_branch(branch, git2::BranchType::Local).ok().and_then(|b| b.get().target());
    let commit = git2::Oid::from_str(commit).ok().filter(|id| repo.find_commit(*id).is_ok());
    match (tip, commit) {
        (Some(tip), Some(commit)) => tip == commit || repo.graph_descendant_of(commit, tip).unwrap_or(false),
        _ => false,
    }
}

/// Whether local `branch` has nothing that isn't in `commit`, the head of a pull
/// request that was merged, so deleting it loses nothing.
#[tauri::command]
pub async fn branch_within(path: String, branch: String, commit: String) -> Result<bool, String> {
    Ok(within(&open(&path)?, &branch, &commit))
}

/// Deletes a branch whose pull request was merged, as long as everything on it was in
/// the merged `commit`. Forced, as a squash or rebase leaves it looking unmerged.
#[tauri::command]
pub async fn delete_merged_branch(path: String, name: String, commit: String) -> Result<String, String> {
    if !within(&open(&path)?, &name, &commit) {
        return Err(format!("{name} has commits that weren't in the pull request, so it's been kept."));
    }
    crate::undo::keep(&path, &format!("refs/heads/{name}"));
    git(&path, &["branch", "-D", &name], None)?;
    Ok(format!("Deleted {name}."))
}

/// Merges `branch` into the current branch.
#[tauri::command]
pub async fn merge(path: String, branch: String, options: Option<MergeOptions>) -> Result<String, String> {
    let options = options.unwrap_or_default();
    // Committing a squash commits everything staged, so changes already staged are set
    // aside first and put back after, still staged.
    if options.squash && options.commit.unwrap_or(true) && has_staged(&path)? {
        return squash_around_staged(&path, &branch);
    }
    let mut args = vec!["merge"];
    if options.autostash {
        args.push("--autostash");
    }
    if options.squash {
        args.push("--squash");
    } else {
        args.push("--no-edit");
        if options.no_ff {
            args.push("--no-ff");
        }
    }
    args.push(&branch);

    let stash = crate::stash::newest(&path);
    let output = git(&path, &args, None).map_err(|e| {
        if options.squash { squash_conflict_or(&path, &branch, e) } else { stopped_or(&path, e) }
    })?;
    let checked = |done: String| Ok(crate::stash::unless_left_behind(&path, stash.clone(), done));
    if output.contains("Already up to date") {
        return checked(format!("Already up to date with {branch}."));
    }
    if !options.squash {
        return checked(if output.contains("Fast-forward") {
            format!("Fast-forwarded to {branch}.")
        } else {
            format!("Merged {branch}.")
        });
    }
    // Conflicted files can't be committed, so the squash waits for them too.
    if !options.commit.unwrap_or(true) || crate::stash::newest(&path) != stash {
        return checked(format!("Staged the changes from {branch}. Commit them when you're ready."));
    }
    // Git has written a message listing the squashed commits; commit with it.
    git(&path, &["commit", "--no-edit"], None)?;
    Ok(format!("Squashed {branch} into one commit."))
}

fn has_staged(path: &str) -> Result<bool, String> {
    Ok(git(path, &["diff", "--cached", "--quiet"], None).is_err() && git(path, &["rev-parse", "--verify", "-q", "HEAD"], None).is_ok())
}

fn squash_around_staged(path: &str, branch: &str) -> Result<String, String> {
    git(path, &["stash", "push", "-q", "-m", &format!("Staged before squashing {branch}")], None)?;
    let kept = "Your changes from before are in the stash list; apply it once you're done.";
    let output = match git(path, &["merge", "--squash", branch], None) {
        Ok(output) => output,
        Err(e) => {
            let error = squash_conflict_or(path, branch, e);
            if error.starts_with("CONFLICT: ") {
                return Err(format!("{error} {kept}"));
            }
            // Nothing changed: put them straight back.
            return Err(match git(path, &["stash", "pop", "-q", "--index"], None) {
                Ok(_) => error,
                Err(_) => format!("{error}\n\n{kept}"),
            });
        }
    };
    if output.contains("Already up to date") || git(path, &["diff", "--cached", "--quiet"], None).is_ok() {
        git(path, &["stash", "pop", "-q", "--index"], None)?;
        return Ok(format!("Already up to date with {branch}."));
    }
    git(path, &["commit", "--no-edit"], None).map_err(|e| format!("{e}\n\n{kept}"))?;
    match git(path, &["stash", "pop", "-q", "--index"], None) {
        Ok(_) => Ok(format!("Squashed {branch} into one commit. Your staged changes are still staged.")),
        Err(_) => Ok(format!("Squashed {branch} into one commit. Your changes from before didn't go back cleanly, so they're in the stash list.")),
    }
}

/// Choices from the Merge dialog. Without them, a plain `git merge`.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct MergeOptions {
    /// Apply the branch's changes as one set of changes, not a merge.
    squash: bool,
    /// Make a merge commit even when the branch could simply move forward.
    no_ff: bool,
    /// With `squash`, whether to commit the changes too (the default) or only stage them.
    commit: Option<bool>,
    /// Set uncommitted changes aside while merging and put them back after.
    autostash: bool,
}

/// A squash isn't a merge git tracks, so a conflicted one doesn't count as an
/// operation in progress: there's nothing to continue or abort, just files to fix
/// and commit.
fn squash_conflict_or(path: &str, branch: &str, error: String) -> String {
    let conflicts = open(path)
        .and_then(|repo| repo.index().map_err(|e| e.message().to_string()))
        .map(|index| index.conflicts().map(|c| c.count()).unwrap_or(0))
        .unwrap_or(0);
    match conflicts {
        0 => error,
        1 => format!("CONFLICT: Squashing {branch} conflicted in 1 file. Resolve it in the working copy, then commit."),
        n => format!("CONFLICT: Squashing {branch} conflicted in {n} files. Resolve them in the working copy, then commit."),
    }
}

/// Rebases the current branch onto `onto`. With `autostash`, uncommitted changes are
/// set aside while rebasing and put back after.
#[tauri::command]
pub async fn rebase(path: String, onto: String, autostash: Option<bool>) -> Result<String, String> {
    let stash = crate::stash::newest(&path);
    let set_aside = if autostash.unwrap_or(false) { "--autostash" } else { "--no-autostash" };
    let output = git(&path, &["rebase", set_aside, &onto], None).map_err(|e| stopped_or(&path, e))?;
    let done = if output.contains("is up to date") {
        format!("Already up to date with {onto}.")
    } else {
        format!("Rebased onto {onto}.")
    };
    Ok(crate::stash::unless_left_behind(&path, stash, done))
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

    // A rebase puts back changes it set aside when it ends, either way.
    let stash = crate::stash::newest(&path);
    git(&path, &args, None).map_err(|e| stopped_or(&path, e))?;
    let done = match action.as_str() {
        "abort" => format!("Aborted the {operation}."),
        _ if self::operation(&open(&path)?).is_some() => return Ok(format!("The {operation} continued and stopped again.")),
        _ => format!("Finished the {operation}."),
    };
    Ok(crate::stash::unless_left_behind(&path, stash, done))
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

pub(crate) fn validate_branch_name(path: &str, name: &str) -> Result<(), String> {
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

        assert_eq!(run(merge(t.path().into(), "feature".into(), None)).unwrap(), "Fast-forwarded to feature.");
        assert!(t.dir.join("b.txt").exists());
        assert_eq!(operation(&t.repo), None);
    }

    #[test]
    fn a_conflicted_merge_waits_and_can_be_aborted_or_finished() {
        let (t, _) = conflicting("merge-conflict");

        let stopped = run(merge(t.path().into(), "theirs".into(), None)).unwrap_err();
        assert!(stopped.starts_with("CONFLICT: The merge stopped because 1 file conflicted"), "{stopped}");
        assert_eq!(operation(&t.repo), Some("merge"));

        run(control_operation(t.path().into(), "abort".into())).unwrap();
        assert_eq!(operation(&t.repo), None);
        assert_eq!(std::fs::read_to_string(t.dir.join("a.txt")).unwrap(), "ours\n");

        run(merge(t.path().into(), "theirs".into(), None)).unwrap_err();
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

        let stopped = run(rebase(t.path().into(), main, None)).unwrap_err();
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

    /// A main branch with one commit and a "feature" branch one commit ahead of it.
    fn feature_ahead(name: &str) -> (TempRepo, String) {
        let t = TempRepo::new(name);
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-c", "feature"], None).unwrap();
        t.commit(&[("f.txt", Some("f\n"))], "Feature one");
        t.commit(&[("g.txt", Some("g\n"))], "Feature two");
        git(t.path(), &["switch", &main], None).unwrap();
        (t, main)
    }

    fn options(json: &str) -> Option<MergeOptions> {
        Some(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn merging_can_fast_forward_or_always_make_a_merge_commit() {
        let (t, _) = feature_ahead("merge-ff");
        assert_eq!(run(merge(t.path().into(), "feature".into(), None)).unwrap(), "Fast-forwarded to feature.");

        let (t, _) = feature_ahead("merge-no-ff");
        let message = run(merge(t.path().into(), "feature".into(), options(r#"{"no_ff":true}"#))).unwrap();
        assert_eq!(message, "Merged feature.");
        assert_eq!(t.repo.head().unwrap().peel_to_commit().unwrap().parent_count(), 2);
    }

    #[test]
    fn squashing_makes_one_commit_or_stages_the_changes() {
        let (t, _) = feature_ahead("merge-squash");
        let before = t.head();
        let message = run(merge(t.path().into(), "feature".into(), options(r#"{"squash":true}"#))).unwrap();
        assert_eq!(message, "Squashed feature into one commit.");
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!((head.parent_count(), head.parent_id(0).unwrap()), (1, before));
        assert!(t.dir.join("f.txt").exists() && t.dir.join("g.txt").exists());

        let (t, _) = feature_ahead("merge-squash-staged");
        let before = t.head();
        let message = run(merge(t.path().into(), "feature".into(), options(r#"{"squash":true,"commit":false}"#))).unwrap();
        assert!(message.starts_with("Staged the changes from feature"), "{message}");
        assert_eq!(t.head(), before);
        let staged = git(t.path(), &["diff", "--cached", "--name-only"], None).unwrap();
        assert_eq!(staged, "f.txt\ng.txt");
        assert!(operation(&t.repo).is_none());
    }

    #[test]
    fn squashing_leaves_already_staged_changes_out_of_the_commit() {
        let (t, _) = feature_ahead("merge-squash-mine");
        t.write(&[("mine.txt", Some("new\n")), ("a.txt", Some("edited\n"))]);
        git(t.path(), &["add", "mine.txt"], None).unwrap();
        let message = run(merge(t.path().into(), "feature".into(), options(r#"{"squash":true,"autostash":true}"#))).unwrap();
        assert_eq!(message, "Squashed feature into one commit. Your staged changes are still staged.");
        let committed = git(t.path(), &["show", "--name-only", "--format="], None).unwrap();
        assert_eq!(committed, "f.txt\ng.txt");
        assert_eq!(git(t.path(), &["diff", "--cached", "--name-only"], None).unwrap(), "mine.txt");
        assert_eq!(git(t.path(), &["diff", "--name-only"], None).unwrap(), "a.txt");
        assert_eq!(git(t.path(), &["stash", "list"], None).unwrap(), "");
    }

    #[test]
    fn a_conflicting_squash_leaves_files_to_resolve() {
        let (t, _) = feature_ahead("merge-squash-conflict");
        t.commit(&[("f.txt", Some("mine\n"))], "Mine");
        let stopped = run(merge(t.path().into(), "feature".into(), options(r#"{"squash":true}"#))).unwrap_err();
        assert!(stopped.starts_with("CONFLICT: Squashing feature conflicted in 1 file."), "{stopped}");
    }

    #[test]
    fn merging_with_uncommitted_changes_set_aside() {
        let t = TempRepo::new("merge-autostash");
        t.commit(&[("a.txt", Some("1\n2\n3\n4\n5\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-c", "feature"], None).unwrap();
        t.commit(&[("a.txt", Some("one\n2\n3\n4\n5\n"))], "Feature");
        git(t.path(), &["switch", &main], None).unwrap();
        // An uncommitted edit to the same file, on a different line.
        t.write(&[("a.txt", Some("1\n2\n3\n4\nfive\n"))]);

        let refused = run(merge(t.path().into(), "feature".into(), None)).unwrap_err();
        assert!(refused.contains("would be overwritten"), "{refused}");
        run(merge(t.path().into(), "feature".into(), options(r#"{"autostash":true}"#))).unwrap();
        assert_eq!(std::fs::read_to_string(t.dir.join("a.txt")).unwrap(), "one\n2\n3\n4\nfive\n");
    }

    #[test]
    fn changes_set_aside_that_conflict_when_put_back_are_not_a_plain_success() {
        let t = TempRepo::new("merge-autostash-conflict");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-c", "feature"], None).unwrap();
        t.commit(&[("a.txt", Some("feature\n"))], "Feature");
        git(t.path(), &["switch", &main], None).unwrap();
        t.write(&[("a.txt", Some("mine\n"))]);

        let message = run(merge(t.path().into(), "feature".into(), options(r#"{"autostash":true}"#))).unwrap();
        assert!(message.starts_with("CONFLICT: Fast-forwarded to feature. Your uncommitted changes conflicted"), "{message}");
        assert_eq!(git(t.path(), &["stash", "list"], None).unwrap().lines().count(), 1);
    }

    #[test]
    fn counting_the_commits_only_a_detached_head_has() {
        let t = TempRepo::new("detached-commits");
        let first = t.commit(&[("a.txt", Some("a\n"))], "First");
        assert_eq!(run(commits_only_at_head(t.path().into())).unwrap(), 0);
        git(t.path(), &["switch", "-q", "--detach", &first.to_string()], None).unwrap();
        assert_eq!(run(commits_only_at_head(t.path().into())).unwrap(), 0);
        t.commit(&[("b.txt", Some("b\n"))], "Second");
        t.commit(&[("c.txt", Some("c\n"))], "Third");
        assert_eq!(run(commits_only_at_head(t.path().into())).unwrap(), 2);
        git(t.path(), &["tag", "kept"], None).unwrap();
        assert_eq!(run(commits_only_at_head(t.path().into())).unwrap(), 0);
    }

    #[test]
    fn a_merged_branch_is_only_deleted_when_the_merge_had_all_of_it() {
        let (t, _) = feature_ahead("delete-merged");
        let merged = t.repo.find_branch("feature", git2::BranchType::Local).unwrap().get().target().unwrap().to_string();
        git(t.path(), &["switch", "-q", "feature"], None).unwrap();
        t.commit(&[("later.txt", Some("later\n"))], "Made after the merge");
        git(t.path(), &["switch", "-q", "-"], None).unwrap();

        let kept = run(delete_merged_branch(t.path().into(), "feature".into(), merged.clone())).unwrap_err();
        assert!(kept.contains("weren't in the pull request"), "{kept}");
        git(t.path(), &["branch", "-f", "feature", &merged], None).unwrap();
        run(delete_merged_branch(t.path().into(), "feature".into(), merged)).unwrap();
        assert!(t.repo.find_branch("feature", git2::BranchType::Local).is_err());
    }

    #[test]
    fn rebasing_with_uncommitted_changes_set_aside() {
        let t = TempRepo::new("rebase-autostash");
        t.commit(&[("a.txt", Some("1\n")), ("b.txt", Some("1\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        t.commit(&[("f.txt", Some("f\n"))], "Feature");
        git(t.path(), &["switch", "-q", &main], None).unwrap();
        t.commit(&[("a.txt", Some("2\n"))], "Main");
        git(t.path(), &["switch", "-q", "feature"], None).unwrap();
        t.write(&[("b.txt", Some("mine\n"))]);

        let refused = run(rebase(t.path().into(), main.clone(), Some(false))).unwrap_err();
        assert!(refused.contains("unstaged changes") || refused.contains("uncommitted"), "{refused}");
        assert_eq!(run(rebase(t.path().into(), main.clone(), Some(true))).unwrap(), format!("Rebased onto {main}."));
        assert_eq!(std::fs::read_to_string(t.dir.join("b.txt")).unwrap(), "mine\n");
    }
}
