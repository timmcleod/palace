//! Fetch, pull and push. These run the git CLI, which handles credentials through the
//! user's SSH agent and credential helpers, and stream git's progress to the window.

use crate::cli::{Running, git_with_progress, git_with_progress_in};
use std::path::{Path, PathBuf};
use git2::Repository;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
struct Progress {
    line: String,
}

#[tauri::command]
pub async fn fetch(app: AppHandle, path: String) -> Result<String, String> {
    in_background(app, move |running, report| fetch_all(&path, running, report)).await
}

#[tauri::command]
pub async fn pull(app: AppHandle, path: String, options: Option<PullOptions>) -> Result<String, String> {
    let options = options.unwrap_or_default();
    in_background(app, move |running, report| pull_current(&path, &options, running, report)).await
}

/// Choices from the Pull dialog.
#[derive(Deserialize, Debug)]
#[serde(default)]
pub struct PullOptions {
    /// The remote branch to pull, e.g. "origin/main"; the upstream when omitted.
    from: Option<String>,
    /// Rebase instead of merging; when omitted, whatever git is configured to do.
    rebase: Option<bool>,
    /// Set uncommitted changes aside while pulling and put them back after.
    autostash: bool,
}

impl Default for PullOptions {
    fn default() -> Self {
        PullOptions { from: None, rebase: None, autostash: true }
    }
}

/// Pushes the current branch. With `force`, overwrites the remote branch, but only if
/// it's still where this repository last saw it (`--force-with-lease`), so commits
/// someone else pushed in the meantime are never thrown away unseen.
#[tauri::command]
pub async fn push(app: AppHandle, path: String, force: Option<bool>) -> Result<String, String> {
    let force = force.unwrap_or(false);
    in_background(app, move |running, report| push_current(&path, force, running, report)).await
}

/// Deletes a branch on its remote. `name` is the remote branch, e.g. "origin/feature".
#[tauri::command]
pub async fn delete_remote_branch(app: AppHandle, path: String, name: String) -> Result<String, String> {
    in_background(app, move |running, report| {
        let (remote, branch) = split_remote_branch(&path, &name)?;
        git_with_progress(&path, &["push", "--progress", &remote, "--delete", &branch], running, report)?;
        Ok(format!("Deleted {branch} from {remote}."))
    })
    .await
}

#[tauri::command]
pub async fn push_tag(app: AppHandle, path: String, name: String) -> Result<String, String> {
    in_background(app, move |running, report| {
        let repo = Repository::discover(&path).map_err(|e| e.message().to_string())?;
        let remote = default_remote(&repo)?;
        git_with_progress(&path, &["push", "--progress", &remote, &format!("refs/tags/{name}")], running, report)?;
        Ok(format!("Pushed the tag {name} to {remote}."))
    })
    .await
}

/// Clones `url` into `dest`, which must not exist yet or be empty. The folders above
/// it are created as needed.
#[tauri::command]
pub async fn clone_repo(app: AppHandle, url: String, dest: String) -> Result<String, String> {
    in_background(app, move |running, report| clone_into(&url, Path::new(dest.trim()), running, report)).await
}

fn clone_into(url: &str, dest: &Path, running: &Running, report: Report) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Enter the repository's URL.".into());
    }
    if !dest.is_absolute() {
        return Err("Choose a folder to clone into.".into());
    }
    if dest.exists() && dest.read_dir().map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(format!("There's already a folder with files in it at {}. Choose another location.", dest.display()));
    }
    let parent: PathBuf = dest.parent().ok_or("Choose a folder to clone into.")?.to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;

    // If cloning fails or is cancelled, git removes what it had written.
    git_with_progress_in(&parent, &["clone", "--progress", url, &dest.to_string_lossy()], running, report)?;
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(format!("Cloned {name} into {}.", parent.display()))
}

#[tauri::command]
pub fn cancel_remote(running: tauri::State<'_, Running>) {
    running.cancel();
}

type Report<'a> = &'a mut dyn FnMut(&str);

/// Runs a network operation off the async runtime, forwarding progress to the window
/// as `remote-progress` events.
async fn in_background(
    app: AppHandle,
    work: impl FnOnce(&Running, Report) -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let running = app.state::<Running>();
        let mut report = |line: &str| {
            let _ = app.emit("remote-progress", Progress { line: line.to_string() });
        };
        work(&running, &mut report)
    })
    .await
    .map_err(|e| format!("The operation stopped unexpectedly: {e}"))?
}

fn fetch_all(path: &str, running: &Running, report: Report) -> Result<String, String> {
    git_with_progress(path, &["fetch", "--all", "--progress"], running, report)?;
    Ok("Fetched from all remotes.".to_string())
}

fn pull_current(path: &str, options: &PullOptions, running: &Running, report: Report) -> Result<String, String> {
    let plan = pull_plan(path, options)?;
    let args: Vec<&str> = plan.args.iter().map(String::as_str).collect();
    let output = git_with_progress(path, &args, running, report).map_err(|e| crate::branch::stopped_or(path, e))?;
    Ok(if output.contains("Already up to date") {
        format!("{} is already up to date.", plan.branch)
    } else {
        format!("Pulled {} into {}.", plan.upstream, plan.branch)
    })
}

fn push_current(path: &str, force: bool, running: &Running, report: Report) -> Result<String, String> {
    let plan = push_plan(path)?;
    let mut args: Vec<&str> = plan.args.iter().map(String::as_str).collect();
    if force {
        args.insert(2, "--force-with-lease");
    }
    let output = git_with_progress(path, &args, running, report)?;
    Ok(if output.contains("Everything up-to-date") {
        format!("Nothing to push; {} is up to date.", plan.upstream)
    } else if force {
        format!("Force pushed {} to {}.", plan.branch, plan.upstream)
    } else if plan.sets_upstream {
        format!("Pushed {} to {}, and set it as the upstream branch.", plan.branch, plan.upstream)
    } else {
        format!("Pushed {} to {}.", plan.branch, plan.upstream)
    })
}

struct Plan {
    args: Vec<String>,
    branch: String,
    upstream: String,
    sets_upstream: bool,
}

/// The remote to use when nothing says otherwise: "origin", or the only remote.
fn default_remote(repo: &Repository) -> Result<String, String> {
    let names = remote_names(repo)?;
    if names.iter().any(|n| n == "origin") {
        Ok("origin".into())
    } else if names.len() == 1 {
        Ok(names[0].clone())
    } else if names.is_empty() {
        Err("This repository has no remote to push to.".into())
    } else {
        Err("There's more than one remote to choose from, and none is called origin.".into())
    }
}

fn remote_names(repo: &Repository) -> Result<Vec<String>, String> {
    let remotes = repo.remotes().map_err(|e| e.message().to_string())?;
    Ok(remotes.iter().filter_map(|r| r.ok().flatten().map(str::to_string)).collect())
}

/// Splits "origin/feature/x" into ("origin", "feature/x"), matching the longest remote
/// name, since remote names can contain slashes too.
fn split_remote_branch(path: &str, name: &str) -> Result<(String, String), String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    remote_names(&repo)?
        .into_iter()
        .filter(|remote| name.starts_with(&format!("{remote}/")))
        .max_by_key(String::len)
        .map(|remote| {
            let branch = name[remote.len() + 1..].to_string();
            (remote, branch)
        })
        .ok_or_else(|| format!("{name} doesn't belong to any remote."))
}

/// The current branch, or an explanation of why there isn't one to pull or push.
fn current_branch(repo: &Repository) -> Result<String, String> {
    let head = repo.head().map_err(|_| "This repository has no commits yet.".to_string())?;
    if !head.is_branch() {
        return Err("HEAD is detached, so there's no branch to pull or push. Check out a branch first.".into());
    }
    Ok(head.shorthand().unwrap_or("").to_string())
}

/// The remote and branch the current branch tracks, from branch.<name>.remote/.merge.
fn upstream_of(repo: &Repository, branch: &str) -> Option<(String, String)> {
    let refname = format!("refs/heads/{branch}");
    let remote = repo.branch_upstream_remote(&refname).ok()?.as_str().ok()?.to_string();
    let merge = repo.branch_upstream_merge(&refname).ok()?.as_str().ok()?.to_string();
    let merge = merge.strip_prefix("refs/heads/").unwrap_or(&merge).to_string();
    Some((remote, merge))
}

fn pull_plan(path: &str, options: &PullOptions) -> Result<Plan, String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    let branch = current_branch(&repo)?;
    let (remote, merge) = match &options.from {
        Some(from) => split_remote_branch(path, from)?,
        None => upstream_of(&repo, &branch)
            .ok_or_else(|| format!("{branch} has no upstream branch to pull from. Push it first to create one."))?,
    };

    let mut args = vec!["pull".to_string(), "--progress".to_string()];
    // Rebasing refuses to start with uncommitted changes unless they're set aside.
    args.push(if options.autostash { "--autostash" } else { "--no-autostash" }.into());
    match options.rebase {
        Some(true) => args.push("--rebase".into()),
        Some(false) => args.push("--no-rebase".into()),
        None => {
            // Recent git refuses to pull diverged branches until told whether to merge
            // or rebase. Respect any choice the user has configured; otherwise merge,
            // git's long-standing default.
            let config = repo.config().map_err(|e| e.message().to_string())?;
            let configured = ["pull.rebase", "pull.ff", &format!("branch.{branch}.rebase")]
                .iter()
                .any(|key| config.get_string(key).is_ok());
            if !configured {
                args.push("--no-rebase".into());
            }
        }
    }
    args.push(remote.clone());
    args.push(merge.clone());

    Ok(Plan { args, branch, upstream: format!("{remote}/{merge}"), sets_upstream: false })
}

fn push_plan(path: &str) -> Result<Plan, String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    let branch = current_branch(&repo)?;

    if let Some((remote, merge)) = upstream_of(&repo, &branch) {
        // Push explicitly to the tracked branch, so it works even when its name differs
        // from the local branch's (which git's default push setting refuses).
        let args = ["push", "--progress", &remote, &format!("HEAD:refs/heads/{merge}")].map(String::from);
        return Ok(Plan { args: args.to_vec(), branch, upstream: format!("{remote}/{merge}"), sets_upstream: false });
    }

    // No upstream yet: publish the branch under the same name.
    let remote = default_remote(&repo)
        .map_err(|e| format!("{branch} has no upstream branch. {e}"))?;

    let args = ["push", "--progress", "--set-upstream", &remote, &branch].map(String::from);
    Ok(Plan { args: args.to_vec(), branch: branch.clone(), upstream: format!("{remote}/{branch}"), sets_upstream: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;
    use git2::Oid;
    use std::time::{Duration, Instant};

    /// A bare "server" with one commit pushed to it, plus a clone that tracks it.
    fn setup(name: &str) -> (TempRepo, TempRepo) {
        let server = TempRepo::bare(&format!("{name}-server"));
        let local = TempRepo::new(&format!("{name}-local"));
        local.commit(&[("a.txt", Some("a\n"))], "First");
        local.repo.remote("origin", server.path()).unwrap();
        push_current(local.path(), false, &Running::default(), &mut |_| {}).unwrap();
        server.repo.set_head(&format!("refs/heads/{}", local.branch())).unwrap();
        (server, local)
    }

    fn tracking(repo: &TempRepo) -> Oid {
        repo.repo.refname_to_id(&format!("refs/remotes/origin/{}", repo.branch())).unwrap()
    }

    #[test]
    fn first_push_publishes_the_branch_and_sets_its_upstream() {
        let server = TempRepo::bare("publish-server");
        let local = TempRepo::new("publish-local");
        local.commit(&[("a.txt", Some("a\n"))], "First");
        local.repo.remote("origin", server.path()).unwrap();

        let mut progress = Vec::new();
        let message = push_current(local.path(), false, &Running::default(), &mut |l| progress.push(l.to_string())).unwrap();

        let branch = local.branch();
        assert_eq!(message, format!("Pushed {branch} to origin/{branch}, and set it as the upstream branch."));
        assert_eq!(server.repo.refname_to_id(&format!("refs/heads/{branch}")).unwrap(), local.head());
        assert_eq!(upstream_of(&local.repo, &branch), Some(("origin".into(), branch.clone())));
        assert!(!progress.is_empty(), "git's progress should be reported");
    }

    #[test]
    fn pull_brings_in_commits_pushed_from_elsewhere() {
        let (server, local) = setup("pull");
        let other = TempRepo::clone_of("pull-other", &server);
        other.commit(&[("b.txt", Some("b\n"))], "From elsewhere");
        push_current(other.path(), false, &Running::default(), &mut |_| {}).unwrap();

        let message = pull_current(local.path(), &PullOptions::default(), &Running::default(), &mut |_| {}).unwrap();
        let branch = local.branch();
        assert_eq!(message, format!("Pulled origin/{branch} into {branch}."));
        assert_eq!(local.head(), other.head());

        let again = pull_current(local.path(), &PullOptions::default(), &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(again, format!("{branch} is already up to date."));
    }

    #[test]
    fn fetch_updates_remote_tracking_branches_only() {
        let (server, local) = setup("fetch");
        let before = local.head();
        let other = TempRepo::clone_of("fetch-other", &server);
        other.commit(&[("b.txt", Some("b\n"))], "From elsewhere");
        push_current(other.path(), false, &Running::default(), &mut |_| {}).unwrap();

        fetch_all(local.path(), &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(tracking(&local), other.head());
        assert_eq!(local.head(), before);
    }

    #[test]
    fn diverged_branches_are_merged_on_pull_and_rejected_on_push() {
        let (server, local) = setup("diverged");
        let other = TempRepo::clone_of("diverged-other", &server);
        other.commit(&[("b.txt", Some("b\n"))], "Theirs");
        push_current(other.path(), false, &Running::default(), &mut |_| {}).unwrap();
        local.commit(&[("c.txt", Some("c\n"))], "Ours");

        let rejected = push_current(local.path(), false, &Running::default(), &mut |_| {}).unwrap_err();
        assert!(rejected.contains("rejected"), "{rejected}");

        // Merging is the fallback only when the user hasn't chosen a pull strategy.
        let configured = local.repo.config().unwrap().get_string("pull.rebase").is_ok();
        pull_current(local.path(), &PullOptions::default(), &Running::default(), &mut |_| {}).unwrap();
        if !configured {
            let head = local.repo.head().unwrap().peel_to_commit().unwrap();
            assert_eq!(head.parent_count(), 2);
        }
        push_current(local.path(), false, &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(tracking(&local), local.head());
    }

    #[test]
    fn force_push_publishes_a_rewritten_branch() {
        let (_server, local) = setup("force");
        // Rewrite the pushed commit, as amending does.
        crate::cli::git(local.path(), &["commit", "--amend", "-qm", "First, reworded"], None).unwrap();

        let rejected = push_current(local.path(), false, &Running::default(), &mut |_| {}).unwrap_err();
        assert!(rejected.contains("non-fast-forward") || rejected.contains("rejected"), "{rejected}");

        let message = push_current(local.path(), true, &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(message, format!("Force pushed {0} to origin/{0}.", local.branch()));
        assert_eq!(tracking(&local), local.head());
    }

    #[test]
    fn force_push_refuses_to_overwrite_commits_it_hasnt_seen() {
        let (server, local) = setup("force-lease");
        let other = TempRepo::clone_of("force-lease-other", &server);
        other.commit(&[("b.txt", Some("b\n"))], "Someone else's work");
        push_current(other.path(), false, &Running::default(), &mut |_| {}).unwrap();

        // Without fetching, rewrite and force push.
        crate::cli::git(local.path(), &["commit", "--amend", "-qm", "Rewritten"], None).unwrap();
        let refused = push_current(local.path(), true, &Running::default(), &mut |_| {}).unwrap_err();
        assert!(refused.contains("stale info"), "{refused}");
        let server_head = server.repo.refname_to_id(&format!("refs/heads/{}", other.branch())).unwrap();
        assert_eq!(server_head, other.head(), "their commit is still there");
    }

    #[test]
    fn deleting_a_remote_branch_and_pushing_a_tag() {
        let (server, local) = setup("delete-remote");
        crate::cli::git(local.path(), &["push", "origin", "HEAD:refs/heads/feature/old"], None).unwrap();
        assert!(server.repo.find_reference("refs/heads/feature/old").is_ok());

        let path = local.path().to_string();
        let (remote, branch) = split_remote_branch(&path, "origin/feature/old").unwrap();
        assert_eq!((remote.as_str(), branch.as_str()), ("origin", "feature/old"));
        git_with_progress(&path, &["push", "--progress", &remote, "--delete", &branch], &Running::default(), &mut |_: &str| {}).unwrap();
        assert!(server.repo.find_reference("refs/heads/feature/old").is_err());

        crate::cli::git(&path, &["tag", "v1"], None).unwrap();
        let remote = default_remote(&local.repo).unwrap();
        git_with_progress(&path, &["push", "--progress", &remote, "refs/tags/v1"], &Running::default(), &mut |_: &str| {}).unwrap();
        assert!(server.repo.find_reference("refs/tags/v1").is_ok());
    }

    #[test]
    fn cancelling_stops_git_and_the_processes_it_started() {
        let (_server, local) = setup("cancel");
        // Make the "server" side hang, like a stalled network connection.
        let mut config = local.repo.config().unwrap();
        config.set_str("remote.origin.uploadpack", "sleep 30; git-upload-pack").unwrap();

        let running = Running::default();
        let path = local.path().to_string();
        let started = Instant::now();
        let result = std::thread::scope(|scope| {
            let fetch = scope.spawn(|| fetch_all(&path, &running, &mut |_| {}));
            std::thread::sleep(Duration::from_millis(500));
            running.cancel();
            fetch.join().unwrap()
        });

        assert_eq!(result, Err("Cancelled.".to_string()));
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
        // The slot is free again for the next operation.
        assert!(running.0.lock().unwrap().is_none());
    }

    #[test]
    fn pulling_a_branch_without_upstream_explains_why_not() {
        let local = TempRepo::new("no-upstream");
        local.commit(&[("a.txt", Some("a\n"))], "First");
        let error = pull_current(local.path(), &PullOptions::default(), &Running::default(), &mut |_| {}).unwrap_err();
        assert!(error.contains("has no upstream branch"), "{error}");
    }

    #[test]
    fn pulling_with_rebase_keeps_history_straight_and_changes_in_place() {
        let (server, local) = setup("pull-rebase");
        let other = TempRepo::clone_of("pull-rebase-other", &server);
        let theirs = other.commit(&[("b.txt", Some("b\n"))], "Theirs");
        push_current(other.path(), false, &Running::default(), &mut |_| {}).unwrap();
        local.commit(&[("c.txt", Some("c\n"))], "Ours");
        // An uncommitted edit, which a rebasing pull would otherwise refuse to work with.
        local.write(&[("a.txt", Some("edited\n"))]);

        let rebase = PullOptions { rebase: Some(true), ..PullOptions::default() };
        pull_current(local.path(), &rebase, &Running::default(), &mut |_| {}).unwrap();
        let head = local.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 1);
        assert_eq!(head.parent_id(0).unwrap(), theirs);
        assert_eq!(head.summary().unwrap(), Some("Ours"));
        assert_eq!(std::fs::read_to_string(local.dir.join("a.txt")).unwrap(), "edited\n");
    }

    #[test]
    fn a_pull_that_conflicts_waits_for_the_user() {
        let (server, local) = setup("pull-conflict");
        let other = TempRepo::clone_of("pull-conflict-other", &server);
        other.commit(&[("a.txt", Some("theirs\n"))], "Theirs");
        push_current(other.path(), false, &Running::default(), &mut |_| {}).unwrap();
        local.commit(&[("a.txt", Some("ours\n"))], "Ours");

        let rebase = PullOptions { rebase: Some(true), ..PullOptions::default() };
        let stopped = pull_current(local.path(), &rebase, &Running::default(), &mut |_| {}).unwrap_err();
        assert!(stopped.starts_with("CONFLICT: The rebase stopped because 1 file conflicted"), "{stopped}");
    }

    #[test]
    fn pulling_another_remote_branch() {
        let (server, local) = setup("pull-other-branch");
        let other = TempRepo::clone_of("pull-other-branch-other", &server);
        crate::cli::git(other.path(), &["checkout", "-b", "feature"], None).unwrap();
        let feature = other.commit(&[("f.txt", Some("f\n"))], "Feature");
        crate::cli::git(other.path(), &["push", "origin", "feature"], None).unwrap();
        fetch_all(local.path(), &Running::default(), &mut |_| {}).unwrap();

        let from = PullOptions { from: Some("origin/feature".into()), rebase: Some(false), ..PullOptions::default() };
        let message = pull_current(local.path(), &from, &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(message, format!("Pulled origin/feature into {}.", local.branch()));
        assert_eq!(local.head(), feature);
    }

    #[test]
    fn cloning_into_a_new_folder() {
        let (server, _local) = setup("clone");
        let dest = std::env::temp_dir().join(format!("palace-clone-{}/owner/repo", std::process::id()));
        let _ = std::fs::remove_dir_all(dest.parent().unwrap().parent().unwrap());

        let url = server.path().to_string();
        let message = clone_into(&url, &dest, &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(message, format!("Cloned repo into {}.", dest.parent().unwrap().display()));
        assert!(dest.join("a.txt").exists());

        // Not over a folder that has files in it.
        let again = clone_into(&url, &dest, &Running::default(), &mut |_| {}).unwrap_err();
        assert!(again.starts_with("There's already a folder with files in it"), "{again}");
        assert!(clone_into(&url, Path::new("relative/path"), &Running::default(), &mut |_| {}).is_err());
        let _ = std::fs::remove_dir_all(dest.parent().unwrap().parent().unwrap());
    }
}
