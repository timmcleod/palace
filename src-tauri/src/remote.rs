//! Fetch, pull and push. These run the git CLI, which handles credentials through the
//! user's SSH agent and credential helpers, and stream git's progress to the window.

use crate::cli::{Running, git_with_progress};
use git2::Repository;
use serde::Serialize;
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
pub async fn pull(app: AppHandle, path: String) -> Result<String, String> {
    in_background(app, move |running, report| pull_current(&path, running, report)).await
}

#[tauri::command]
pub async fn push(app: AppHandle, path: String) -> Result<String, String> {
    in_background(app, move |running, report| push_current(&path, running, report)).await
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

fn pull_current(path: &str, running: &Running, report: Report) -> Result<String, String> {
    let plan = pull_plan(path)?;
    let args: Vec<&str> = plan.args.iter().map(String::as_str).collect();
    let output = git_with_progress(path, &args, running, report)?;
    Ok(if output.contains("Already up to date") {
        format!("{} is already up to date.", plan.branch)
    } else {
        format!("Pulled {} into {}.", plan.upstream, plan.branch)
    })
}

fn push_current(path: &str, running: &Running, report: Report) -> Result<String, String> {
    let plan = push_plan(path)?;
    let args: Vec<&str> = plan.args.iter().map(String::as_str).collect();
    let output = git_with_progress(path, &args, running, report)?;
    Ok(if output.contains("Everything up-to-date") {
        format!("Nothing to push; {} is up to date.", plan.upstream)
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

fn pull_plan(path: &str) -> Result<Plan, String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    let branch = current_branch(&repo)?;
    let (remote, merge) = upstream_of(&repo, &branch)
        .ok_or_else(|| format!("{branch} has no upstream branch to pull from. Push it first to create one."))?;

    let mut args = vec!["pull".to_string(), "--progress".to_string()];
    // Recent git refuses to pull diverged branches until told whether to merge or
    // rebase. Respect any choice the user has configured; otherwise merge, git's
    // long-standing default.
    let config = repo.config().map_err(|e| e.message().to_string())?;
    let configured = ["pull.rebase", "pull.ff", &format!("branch.{branch}.rebase")]
        .iter()
        .any(|key| config.get_string(key).is_ok());
    if !configured {
        args.push("--no-rebase".into());
    }

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

    // No upstream yet: publish the branch under the same name, to "origin" or the only
    // remote there is.
    let remotes = repo.remotes().map_err(|e| e.message().to_string())?;
    let names: Vec<String> = remotes.iter().filter_map(|r| r.ok().flatten().map(str::to_string)).collect();
    let remote = if names.iter().any(|n| n == "origin") {
        "origin".to_string()
    } else if names.len() == 1 {
        names[0].clone()
    } else if names.is_empty() {
        return Err("This repository has no remote to push to.".into());
    } else {
        return Err(format!("{branch} has no upstream branch, and there's more than one remote to choose from."));
    };

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
        push_current(local.path(), &Running::default(), &mut |_| {}).unwrap();
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
        let message = push_current(local.path(), &Running::default(), &mut |l| progress.push(l.to_string())).unwrap();

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
        push_current(other.path(), &Running::default(), &mut |_| {}).unwrap();

        let message = pull_current(local.path(), &Running::default(), &mut |_| {}).unwrap();
        let branch = local.branch();
        assert_eq!(message, format!("Pulled origin/{branch} into {branch}."));
        assert_eq!(local.head(), other.head());

        let again = pull_current(local.path(), &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(again, format!("{branch} is already up to date."));
    }

    #[test]
    fn fetch_updates_remote_tracking_branches_only() {
        let (server, local) = setup("fetch");
        let before = local.head();
        let other = TempRepo::clone_of("fetch-other", &server);
        other.commit(&[("b.txt", Some("b\n"))], "From elsewhere");
        push_current(other.path(), &Running::default(), &mut |_| {}).unwrap();

        fetch_all(local.path(), &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(tracking(&local), other.head());
        assert_eq!(local.head(), before);
    }

    #[test]
    fn diverged_branches_are_merged_on_pull_and_rejected_on_push() {
        let (server, local) = setup("diverged");
        let other = TempRepo::clone_of("diverged-other", &server);
        other.commit(&[("b.txt", Some("b\n"))], "Theirs");
        push_current(other.path(), &Running::default(), &mut |_| {}).unwrap();
        local.commit(&[("c.txt", Some("c\n"))], "Ours");

        let rejected = push_current(local.path(), &Running::default(), &mut |_| {}).unwrap_err();
        assert!(rejected.contains("rejected"), "{rejected}");

        // Merging is the fallback only when the user hasn't chosen a pull strategy.
        let configured = local.repo.config().unwrap().get_string("pull.rebase").is_ok();
        pull_current(local.path(), &Running::default(), &mut |_| {}).unwrap();
        if !configured {
            let head = local.repo.head().unwrap().peel_to_commit().unwrap();
            assert_eq!(head.parent_count(), 2);
        }
        push_current(local.path(), &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(tracking(&local), local.head());
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
        let error = pull_current(local.path(), &Running::default(), &mut |_| {}).unwrap_err();
        assert!(error.contains("has no upstream branch"), "{error}");
    }
}
