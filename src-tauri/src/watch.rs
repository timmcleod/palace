//! Watches each window's repository and tells that window when something changes, so
//! edits made in an editor or terminal show up without switching back to Palace.
//!
//! Folders git ignores (vendor/, node_modules/, build output) are never watched: they
//! change constantly, don't affect what Palace shows, and in a large project would use
//! up the system's limit on watched folders. Ignored files and folders coming and going
//! where Palace does watch are reported, as the Files view lists them, but not writes to
//! an ignored file, such as a log.

use git2::{Repository, StatusOptions};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tauri::{Emitter, EventTarget, WebviewWindow};

/// The watcher for each window's repository, by window. Replacing one stops it.
#[derive(Default)]
pub struct RepoWatcher(Mutex<HashMap<String, Arc<Mutex<RecommendedWatcher>>>>);

impl RepoWatcher {
    /// Stops watching for a window that's closed.
    pub fn forget(&self, window: &str) {
        self.0.lock().unwrap().remove(window);
    }
}

#[tauri::command]
pub fn watch_repo(window: WebviewWindow, state: tauri::State<'_, RepoWatcher>, path: String) -> Result<(), String> {
    let label = window.label().to_string();
    let target = EventTarget::webview_window(label.clone());
    let watcher = start(&path, move || {
        let _ = window.emit_to(target.clone(), "repo-changed", ());
    })?;
    state.0.lock().unwrap().insert(label, watcher);
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
    // In a worktree added with `git worktree add`, .git holds only its own HEAD and
    // index: its branches are the main repository's, in the .git they share.
    let common = repo.commondir().to_path_buf();
    // Noted before watching starts, so one made meanwhile comes as an event.
    let mut present = ignored_now(&repo, &workdir);

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
        if common != gitdir {
            let _ = w.watch(&common, RecursiveMode::NonRecursive);
            let _ = w.watch(&common.join("refs"), RecursiveMode::Recursive);
        }
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
                    if !relevant(&repo, &workdir, &gitdir, &common, p, &mut present) {
                        continue;
                    }
                    changed = true;
                    // A new folder needs watching too, unless git ignores it: its coming
                    // shows in the Files view, but what's made in it, as npm install
                    // fills a new node_modules, would refresh on every file.
                    if event.kind.is_create() && p.is_dir() && !p.starts_with(&gitdir) && !ignored(&repo, &workdir, p, true) {
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

/// Whether a change at `path` could alter what Palace shows. `present` holds the ignored
/// files and folders known to be there (see ignored_now), kept up to date as they come
/// and go.
fn relevant(repo: &Repository, workdir: &Path, gitdir: &Path, common: &Path, path: &Path, present: &mut HashSet<PathBuf>) -> bool {
    let first = |inside: &Path| inside.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned());
    let lock = path.extension().is_some_and(|e| e == "lock");
    if let Ok(inside_git) = path.strip_prefix(gitdir) {
        // Objects and reflogs change alongside refs, which are watched anyway; lock
        // files come and go during every git command.
        return !lock && !matches!(first(inside_git).as_deref(), Some("objects" | "logs"));
    }
    // From a worktree, of the .git it shares only the branches and tags matter, and
    // the list of worktrees.
    if let Ok(inside_common) = path.strip_prefix(common) {
        return !lock && matches!(first(inside_common).as_deref(), Some("refs" | "packed-refs" | "worktrees"));
    }
    if !path.starts_with(workdir) {
        return false;
    }
    if !ignored(repo, workdir, path, path.is_dir()) {
        return true;
    }
    // An ignored file or folder coming or going shows in the Files view, muted; one
    // written to doesn't change what's shown. What the event says happened can't tell
    // them apart: macOS goes on calling each write to a file it saw made a creation, so
    // a log written on every request would refresh each time. Whether it's there now,
    // as against before, can. One made and gone again, as SQLite's journal is, isn't
    // reported. Events only come from folders that are watched, which aren't ignored,
    // even new ones (see start), so nothing inside an ignored folder gets here.
    if path.exists() {
        present.insert(path.to_path_buf())
    } else {
        present.remove(path)
    }
}

/// The ignored files and folders in the working copy, but not what's inside an ignored
/// folder, as the Files view lists them. Nor, as libgit2 has it, what's in one a rule
/// ignores but a tracked file keeps, as logs/ with a .gitkeep: one of those is reported
/// the first time it's written to, and known after that.
fn ignored_now(repo: &Repository, workdir: &Path) -> HashSet<PathBuf> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(true).recurse_ignored_dirs(false);
    let Ok(statuses) = repo.statuses(Some(&mut opts)) else { return HashSet::new() };
    statuses
        .iter()
        .filter(|s| s.status().is_ignored())
        .filter_map(|s| s.path().ok().map(|p| workdir.join(p.trim_end_matches('/'))))
        .collect()
}

/// Whether git ignores `path`, in the working copy (see files::ignored).
fn ignored(repo: &Repository, workdir: &Path, path: &Path, is_dir: bool) -> bool {
    let Ok(relative) = path.strip_prefix(workdir) else { return false };
    crate::files::ignored(repo, relative, is_dir)
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

    /// Waits out the reports of the test's own setup. macOS can deliver them well
    /// after the watcher starts, so they're let through rather than counted.
    fn settle(rx: &mpsc::Receiver<()>) {
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < until && rx.recv_timeout(Duration::from_secs(2)).is_ok() {}
    }

    /// Waits out any pending report, then checks nothing more arrives. As it lets
    /// through what's pending, it checks a change was the last reported, not that a
    /// change made just before wasn't: for that, `!reported`.
    fn quiet(rx: &mpsc::Receiver<()>) -> bool {
        while rx.recv_timeout(Duration::from_millis(800)).is_ok() {}
        rx.recv_timeout(Duration::from_millis(1200)).is_err()
    }

    #[test]
    fn edits_commits_and_ignored_files_coming_are_reported_but_writes_to_ignored_ones_are_not() {
        let t = TempRepo::new("watch");
        std::fs::create_dir_all(t.dir.join("vendor/package")).unwrap();
        // A tracked .gitkeep keeps logs/, which the rules ignore, watched.
        t.commit(&[("a.txt", Some("a\n")), ("logs/.gitkeep", Some("")), (".gitignore", Some("vendor/\nlogs/\n.env\nnode_modules/\n*.log\n"))], "First");
        // There before watching starts, as a log is.
        t.write(&[("today.log", Some("started\n"))]);
        let (_watcher, rx) = watch(&t);
        settle(&rx);

        t.write(&[("a.txt", Some("edited\n"))]);
        assert!(reported(&rx), "editing a tracked file");
        assert!(quiet(&rx));

        t.write(&[("vendor/package/lib.php", Some("<?php\n"))]);
        assert!(!reported(&rx), "files in an ignored folder");

        t.write(&[(".env", Some("KEY=1\n"))]);
        assert!(reported(&rx), "an ignored file appearing, as the Files view lists it");
        assert!(quiet(&rx));
        t.write(&[(".env", Some("KEY=2\n"))]);
        assert!(!reported(&rx), "writing to an ignored file");
        t.write(&[("today.log", Some("more\n"))]);
        assert!(!reported(&rx), "writing to an ignored file there before watching");
        t.write(&[("today.log", None)]);
        assert!(reported(&rx), "an ignored file there before watching going");
        assert!(quiet(&rx));

        // As npm install makes node_modules: the folder shows, but isn't watched.
        std::fs::create_dir(t.dir.join("node_modules")).unwrap();
        assert!(reported(&rx), "an ignored folder appearing");
        assert!(quiet(&rx));
        t.write(&[("node_modules/package.js", Some(""))]);
        assert!(!reported(&rx), "files in a new ignored folder");

        t.write(&[("logs/.gitkeep", Some("kept\n"))]);
        assert!(reported(&rx), "editing a tracked file a rule matches");

        git(t.path(), &["commit", "-qam", "Edit"], None).unwrap();
        assert!(reported(&rx), "committing");
    }

    #[test]
    fn files_in_new_folders_are_reported() {
        let t = TempRepo::new("watch-new-dir");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let (_watcher, rx) = watch(&t);
        settle(&rx);

        std::fs::create_dir_all(t.dir.join("app/Models")).unwrap();
        assert!(reported(&rx), "creating folders");
        assert!(quiet(&rx));

        t.write(&[("app/Models/User.php", Some("<?php\n"))]);
        assert!(reported(&rx), "a file inside the new folder");
    }

    #[test]
    fn in_a_worktree_commits_to_the_branches_it_shares_are_reported() {
        let t = TempRepo::new("watch-worktree");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let folder = t.dir.with_file_name(format!("{}-wt", t.dir.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&folder);
        git(t.path(), &["worktree", "add", "-q", "-b", "feature", &folder.to_string_lossy()], None).unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = start(&folder.to_string_lossy(), move || {
            let _ = tx.send(());
        })
        .unwrap();
        settle(&rx);

        // A commit in the main working copy moves a branch the worktree lists.
        t.write(&[("a.txt", Some("edited\n"))]);
        git(t.path(), &["commit", "-qam", "Edit"], None).unwrap();
        assert!(reported(&rx), "committing in the main working copy");
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn dropping_the_watcher_stops_reports() {
        let t = TempRepo::new("watch-stop");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let (watcher, rx) = watch(&t);
        settle(&rx);
        drop(watcher);

        t.write(&[("a.txt", Some("edited\n"))]);
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_err());
    }
}
