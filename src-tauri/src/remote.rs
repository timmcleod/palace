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
pub async fn fetch(app: AppHandle, path: String, remote: Option<String>) -> Result<String, String> {
    in_background(app, move |running, report| match remote {
        Some(remote) => fetch_one(&path, &remote, running, report),
        None => fetch_all(&path, running, report),
    })
    .await
}

/// Fetches all remotes without showing progress or asking for credentials, to keep
/// ahead and behind counts current while Palace is open.
#[tauri::command]
pub async fn fetch_in_background(app: AppHandle, path: String) -> Result<String, String> {
    in_background(app, move |running, _| fetch_unattended(&path, running)).await
}

fn fetch_unattended(path: &str, running: &Running) -> Result<String, String> {
    crate::cli::git_unattended(path, &["fetch", "--all", "--prune", "--quiet"], running)
}

/// Adds a remote, then fetches it so its branches show straight away. If the fetch
/// fails (a mistyped URL, no access), the remote stays, to fix or remove.
#[tauri::command]
pub async fn add_remote(app: AppHandle, path: String, name: String, url: String) -> Result<String, String> {
    let (name, url) = (name.trim().to_string(), url.trim().to_string());
    if name.is_empty() || url.is_empty() {
        return Err("Enter a name and a URL for the remote.".into());
    }
    crate::cli::git(&path, &["remote", "add", &name, &url], None).map_err(|e| explain_remote_error(&name, e))?;
    in_background(app, move |running, report| {
        fetch_one(&path, &name, running, report)
            .map(|_| format!("Added {name} and fetched its branches."))
            .map_err(|e| format!("Added {name}, but couldn't fetch from it:\n{e}"))
    })
    .await
}

#[tauri::command]
pub async fn rename_remote(path: String, name: String, new_name: String) -> Result<String, String> {
    let new_name = new_name.trim();
    crate::cli::git(&path, &["remote", "rename", &name, new_name], None).map_err(|e| explain_remote_error(new_name, e))?;
    Ok(format!("Renamed {name} to {new_name}."))
}

/// Removes a remote and its remote-tracking branches. Local branches stay; any that
/// tracked one of its branches no longer have an upstream.
#[tauri::command]
pub async fn remove_remote(path: String, name: String) -> Result<String, String> {
    crate::cli::git(&path, &["remote", "remove", &name], None)?;
    Ok(format!("Removed {name}."))
}

fn explain_remote_error(name: &str, error: String) -> String {
    if error.contains("already exists") {
        format!("There's already a remote called “{name}”.")
    } else if error.contains("is not a valid remote name") {
        format!("“{name}” isn't a valid remote name. Use letters, numbers, hyphens and underscores.")
    } else {
        error
    }
}

// Fetches prune: branches deleted on a remote go from its list here too. Local
// branches are never touched.
fn fetch_one(path: &str, remote: &str, running: &Running, report: Report) -> Result<String, String> {
    git_with_progress(path, &["fetch", "--progress", "--prune", remote], running, report)?;
    Ok(format!("Fetched from {remote}."))
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

/// Publishes a local branch: pushes it to `remote` as `name` and makes that its
/// upstream branch, so later pushes and pulls go there.
#[tauri::command]
pub async fn publish_branch(app: AppHandle, path: String, branch: String, remote: String, name: String) -> Result<String, String> {
    in_background(app, move |running, report| publish(&path, &branch, &remote, &name, running, report)).await
}

/// Renames a branch on its remote, `name` being the remote branch ("origin/old"): pushes
/// what the remote has under `new`, as long as that name is free, then deletes the old
/// name, as long as it hasn't moved meanwhile. Local branches that tracked it follow.
#[tauri::command]
pub async fn rename_remote_branch(app: AppHandle, path: String, name: String, new: String) -> Result<String, String> {
    in_background(app, move |running, report| rename_on_remote(&path, &name, &new, running, report)).await
}

fn rename_on_remote(path: &str, name: &str, new: &str, running: &Running, report: Report) -> Result<String, String> {
    let (remote, old) = split_remote_branch(path, name)?;
    let new = new.trim().to_string();
    crate::branch::validate_branch_name(path, &new)?;
    let tracking = format!("refs/remotes/{remote}/{old}");
    git_with_progress(path, &["fetch", "--progress", &remote, &format!("+refs/heads/{old}:{tracking}")], running, &mut *report)?;
    let id = crate::cli::git(path, &["rev-parse", "--verify", &tracking], None)?;
    // The lease below only guards a push that changes something: one to a branch
    // already at the same commit would succeed without it.
    let taken = || format!("{remote} already has a branch called {new}.");
    if !git_with_progress(path, &["ls-remote", "--heads", &remote, &format!("refs/heads/{new}")], running, &mut *report)?.trim().is_empty() {
        return Err(taken());
    }
    let free = format!("--force-with-lease=refs/heads/{new}:");
    git_with_progress(path, &["push", "--progress", &free, &remote, &format!("{id}:refs/heads/{new}")], running, &mut *report)
        .map_err(|e| if e.contains("stale info") { taken() } else { e })?;
    let unmoved = format!("--force-with-lease=refs/heads/{old}:{id}");
    git_with_progress(path, &["push", "--progress", &unmoved, &remote, &format!(":refs/heads/{old}")], running, &mut *report)?;
    git_with_progress(path, &["fetch", "--progress", "--prune", &remote], running, &mut *report)?;
    let local = crate::branch::retrack(path, &remote, &old, &new)?;
    Ok(format!("Renamed {old} to {new} on {remote}. {local}").trim().to_string())
}

/// Deletes a branch on its remote. `name` is the remote branch, e.g. "origin/feature".
#[tauri::command]
pub async fn delete_remote_branch(app: AppHandle, path: String, name: String) -> Result<String, String> {
    in_background(app, move |running, report| delete_on_remote(&path, &name, running, report)).await
}

fn delete_on_remote(path: &str, name: &str, running: &Running, report: Report) -> Result<String, String> {
    let (remote, branch) = split_remote_branch(path, name)?;
    match git_with_progress(path, &["push", "--progress", &remote, "--delete", &branch], running, report) {
        Ok(_) => Ok(format!("Deleted {branch} from {remote}.")),
        // Someone deleted it already: only the local copy of it is left to remove.
        Err(e) if e.contains("remote ref does not exist") => {
            crate::cli::git(path, &["branch", "--delete", "--remotes", name], None)?;
            Ok(format!("{branch} was already gone from {remote}, so it's been removed from the list."))
        }
        Err(e) => Err(e),
    }
}

/// After a branch was renamed on the remote by other means (GitHub's rename, which
/// finishes in the background), waits for the old name to go, at most 15 seconds,
/// then fetches with pruning and has local branches follow, as `rename_remote_branch`
/// does.
#[tauri::command]
pub async fn finish_remote_rename(app: AppHandle, path: String, remote: String, old: String, new: String) -> Result<String, String> {
    in_background(app, move |running, report| {
        let exists = |branch: &str| {
            crate::cli::git(&path, &["ls-remote", "--heads", &remote, &format!("refs/heads/{branch}")], None)
                .map(|out| !out.trim().is_empty())
        };
        let mut done = false;
        for _ in 0..15 {
            if exists(&new)? && !exists(&old)? {
                done = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        git_with_progress(&path, &["fetch", "--progress", "--prune", &remote], running, &mut *report)?;
        let local = crate::branch::retrack(&path, &remote, &old, &new)?;
        let later = if done { "" } else { " The remote is still finishing; fetch again in a moment if the old name is still listed." };
        Ok(format!("Renamed {old} to {new} on {remote}. {local}{later}").trim().replace("  ", " "))
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

    // If cloning fails or is canceled, git removes what it had written.
    git_with_progress_in(&parent, &["clone", "--progress", url, &dest.to_string_lossy()], running, report)?;
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(format!("Cloned {name} into {}.", parent.display()))
}

/// Deletes a tag from the default remote. A tag that isn't there counts as done.
#[tauri::command]
pub async fn delete_remote_tag(app: AppHandle, path: String, name: String) -> Result<String, String> {
    in_background(app, move |running, report| delete_tag_on_remote(&path, &name, running, report)).await
}

fn delete_tag_on_remote(path: &str, name: &str, running: &Running, report: Report) -> Result<String, String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    let remote = default_remote(&repo)?;
    // Servers differ on a tag that isn't there: GitHub refuses ("remote ref does not
    // exist"), while git's own server deletes nothing and warns.
    let missing = format!("The tag {name} wasn't on {remote}.");
    match git_with_progress(path, &["push", "--progress", &remote, "--delete", &format!("refs/tags/{name}")], running, report) {
        Ok(output) if output.contains("non-existent ref") => Ok(missing),
        Ok(_) => Ok(format!("Deleted the tag {name} from {remote}.")),
        Err(e) if e.contains("remote ref does not exist") => Ok(missing),
        Err(e) => Err(e),
    }
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
    git_with_progress(path, &["fetch", "--all", "--progress", "--prune"], running, report)?;
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

fn publish(path: &str, branch: &str, remote: &str, name: &str, running: &Running, report: Report) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the branch a name to publish it under.".into());
    }
    let refspec = format!("refs/heads/{branch}:refs/heads/{name}");
    git_with_progress(path, &["push", "--progress", "--set-upstream", remote, &refspec], running, report)?;
    Ok(format!("Published {branch} to {remote}/{name}."))
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

    #[test]
    fn renaming_a_branch_on_its_remote() {
        let server = TempRepo::bare("rename-remote-server");
        let t = TempRepo::clone_of("rename-remote", &server);
        t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        crate::cli::git(t.path(), &["push", "-q", "origin", &main], None).unwrap();
        crate::cli::git(t.path(), &["switch", "-qc", "old-name"], None).unwrap();
        let tip = t.commit(&[("b.txt", Some("1\n"))], "Feature");
        crate::cli::git(t.path(), &["push", "-qu", "origin", "old-name"], None).unwrap();

        let message = rename_on_remote(t.path(), "origin/old-name", "new-name", &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(message, "Renamed old-name to new-name on origin. Renamed your local old-name to match.");
        assert!(server.repo.find_reference("refs/heads/old-name").is_err());
        assert_eq!(server.repo.find_reference("refs/heads/new-name").unwrap().target(), Some(tip));
        assert!(t.repo.find_reference("refs/remotes/origin/old-name").is_err());
        let local = t.repo.find_branch("new-name", git2::BranchType::Local).unwrap();
        assert_eq!(local.upstream().unwrap().name().unwrap(), Some("origin/new-name"));
    }

    #[test]
    fn fetching_drops_branches_deleted_on_the_remote() {
        let server = TempRepo::bare("fetch-prune-server");
        let t = TempRepo::clone_of("fetch-prune", &server);
        t.commit(&[("a.txt", Some("1\n"))], "First");
        crate::cli::git(t.path(), &["push", "-q", "origin", "HEAD:refs/heads/gone"], None).unwrap();
        crate::cli::git(t.path(), &["fetch", "-q", "origin"], None).unwrap();
        server.repo.find_reference("refs/heads/gone").unwrap().delete().unwrap();

        fetch_all(t.path(), &Running::default(), &mut |_| {}).unwrap();
        assert!(t.repo.find_reference("refs/remotes/origin/gone").is_err());
    }

    #[test]
    fn deleting_a_branch_already_gone_from_the_remote_clears_it() {
        let server = TempRepo::bare("delete-gone-server");
        let t = TempRepo::clone_of("delete-gone", &server);
        t.commit(&[("a.txt", Some("1\n"))], "First");
        crate::cli::git(t.path(), &["push", "-q", "origin", "HEAD:refs/heads/gone"], None).unwrap();
        crate::cli::git(t.path(), &["fetch", "-q", "origin"], None).unwrap();
        // Deleted on the server by someone else.
        server.repo.find_reference("refs/heads/gone").unwrap().delete().unwrap();

        let message = delete_on_remote(t.path(), "origin/gone", &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(message, "gone was already gone from origin, so it's been removed from the list.");
        assert!(t.repo.find_reference("refs/remotes/origin/gone").is_err());
    }

    #[test]
    fn renaming_onto_a_taken_name_changes_nothing() {
        let server = TempRepo::bare("rename-taken-server");
        let t = TempRepo::clone_of("rename-taken", &server);
        t.commit(&[("a.txt", Some("1\n"))], "First");
        crate::cli::git(t.path(), &["push", "-q", "origin", "HEAD:refs/heads/taken", "HEAD:refs/heads/old-name"], None).unwrap();

        let error = rename_on_remote(t.path(), "origin/old-name", "taken", &Running::default(), &mut |_| {}).unwrap_err();
        assert_eq!(error, "origin already has a branch called taken.");
        assert!(server.repo.find_reference("refs/heads/old-name").is_ok());
    }
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
    fn publishing_a_branch_that_isnt_checked_out() {
        let (server, local) = setup("publish-other");
        local.repo.branch("feature", &local.repo.head().unwrap().peel_to_commit().unwrap(), false).unwrap();

        let message = publish(local.path(), "feature", "origin", "feature/renamed", &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(message, "Published feature to origin/feature/renamed.");
        assert_eq!(server.repo.refname_to_id("refs/heads/feature/renamed").unwrap(), local.head());
        assert_eq!(upstream_of(&local.repo, "feature"), Some(("origin".into(), "feature/renamed".into())));
        assert_eq!(upstream_of(&local.repo, &local.branch()).map(|u| u.1), Some(local.branch()));
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
    fn background_fetches_bring_in_new_commits() {
        let (server, local) = setup("background");
        let other = TempRepo::clone_of("background-other", &server);
        let theirs = other.commit(&[("b.txt", Some("b\n"))], "Theirs");
        push_current(other.path(), false, &Running::default(), &mut |_| {}).unwrap();

        fetch_unattended(local.path(), &Running::default()).unwrap();
        assert_eq!(tracking(&local), theirs);
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
    fn canceling_stops_git_and_the_processes_it_started() {
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

        assert_eq!(result, Err("Canceled.".to_string()));
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

    #[test]
    fn adding_renaming_and_removing_remotes() {
        let (server, local) = setup("remotes");
        let other = TempRepo::bare("remotes-other");
        crate::cli::git(local.path(), &["push", other.path(), "HEAD:refs/heads/feature"], None).unwrap();
        let _ = server;

        let names = |t: &TempRepo| crate::cli::git(t.path(), &["remote"], None).unwrap();
        crate::cli::git(local.path(), &["remote", "add", "upstream", other.path()], None).unwrap();
        fetch_one(local.path(), "upstream", &Running::default(), &mut |_| {}).unwrap();
        assert!(local.repo.find_reference("refs/remotes/upstream/feature").is_ok());

        let taken = tauri::async_runtime::block_on(rename_remote(local.path().into(), "upstream".into(), "origin".into()));
        assert_eq!(taken.unwrap_err(), "There's already a remote called “origin”.");
        tauri::async_runtime::block_on(rename_remote(local.path().into(), "upstream".into(), "fork".into())).unwrap();
        assert_eq!(names(&local), "fork\norigin");
        assert!(local.repo.find_reference("refs/remotes/fork/feature").is_ok());

        tauri::async_runtime::block_on(remove_remote(local.path().into(), "fork".into())).unwrap();
        assert_eq!(names(&local), "origin");
        assert!(local.repo.find_reference("refs/remotes/fork/feature").is_err());

        let bad = crate::cli::git(local.path(), &["remote", "add", "has space", other.path()], None).unwrap_err();
        assert!(explain_remote_error("has space", bad).contains("isn't a valid remote name"));
    }

    #[test]
    fn deleting_a_tag_from_the_remote() {
        let (server, local) = setup("remote-tag");
        crate::cli::git(local.path(), &["tag", "v1.0.0"], None).unwrap();
        crate::cli::git(local.path(), &["push", "origin", "refs/tags/v1.0.0"], None).unwrap();
        assert!(server.repo.find_reference("refs/tags/v1.0.0").is_ok());

        let message = delete_tag_on_remote(local.path(), "v1.0.0", &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(message, "Deleted the tag v1.0.0 from origin.");
        assert!(server.repo.find_reference("refs/tags/v1.0.0").is_err());
        // The local tag stays.
        assert!(local.repo.find_reference("refs/tags/v1.0.0").is_ok());

        let again = delete_tag_on_remote(local.path(), "v1.0.0", &Running::default(), &mut |_| {}).unwrap();
        assert_eq!(again, "The tag v1.0.0 wasn't on origin.");
    }
}
