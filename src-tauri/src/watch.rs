//! Watches each repository a window has open and tells that window when something in it
//! changes, saying which, so edits made in an editor or terminal show up without
//! switching back to Palace.
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
use crate::per_repo::PerRepo;
use serde::Serialize;
use tauri::{Emitter, EventTarget, Manager, WebviewWindow};

/// The watcher for each repository a window has open (see per_repo.rs). Replacing one,
/// or letting it go, stops it.
///
/// A watcher takes a while to set up (see watch_repo), and the page may let go of the
/// repository meanwhile, or close the window. So each request to watch one is numbered,
/// by window and repository, and a watcher is kept only while its request is still the
/// latest: letting go, or a newer request, or the window closing, leaves the one being
/// set up to be dropped as it's done, rather than kept, watching for nobody.
#[derive(Default)]
pub struct RepoWatcher {
    watchers: PerRepo<Arc<Mutex<RecommendedWatcher>>>,
    /// The latest request for each, by window and repository. Taken before `watchers`,
    /// so a watcher's kept, or let go of, as one.
    asked: Mutex<HashMap<(String, String), u64>>,
}

impl RepoWatcher {
    /// A new request to watch the repository at `path` for the window: its number.
    fn ask(&self, window: &str, path: &str) -> u64 {
        let mut asked = self.asked.lock().unwrap();
        let latest = asked.entry((window.to_string(), path.to_string())).or_default();
        *latest += 1;
        *latest
    }

    /// Keeps `watcher`, set up for the request numbered `request`, if that's still the
    /// latest; otherwise it's dropped, and stops.
    fn keep(&self, window: &str, path: &str, request: u64, watcher: Arc<Mutex<RecommendedWatcher>>) {
        // What's dropped, the one replaced or this one, is dropped with the locks let go
        // of, as dropping a watcher waits for its thread.
        let dropped = {
            let asked = self.asked.lock().unwrap();
            if asked.get(&(window.to_string(), path.to_string())) == Some(&request) {
                self.watchers.set(window, path, watcher)
            } else {
                Some(watcher)
            }
        };
        drop(dropped);
    }

    /// Stops watching the repository at `path` for the window, as it's done with it,
    /// and any watcher still being set up for it.
    pub fn release(&self, window: &str, path: &str) {
        let released = {
            let mut asked = self.asked.lock().unwrap();
            if let Some(latest) = asked.get_mut(&(window.to_string(), path.to_string())) {
                *latest += 1;
            }
            self.watchers.release(window, path)
        };
        drop(released);
    }

    /// Stops watching for a window that's closed, and setting up watchers for it.
    pub fn forget(&self, window: &str) {
        let forgotten = {
            let mut asked = self.asked.lock().unwrap();
            asked.retain(|(w, _), _| w != window);
            self.watchers.forget(window)
        };
        drop(forgotten);
    }

    #[cfg(test)]
    fn watching(&self, window: &str, path: &str) -> bool {
        self.watchers.release(window, path).is_some()
    }
}

/// Which repository changed, as the page asked for it to be watched.
#[derive(Serialize, Clone)]
struct Changed {
    path: String,
}

/// Starts watching the repository at `path` for the window. Off the main thread: it
/// walks the working tree first (see start), which takes a while in a large one, and a
/// window opening several tabs at once would otherwise stand still for all of them.
#[tauri::command]
pub async fn watch_repo(window: WebviewWindow, path: String) -> Result<(), String> {
    let request = window.state::<RepoWatcher>().ask(window.label(), &path);
    tauri::async_runtime::spawn_blocking(move || {
        let label = window.label().to_string();
        let target = EventTarget::webview_window(label.clone());
        let changed = Changed { path: path.clone() };
        let emitter = window.clone();
        let watcher = start(&path, move || {
            let _ = emitter.emit_to(target.clone(), "repo-changed", changed.clone());
        })?;
        window.state::<RepoWatcher>().keep(&label, &path, request, watcher);
        Ok(())
    })
    .await
    .map_err(|e| format!("Couldn't watch the repository: {e}"))?
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
        // Noted here, rather than before watching starts: watch_repo runs on the main
        // thread, and in a large repository the walk takes a while. One made during it
        // is noted by it, and its coming not reported, as the Files view, reading the
        // folder as it opens, will most likely show it anyway.
        let mut present = ignored_now(&repo, &workdir);
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
                    // fills a new node_modules, would refresh on every file. Not one
                    // linked to, as `ln -s ~ home` is: that's elsewhere, maybe all of it.
                    let folder = p.symlink_metadata().is_ok_and(|m| m.is_dir());
                    if event.kind.is_create() && folder && !p.starts_with(&gitdir) && !ignored(&repo, &workdir, p, true) {
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
    // In a folder git ignores, as one watched before a rule for it was added, such as
    // dist/ once a build's output is seen: what's made there isn't shown, and a build
    // watching for changes would otherwise refresh the window every time it writes.
    if path.parent().is_some_and(|folder| folder != workdir && ignored(repo, workdir, folder, true)) {
        return false;
    }
    // Whether it's there, as itself, as git sees it: a link, to a folder or to nothing,
    // is a file.
    let meta = path.symlink_metadata();
    let there = meta.is_ok();
    // Gone, it's no longer a folder on disk, so a folder-only rule such as "node_modules/"
    // wouldn't match it: one known to be there is asked about as a folder. A rule that
    // isn't folder-only matches files and folders alike, so a file asked about that way
    // still matches as it did.
    let is_dir = meta.is_ok_and(|m| m.is_dir()) || (!there && present.contains(path));
    if !ignored(repo, workdir, path, is_dir) {
        return true;
    }
    // An ignored file or folder coming or going shows in the Files view, muted; one
    // written to doesn't change what's shown. What the event says happened can't tell
    // them apart: macOS goes on calling each write to a file it saw made a creation, so
    // a log written on every request would refresh each time. Whether it's there now,
    // as against before, can. One made and gone again, as SQLite's journal is, isn't
    // reported. Nothing inside an ignored folder gets here (see above).
    if there {
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
    fn an_ignored_folder_removed_and_made_again_is_reported_both_times() {
        let t = TempRepo::new("watch-ignored-again");
        t.commit(&[("a.txt", Some("a\n")), (".gitignore", Some("node_modules/\n"))], "First");
        // As after npm install, before Palace starts watching.
        std::fs::create_dir(t.dir.join("node_modules")).unwrap();
        let (_watcher, rx) = watch(&t);
        settle(&rx);

        std::fs::remove_dir_all(t.dir.join("node_modules")).unwrap();
        assert!(reported(&rx), "removing it");
        assert!(quiet(&rx));
        std::fs::create_dir(t.dir.join("node_modules")).unwrap();
        assert!(reported(&rx), "making it again, as npm install does");
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
    fn a_watcher_set_up_after_its_repository_was_let_go_of_is_not_kept() {
        let t = TempRepo::new("watch-late");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let path = t.dir.to_string_lossy().into_owned();
        let watchers = RepoWatcher::default();
        let set_up = || start(&path, || {}).unwrap();

        // Let go of while it was set up: dropped.
        let request = watchers.ask("main", &path);
        watchers.release("main", &path);
        watchers.keep("main", &path, request, set_up());
        assert!(!watchers.watching("main", &path));

        // A newer request meanwhile: only the newer one's kept.
        let older = watchers.ask("main", &path);
        let newer = watchers.ask("main", &path);
        watchers.keep("main", &path, older, set_up());
        assert!(!watchers.watching("main", &path));
        watchers.keep("main", &path, newer, set_up());
        assert!(watchers.watching("main", &path));

        // Its window closed meanwhile: dropped.
        let request = watchers.ask("main", &path);
        watchers.forget("main");
        watchers.keep("main", &path, request, set_up());
        assert!(!watchers.watching("main", &path));
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

    #[test]
    fn a_folder_ignored_while_watched_is_quiet_after() {
        let t = TempRepo::new("watch-ignored-later");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let (_watcher, rx) = watch(&t);
        settle(&rx);

        // A build's output seen, then ignored, as it's added to .gitignore.
        t.write(&[("dist/app.js", Some("1\n"))]);
        assert!(reported(&rx), "a new folder, not ignored yet");
        assert!(quiet(&rx));
        t.write(&[(".gitignore", Some("dist/\n"))]);
        assert!(reported(&rx), "the rule added");
        assert!(quiet(&rx));
        t.write(&[("dist/chunk.js", Some("2\n"))]);
        assert!(!reported(&rx), "a file made in it once it's ignored");
    }
}
