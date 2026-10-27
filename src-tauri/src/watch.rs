//! Watches the open repository and tells the window when something changes, so edits
//! made in an editor or terminal show up without switching back to Palace.
//!
//! Folders git ignores (vendor/, node_modules/, build output) are never watched: they
//! change constantly, don't affect what Palace shows, and in a large project would use
//! up the system's limit on watched folders.

use git2::Repository;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// The watcher for the open repository. Replacing it stops the old one.
#[derive(Default)]
pub struct RepoWatcher(Mutex<Option<Arc<Mutex<RecommendedWatcher>>>>);

#[tauri::command]
pub fn watch_repo(app: AppHandle, state: tauri::State<'_, RepoWatcher>, path: String) -> Result<(), String> {
    let watcher = start(&path, move || {
        let _ = app.emit("repo-changed", ());
    })?;
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

/// Changes arriving closer together than this are reported once.
const QUIET: Duration = Duration::from_millis(300);
/// Even during a continuous stream of changes, report at least this often.
const MAX_WAIT: Duration = Duration::from_secs(2);

/// Starts watching the repository at `path`, calling `on_change` after each burst of
/// relevant changes. Watching stops when the returned watcher is dropped.
pub(crate) fn start(path: &str, on_change: impl Fn() + Send + 'static) -> Result<Arc<Mutex<RecommendedWatcher>>, String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    let workdir = repo.workdir().ok_or("This repository has no working copy.")?.to_path_buf();
    let gitdir = repo.path().to_path_buf();

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })
    .map_err(|e| format!("Couldn't watch the repository: {e}"))?;
    let watcher = Arc::new(Mutex::new(watcher));

    {
        let mut w = watcher.lock().unwrap();
        watch_tree(&mut w, &repo, &workdir, &gitdir, &workdir);
        // HEAD, the index and packed-refs live directly in .git; branch and tag refs
        // live under refs/.
        let _ = w.watch(&gitdir, RecursiveMode::NonRecursive);
        let _ = w.watch(&gitdir.join("refs"), RecursiveMode::Recursive);
    }

    // The thread holds only a weak reference, so dropping the watcher ends it.
    let weak: Weak<Mutex<RecommendedWatcher>> = Arc::downgrade(&watcher);
    let path = path.to_string();
    std::thread::spawn(move || {
        let Ok(repo) = Repository::discover(&path) else { return };
        while let Ok(first) = rx.recv() {
            let mut events = vec![first];
            let started = Instant::now();
            loop {
                match rx.recv_timeout(QUIET) {
                    Ok(event) => events.push(event),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                if started.elapsed() > MAX_WAIT {
                    break;
                }
            }

            let mut changed = false;
            for event in events.into_iter().flatten() {
                if event.kind.is_access() {
                    continue;
                }
                for p in &event.paths {
                    if !relevant(&repo, &workdir, &gitdir, p) {
                        continue;
                    }
                    changed = true;
                    // A new folder needs watching too.
                    if event.kind.is_create() && p.is_dir() && !p.starts_with(&gitdir) {
                        let Some(watcher) = weak.upgrade() else { return };
                        watch_tree(&mut watcher.lock().unwrap(), &repo, &workdir, &gitdir, p);
                    }
                }
            }
            if changed {
                on_change();
            }
        }
    });

    Ok(watcher)
}

/// Watches `dir` and every folder below it that git doesn't ignore.
fn watch_tree(watcher: &mut RecommendedWatcher, repo: &Repository, workdir: &Path, gitdir: &Path, dir: &Path) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            // Most likely the system's watch limit. Refreshing when the window regains
            // focus still covers anything missed.
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
            if is_dir && path != gitdir && !ignored(repo, workdir, &path, true) {
                stack.push(path);
            }
        }
    }
}

/// Whether a change at `path` could alter what Palace shows.
fn relevant(repo: &Repository, workdir: &Path, gitdir: &Path, path: &Path) -> bool {
    if let Ok(inside_git) = path.strip_prefix(gitdir) {
        // Objects and reflogs change alongside refs, which are watched anyway; lock
        // files come and go during every git command.
        let first = inside_git.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned());
        let lock = path.extension().is_some_and(|e| e == "lock");
        return !lock && !matches!(first.as_deref(), Some("objects" | "logs"));
    }
    path.starts_with(workdir) && !ignored(repo, workdir, path, path.is_dir())
}

fn ignored(repo: &Repository, workdir: &Path, path: &Path, is_dir: bool) -> bool {
    let Ok(relative) = path.strip_prefix(workdir) else { return false };
    let mut relative: PathBuf = relative.to_path_buf();
    // git matches folder-only patterns like "vendor/" against paths ending in a slash.
    if is_dir {
        relative.as_mut_os_string().push("/");
    }
    repo.is_path_ignored(&relative).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::git;
    use crate::test_support::TempRepo;

    /// Starts watching and returns a receiver that gets one message per reported change.
    fn watch(t: &TempRepo) -> (Arc<Mutex<RecommendedWatcher>>, mpsc::Receiver<()>) {
        let (tx, rx) = mpsc::channel();
        let watcher = start(t.path(), move || {
            let _ = tx.send(());
        })
        .unwrap();
        (watcher, rx)
    }

    fn reported(rx: &mpsc::Receiver<()>) -> bool {
        rx.recv_timeout(Duration::from_secs(3)).is_ok()
    }

    /// Waits out any pending report, then checks nothing more arrives.
    fn quiet(rx: &mpsc::Receiver<()>) -> bool {
        while rx.recv_timeout(Duration::from_millis(800)).is_ok() {}
        rx.recv_timeout(Duration::from_millis(1200)).is_err()
    }

    #[test]
    fn edits_and_commits_are_reported_but_ignored_files_are_not() {
        let t = TempRepo::new("watch");
        std::fs::create_dir_all(t.dir.join("vendor/package")).unwrap();
        t.commit(&[("a.txt", Some("a\n")), (".gitignore", Some("vendor/\n"))], "First");
        let (_watcher, rx) = watch(&t);
        assert!(quiet(&rx));

        t.write(&[("a.txt", Some("edited\n"))]);
        assert!(reported(&rx), "editing a tracked file");
        assert!(quiet(&rx));

        t.write(&[("vendor/package/lib.php", Some("<?php\n"))]);
        assert!(quiet(&rx), "files in an ignored folder");

        git(t.path(), &["commit", "-qam", "Edit"], None).unwrap();
        assert!(reported(&rx), "committing");
    }

    #[test]
    fn files_in_new_folders_are_reported() {
        let t = TempRepo::new("watch-new-dir");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let (_watcher, rx) = watch(&t);
        assert!(quiet(&rx));

        std::fs::create_dir_all(t.dir.join("app/Models")).unwrap();
        assert!(reported(&rx), "creating folders");
        assert!(quiet(&rx));

        t.write(&[("app/Models/User.php", Some("<?php\n"))]);
        assert!(reported(&rx), "a file inside the new folder");
    }

    #[test]
    fn dropping_the_watcher_stops_reports() {
        let t = TempRepo::new("watch-stop");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let (watcher, rx) = watch(&t);
        assert!(quiet(&rx));
        drop(watcher);

        t.write(&[("a.txt", Some("edited\n"))]);
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_err());
    }
}
