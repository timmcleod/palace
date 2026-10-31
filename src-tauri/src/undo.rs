//! Undo and redo. Before and after each operation that can be undone, the UI takes a
//! snapshot of where every branch and tag points, which branch HEAD is on, the stash
//! list, and the files the operation may change; undoing puts the repository back
//! from the second snapshot to the first, and redoing does the opposite. Only what the
//! operation changed is touched, and only if nothing else has changed it since.

use crate::cli::git;
use crate::working::{read_status, remove_empty_parents};
use git2::{BranchType, Index, ObjectType, Oid, Repository, RepositoryState, TreeWalkMode, TreeWalkResult};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Snapshot {
    /// The branch HEAD is on, or None when it's detached.
    head_branch: Option<String>,
    /// The commit HEAD is at; None on a branch with no commits yet.
    head_id: Option<String>,
    /// Every local branch and tag, by full ref name, with the object it points at.
    refs: BTreeMap<String, String>,
    /// Each local branch's upstream as its config has it: (remote, merge).
    upstreams: BTreeMap<String, (String, String)>,
    /// The stash list, newest first: each stash's commit and its description.
    stashes: Vec<(String, String)>,
    /// The files the operation may change, as they were.
    files: Vec<FileState>,
}

/// One file in the index and the working copy. The contents are saved in the
/// repository as blobs, which git keeps for at least two weeks once nothing uses them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileState {
    path: String,
    /// The index entry's mode and blob, or None when the file isn't in the index.
    index: Option<(u32, String)>,
    /// The working copy's file as a mode and blob, or None when there's no file.
    worktree: Option<(u32, String)>,
}

/// The files a snapshot covers.
#[derive(Deserialize, Default)]
pub struct Cover {
    #[serde(default)]
    files: Vec<String>,
    /// Every file with uncommitted changes.
    #[serde(default)]
    changed: bool,
    /// Every file the stash at this index changes.
    stash: Option<usize>,
}

/// Saving more than this much of the working copy makes the operation not undoable.
const LIMIT: u64 = 256 * 1024 * 1024;

const SYMLINK: u32 = 0o120000;
const EXECUTABLE: u32 = 0o100755;
const REGULAR: u32 = 0o100644;

#[tauri::command]
pub async fn take_snapshot(path: String, cover: Option<Cover>) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot(&path, &cover.unwrap_or_default()))
        .await
        .map_err(|e| e.to_string())?
}

/// Moves the repository from the `from` snapshot to the `to` one. `mode` says what
/// happens to the index and files when HEAD's own branch moves: "soft" keeps both
/// (undoing a commit leaves its changes staged), "mixed" keeps the files, and "keep"
/// updates the files as `git reset --keep` does, keeping uncommitted changes.
#[tauri::command]
pub async fn restore_snapshot(path: String, from: Snapshot, to: Snapshot, mode: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || restore(&path, &from, &to, &mode))
        .await
        .map_err(|e| e.to_string())?
}

fn snapshot(path: &str, cover: &Cover) -> Result<Snapshot, String> {
    let mut repo = Repository::discover(path).map_err(message)?;
    let (head_branch, head_id, refs, upstreams) = read_refs(&repo).map_err(message)?;
    let stashes = stash_list(&mut repo).map_err(message)?;
    let files = read_files(&repo, cover)?;
    Ok(Snapshot { head_branch, head_id, refs, upstreams, stashes, files })
}

type Refs = (Option<String>, Option<String>, BTreeMap<String, String>, BTreeMap<String, (String, String)>);

fn read_refs(repo: &Repository) -> Result<Refs, git2::Error> {
    let head = repo.find_reference("HEAD")?;
    let head_branch = head.symbolic_target().ok().flatten().and_then(|t| t.strip_prefix("refs/heads/")).map(str::to_string);
    let head_id = repo.head().ok().and_then(|h| h.target()).map(|id| id.to_string());

    let mut refs = BTreeMap::new();
    for glob in ["refs/heads/*", "refs/tags/*"] {
        for reference in repo.references_glob(glob)?.flatten() {
            if let (Ok(name), Some(id)) = (reference.name(), reference.target()) {
                refs.insert(name.to_string(), id.to_string());
            }
        }
    }

    let config = repo.config()?.snapshot()?;
    let mut upstreams = BTreeMap::new();
    for branch in repo.branches(Some(BranchType::Local))?.flatten() {
        let Some(name) = branch.0.name()?.map(str::to_string) else { continue };
        let remote = config.get_string(&format!("branch.{name}.remote"));
        let merge = config.get_string(&format!("branch.{name}.merge"));
        if let (Ok(remote), Ok(merge)) = (remote, merge) {
            upstreams.insert(name, (remote, merge));
        }
    }

    Ok((head_branch, head_id, refs, upstreams))
}

fn stash_list(repo: &mut Repository) -> Result<Vec<(String, String)>, git2::Error> {
    let mut list = Vec::new();
    repo.stash_foreach(|_, description, id| {
        list.push((id.to_string(), description.to_string()));
        true
    })?;
    Ok(list)
}

fn read_files(repo: &Repository, cover: &Cover) -> Result<Vec<FileState>, String> {
    let paths = covered(repo, cover).map_err(message)?;
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let workdir = repo.workdir().ok_or("This repository has no working copy.")?;
    let index = repo.index().map_err(message)?;
    let mut total = 0;
    paths
        .iter()
        // A submodule's folder: what's in it is the submodule's, not this repository's.
        .filter(|path| !workdir.join(path).symlink_metadata().is_ok_and(|m| m.is_dir()))
        .map(|path| file_state(repo, workdir, &index, path, true, &mut total))
        .collect()
}

fn covered(repo: &Repository, cover: &Cover) -> Result<BTreeSet<String>, git2::Error> {
    let mut paths: BTreeSet<String> = cover.files.iter().cloned().collect();
    if cover.changed {
        for file in read_status(repo)? {
            paths.extend(file.old_path);
            paths.insert(file.path);
        }
    }
    if let Some(index) = cover.stash {
        // A stash is a commit of the working copy whose parents are HEAD, the index
        // and, when it has them, a commit of just the untracked files.
        let stash = repo.revparse_single(&format!("refs/stash@{{{index}}}"))?.peel_to_commit()?;
        let base = stash.parent(0)?.tree()?;
        for tree in [stash.tree()?, stash.parent(1)?.tree()?] {
            for delta in repo.diff_tree_to_tree(Some(&base), Some(&tree), None)?.deltas() {
                for file in [delta.old_file(), delta.new_file()] {
                    paths.extend(file.path().and_then(Path::to_str).map(str::to_string));
                }
            }
        }
        if let Ok(untracked) = stash.parent(2) {
            untracked.tree()?.walk(TreeWalkMode::PreOrder, |dir, entry| {
                if entry.kind() == Some(ObjectType::Blob)
                    && let Ok(name) = entry.name()
                {
                    paths.insert(format!("{dir}{name}"));
                }
                TreeWalkResult::Ok
            })?;
        }
    }
    Ok(paths)
}

/// Where `path` stands in the index and the working copy. With `save`, the contents
/// are written to the repository so they can be put back later.
fn file_state(repo: &Repository, workdir: &Path, index: &Index, path: &str, save: bool, total: &mut u64) -> Result<FileState, String> {
    if (1..=3).any(|stage| index.get_path(Path::new(path), stage).is_some()) {
        return Err(format!("{path} has conflicts."));
    }
    let blob = |bytes: &[u8]| {
        let id = if save { repo.blob(bytes) } else { Oid::hash_object(ObjectType::Blob, bytes) };
        id.map(|id| id.to_string()).map_err(message)
    };
    let full = workdir.join(path);
    let worktree = match full.symlink_metadata() {
        Err(_) => None,
        Ok(meta) if meta.is_symlink() => {
            let target = fs::read_link(&full).map_err(|e| format!("Couldn't read {path}: {e}"))?;
            Some((SYMLINK, blob(target.as_os_str().as_encoded_bytes())?))
        }
        Ok(meta) if meta.is_file() => {
            *total += meta.len();
            if *total > LIMIT {
                return Err("The changes are too large to keep a copy of.".into());
            }
            let bytes = fs::read(&full).map_err(|e| format!("Couldn't read {path}: {e}"))?;
            Some((if executable(&meta) { EXECUTABLE } else { REGULAR }, blob(&bytes)?))
        }
        // A directory, such as a submodule's.
        Ok(_) => return Err(format!("{path} isn't a file.")),
    };
    let index = index.get_path(Path::new(path), 0).map(|entry| (entry.mode, entry.id.to_string()));
    Ok(FileState { path: path.to_string(), index, worktree })
}

#[cfg(unix)]
fn executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_: &fs::Metadata) -> bool {
    false
}

fn restore(path: &str, from: &Snapshot, to: &Snapshot, mode: &str) -> Result<String, String> {
    if !["soft", "mixed", "keep"].contains(&mode) {
        return Err(format!("Unknown mode “{mode}”."));
    }
    let mut repo = Repository::discover(path).map_err(message)?;
    let moves_refs = (&from.head_branch, &from.head_id, &from.refs) != (&to.head_branch, &to.head_id, &to.refs);
    if moves_refs && repo.state() != RepositoryState::Clean {
        return Err("Finish or abort the merge, rebase or other operation in progress first.".into());
    }

    // The stash list and files the operation changed have to be as it left them, and
    // everything to put back still saved, before anything changes.
    let stashes_now = stash_list(&mut repo).map_err(message)?;
    // A stash is only removed when its changes go back into the files, as undoing a
    // stash does. One a pull or merge left behind holds changes found nowhere else.
    let leaves_stash = to.files.is_empty() && from.stashes.iter().any(|s| !to.stashes.contains(s));
    let moves_stashes = from.stashes != to.stashes && !leaves_stash;
    if moves_stashes && stashes_now != from.stashes {
        return Err("The stash list has changed since, so it can't be put back safely.".into());
    }
    let files: Vec<&FileState> = to.files.iter().filter(|file| !from.files.contains(file)).collect();
    if !files.is_empty() {
        let workdir = repo.workdir().ok_or("This repository has no working copy.")?;
        let index = repo.index().map_err(message)?;
        for file in &files {
            let was = from.files.iter().find(|f| f.path == file.path);
            let now = file_state(&repo, workdir, &index, &file.path, false, &mut 0).ok();
            if was.is_none() || now.as_ref() != was {
                return Err(format!("{} has changed since, so it can't be put back safely.", file.path));
            }
            for (_, id) in file.index.iter().chain(&file.worktree) {
                Oid::from_str(id).ok().and_then(|id| repo.find_blob(id).ok()).ok_or_else(|| {
                    format!("The saved copy of {} is gone; git removes unused copies after a while.", file.path)
                })?;
            }
        }
    }

    let mut done = Vec::new();
    if moves_refs {
        restore_refs(path, from, to, mode, &mut done)?;
    }
    if moves_stashes {
        put_stashes(path, &stashes_now, &to.stashes)?;
        done.push(match to.stashes.len().cmp(&stashes_now.len()) {
            std::cmp::Ordering::Greater => "Restored the stash.".to_string(),
            std::cmp::Ordering::Less => "Removed the stash.".to_string(),
            std::cmp::Ordering::Equal => "Restored the stash list.".to_string(),
        });
    }
    if leaves_stash {
        done.push("Kept the stash it left, which holds your changes.".to_string());
    }
    if !files.is_empty() {
        put_files(&repo, path, &files)?;
        done.push(match files.as_slice() {
            [file] => format!("Put back {}.", file.path),
            files => format!("Put back {} files.", files.len()),
        });
    }
    Ok(done.join(" "))
}

fn restore_refs(path: &str, from: &Snapshot, to: &Snapshot, mode: &str, done: &mut Vec<String>) -> Result<(), String> {
    let now = snapshot(path, &Cover::default())?;

    // Everything the operation changed has to be as it left it.
    let changed: BTreeSet<&String> = from
        .refs
        .keys()
        .chain(to.refs.keys())
        .filter(|name| from.refs.get(*name) != to.refs.get(*name))
        .collect();
    for name in &changed {
        if now.refs.get(*name) != from.refs.get(*name) {
            return Err(format!("{} has changed since, so it can't be put back safely.", describe(name)));
        }
    }
    if now.head_branch != from.head_branch || (now.head_branch.is_none() && now.head_id != from.head_id) {
        return Err("HEAD has moved since, so it can't be put back safely.".into());
    }

    let mut pending: BTreeSet<&String> = changed;
    // A branch that went away while another appeared at the same commit was renamed,
    // which `git branch -m` undoes along with its upstream and HEAD.
    let gone: Vec<&String> = pending.iter().copied().filter(|n| is_branch(n) && !to.refs.contains_key(*n)).collect();
    let came: Vec<&String> = pending.iter().copied().filter(|n| is_branch(n) && !from.refs.contains_key(*n)).collect();
    let mut current = now.head_branch.clone();
    if let ([old], [new]) = (gone.as_slice(), came.as_slice())
        && from.refs[*old] == to.refs[*new]
    {
        pending.retain(|n| n != old && n != new);
        let (old, new) = (short(old), short(new));
        git(path, &["branch", "-m", old, new], None)?;
        if current.as_deref() == Some(old) {
            current = Some(new.to_string());
        }
        done.push(format!("Renamed {old} to {new}."));
    }

    let head_ref = |branch: &Option<String>| branch.as_ref().map(|b| format!("refs/heads/{b}"));
    if current == to.head_branch {
        // HEAD stays put, so its branch (or a detached HEAD) moves with a reset.
        let target = match &to.head_branch {
            Some(branch) => to.refs.get(&format!("refs/heads/{branch}")).cloned(),
            None => to.head_id.clone(),
        };
        let moved = match &to.head_branch {
            Some(_) => head_ref(&current).is_some_and(|r| pending.remove(&r)),
            None => now.head_id != to.head_id,
        };
        if moved {
            match &target {
                Some(id) => {
                    git(path, &["reset", "--quiet", &format!("--{mode}"), id], None).map_err(|e| explain(&e))?;
                    done.push(format!("Moved {} to {}.", current.as_deref().unwrap_or("HEAD"), &id[..7]));
                }
                // Back before a branch's first commit.
                None => {
                    let name = head_ref(&current).expect("only a branch can have no commits");
                    git(path, &["update-ref", "-d", &name], None)?;
                    done.push(format!("Took {} back to before its first commit.", short(&name)));
                }
            }
        }
    } else {
        // HEAD changes branch. The branch it goes to has to be in place first, and
        // the one it leaves can only change once it's no longer checked out.
        let target_ref = head_ref(&to.head_branch);
        let prepared = match &target_ref {
            Some(name) if pending.remove(name) => {
                set_ref(path, name, now.refs.get(name), to.refs.get(name), to)?;
                true
            }
            _ => false,
        };
        let switched = match &to.head_branch {
            Some(branch) => git(path, &["switch", "--quiet", "--no-guess", branch], None),
            None => match &to.head_id {
                Some(id) => git(path, &["switch", "--quiet", "--detach", id], None),
                None => Err("There's no commit to go back to.".into()),
            },
        };
        if let Err(e) = switched {
            if prepared {
                let name = target_ref.as_ref().unwrap();
                let _ = set_ref(path, name, to.refs.get(name), now.refs.get(name), &now);
            }
            return Err(explain(&e));
        }
        done.push(match &to.head_branch {
            Some(branch) => format!("Switched to {branch}."),
            None => format!("Switched to {} (detached).", &to.head_id.as_ref().unwrap()[..7]),
        });
    }

    for name in pending {
        let message = set_ref(path, name, now.refs.get(name), to.refs.get(name), to)?;
        done.push(message);
    }
    Ok(())
}

/// Replaces the stash list `now` with `to`. Git keeps the list as the stash ref's log,
/// so it's rebuilt from the oldest stash up; the stashes themselves are commits that
/// stay in the repository.
fn put_stashes(path: &str, now: &[(String, String)], to: &[(String, String)]) -> Result<(), String> {
    let rebuild = |list: &[(String, String)]| -> Result<(), String> {
        if git(path, &["rev-parse", "--verify", "--quiet", "refs/stash"], None).is_ok() {
            git(path, &["update-ref", "-d", "refs/stash"], None)?;
        }
        for (id, description) in list.iter().rev() {
            git(path, &["stash", "store", "--quiet", "--message", description, id], None)?;
        }
        Ok(())
    };
    // Halfway through, the list would be missing stashes: put back the one there was.
    rebuild(to).inspect_err(|_| {
        let _ = rebuild(now);
    })
}

/// Puts files back in the index and the working copy as `files` has them.
fn put_files(repo: &Repository, path: &str, files: &[&FileState]) -> Result<(), String> {
    let workdir = repo.workdir().ok_or("This repository has no working copy.")?;
    // What's there goes first, so a file can come back where a folder of
    // another's was emptied.
    for file in files {
        let full = workdir.join(&file.path);
        if full.symlink_metadata().is_ok() {
            fs::remove_file(&full).map_err(|e| format!("Couldn't replace {}: {e}", file.path))?;
            remove_empty_parents(workdir, &full);
        }
    }
    let mut entries = String::new();
    for file in files {
        if let Some((mode, id)) = &file.worktree {
            let blob = repo.find_blob(Oid::from_str(id).map_err(message)?).map_err(message)?;
            write_file(&workdir.join(&file.path), *mode, blob.content()).map_err(|e| format!("Couldn't write {}: {e}", file.path))?;
        }
        let (mode, id) = file.index.clone().unwrap_or((0, Oid::ZERO_SHA1.to_string()));
        entries.push_str(&format!("{mode:o} {id}\t{}\0", file.path));
    }
    // Mode 0 takes a file out of the index.
    git(path, &["update-index", "-z", "--index-info"], Some(&entries))?;
    // The rewritten files' entries need fresh timestamps to show as unchanged.
    let _ = git(path, &["update-index", "-q", "--refresh"], None);
    Ok(())
}

fn write_file(full: &Path, mode: u32, content: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = full.parent() {
        fs::create_dir_all(dir)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::{PermissionsExt, symlink};
        if mode == SYMLINK {
            return symlink(std::ffi::OsStr::from_bytes(content), full);
        }
        fs::write(full, content)?;
        if mode == EXECUTABLE {
            fs::set_permissions(full, fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        fs::write(full, content)
    }
}

/// Creates, moves or deletes one branch or tag, checking it's still at `old`.
fn set_ref(path: &str, name: &str, old: Option<&String>, new: Option<&String>, to: &Snapshot) -> Result<String, String> {
    match (old, new) {
        (Some(_), None) if is_branch(name) => {
            // Deleting it this way also drops its upstream from the config.
            git(path, &["branch", "--quiet", "-D", short(name)], None)?;
            Ok(format!("Deleted {}.", describe(name)))
        }
        (Some(old), None) => {
            git(path, &["update-ref", "-d", name, old], None)?;
            Ok(format!("Deleted {}.", describe(name)))
        }
        (None, Some(new)) => {
            git(path, &["update-ref", name, new, ""], None)?;
            if let Some((remote, merge)) = to.upstreams.get(short(name)) {
                let branch = short(name);
                git(path, &["config", &format!("branch.{branch}.remote"), remote], None)?;
                git(path, &["config", &format!("branch.{branch}.merge"), merge], None)?;
            }
            Ok(format!("Restored {} at {}.", describe(name), &new[..7]))
        }
        (Some(old), Some(new)) => {
            git(path, &["update-ref", name, new, old], None)?;
            Ok(format!("Moved {} to {}.", describe(name), &new[..7]))
        }
        (None, None) => Ok(String::new()),
    }
}

fn is_branch(name: &str) -> bool {
    name.starts_with("refs/heads/")
}

fn short(name: &str) -> &str {
    name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/tags/")).unwrap_or(name)
}

fn describe(name: &str) -> String {
    if is_branch(name) { format!("“{}”", short(name)) } else { format!("the tag “{}”", short(name)) }
}

/// Switching and `reset --keep` refuse to overwrite uncommitted changes.
fn explain(error: &str) -> String {
    if error.contains("would be overwritten") || error.contains("not uptodate") {
        "It would overwrite your uncommitted changes. Commit or stash them first, then try again.".into()
    } else {
        error.to_string()
    }
}

fn message(e: git2::Error) -> String {
    e.message().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;
    use std::fs::read_to_string;
    use tauri::async_runtime::block_on as run;

    /// Snapshots around `action`, returning (before, after).
    fn around(t: &TempRepo, action: impl FnOnce()) -> (Snapshot, Snapshot) {
        covering(t, Cover::default(), action)
    }

    /// Snapshots `cover`'s files around `action`, as the UI does: the second snapshot
    /// covers the files the first did.
    fn covering(t: &TempRepo, cover: Cover, action: impl FnOnce()) -> (Snapshot, Snapshot) {
        let before = snapshot(t.path(), &cover).unwrap();
        action();
        let files = before.files.iter().map(|f| f.path.clone()).collect();
        (before, snapshot(t.path(), &Cover { files, ..Default::default() }).unwrap())
    }

    fn files(paths: &[&str]) -> Cover {
        Cover { files: paths.iter().map(|p| p.to_string()).collect(), ..Default::default() }
    }

    fn undo(t: &TempRepo, (before, after): &(Snapshot, Snapshot), mode: &str) -> Result<String, String> {
        restore(t.path(), after, before, mode)
    }

    fn redo(t: &TempRepo, (before, after): &(Snapshot, Snapshot), mode: &str) -> Result<String, String> {
        restore(t.path(), before, after, mode)
    }

    fn read(t: &TempRepo, file: &str) -> String {
        read_to_string(t.dir.join(file)).unwrap()
    }

    fn stash_count(t: &TempRepo) -> usize {
        git(t.path(), &["stash", "list"], None).unwrap().lines().count()
    }

    /// Discards the way the app does, except that files go nowhere instead of the Trash.
    fn discard(t: &TempRepo, paths: &[&str]) {
        let paths: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
        crate::working::discard(t.path(), &paths, &|f| fs::remove_file(f).map_err(|e| e.to_string())).unwrap();
    }

    #[test]
    fn undoing_a_discard_brings_back_staged_unstaged_and_new_files() {
        let t = TempRepo::new("undo-discard");
        t.commit(&[("a.txt", Some("1\n")), ("run.sh", Some("echo\n"))], "First");
        t.write(&[("a.txt", Some("staged\n"))]);
        git(t.path(), &["add", "a.txt"], None).unwrap();
        t.write(&[("a.txt", Some("staged\nand not\n")), ("dir/new.txt", Some("new\n")), ("run.sh", None)]);
        let was = status(&t);

        let step = covering(&t, files(&["a.txt", "dir/new.txt", "run.sh"]), || discard(&t, &["a.txt", "dir/new.txt", "run.sh"]));
        assert_eq!(status(&t), "");
        assert!(!t.dir.join("dir").exists());

        assert_eq!(undo(&t, &step, "keep").unwrap(), "Put back 3 files.");
        assert_eq!(status(&t), was);
        assert_eq!(read(&t, "a.txt"), "staged\nand not\n");
        assert_eq!(read(&t, "dir/new.txt"), "new\n");

        redo(&t, &step, "keep").unwrap();
        assert_eq!(status(&t), "");
    }

    #[test]
    fn undoing_a_discarded_chunk() {
        let t = TempRepo::new("undo-hunk");
        t.commit(&[("a.txt", Some("1\n2\n3\n"))], "First");
        t.write(&[("a.txt", Some("1\ntwo\n3\n"))]);
        let step = covering(&t, files(&["a.txt"]), || crate::working::discard_lines(t.path(), "a.txt", 0, None).unwrap());
        assert_eq!(read(&t, "a.txt"), "1\n2\n3\n");

        assert_eq!(undo(&t, &step, "keep").unwrap(), "Put back a.txt.");
        assert_eq!(read(&t, "a.txt"), "1\ntwo\n3\n");
        assert_eq!(status(&t), "M a.txt");
    }

    #[cfg(unix)]
    #[test]
    fn undoing_a_discard_keeps_executables_and_links() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let t = TempRepo::new("undo-modes");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        t.write(&[("tool.sh", Some("echo\n"))]);
        fs::set_permissions(t.dir.join("tool.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        symlink("a.txt", t.dir.join("link")).unwrap();

        let step = covering(&t, files(&["tool.sh", "link"]), || discard(&t, &["tool.sh", "link"]));
        undo(&t, &step, "keep").unwrap();
        assert_ne!(fs::metadata(t.dir.join("tool.sh")).unwrap().permissions().mode() & 0o111, 0);
        assert_eq!(fs::read_link(t.dir.join("link")).unwrap(), Path::new("a.txt"));
    }

    #[test]
    fn a_discard_edited_since_isnt_undone() {
        let t = TempRepo::new("undo-discard-stale");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        t.write(&[("a.txt", Some("2\n"))]);
        let step = covering(&t, files(&["a.txt"]), || discard(&t, &["a.txt"]));
        t.write(&[("a.txt", Some("3\n"))]);

        let error = undo(&t, &step, "keep").unwrap_err();
        assert_eq!(error, "a.txt has changed since, so it can't be put back safely.");
        assert_eq!(read(&t, "a.txt"), "3\n");
    }

    #[test]
    fn undoing_a_stash_puts_the_changes_back() {
        let t = TempRepo::new("undo-stash");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        t.write(&[("a.txt", Some("2\n")), ("new.txt", Some("new\n"))]);
        let cover = Cover { changed: true, ..Default::default() };
        let step = covering(&t, cover, || {
            run(crate::stash::stash_save(t.path().into(), Some("Mine".into()), true, None)).unwrap();
        });
        assert_eq!((status(&t).as_str(), stash_count(&t)), ("", 1));

        assert_eq!(undo(&t, &step, "keep").unwrap(), "Removed the stash. Put back 2 files.");
        assert_eq!(stash_count(&t), 0);
        assert_eq!(status(&t), "M a.txt\n?? new.txt");

        redo(&t, &step, "keep").unwrap();
        assert_eq!((status(&t).as_str(), stash_count(&t)), ("", 1));
        assert!(git(t.path(), &["stash", "list"], None).unwrap().ends_with(": Mine"));
    }

    #[test]
    fn undoing_a_pop_and_a_drop_brings_the_stash_back() {
        let t = TempRepo::new("undo-pop");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        t.write(&[("a.txt", Some("older\n"))]);
        git(t.path(), &["stash", "push", "-qm", "Older"], None).unwrap();
        t.write(&[("a.txt", Some("2\n")), ("new.txt", Some("new\n"))]);
        git(t.path(), &["stash", "push", "-qum", "Newer"], None).unwrap();
        let list = git(t.path(), &["stash", "list"], None).unwrap();

        let cover = Cover { stash: Some(0), ..Default::default() };
        let pop = covering(&t, cover, || {
            run(crate::stash::stash_apply(t.path().into(), 0, true)).unwrap();
        });
        assert_eq!(read(&t, "new.txt"), "new\n");
        undo(&t, &pop, "keep").unwrap();
        assert_eq!(git(t.path(), &["stash", "list"], None).unwrap(), list);
        assert_eq!(status(&t), "");

        let drop = around(&t, || {
            run(crate::stash::stash_drop(t.path().into(), 1)).unwrap();
        });
        assert_eq!(undo(&t, &drop, "keep").unwrap(), "Restored the stash.");
        assert_eq!(git(t.path(), &["stash", "list"], None).unwrap(), list);
    }

    /// `git status --porcelain`, trimmed.
    fn status(t: &TempRepo) -> String {
        git(t.path(), &["status", "--porcelain"], None).unwrap()
    }

    #[test]
    fn undoing_a_commit_leaves_its_changes_staged() {
        let t = TempRepo::new("undo-commit");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        t.write(&[("a.txt", Some("2\n"))]);
        let step = around(&t, || {
            git(t.path(), &["commit", "-qam", "Second"], None).unwrap();
        });
        let second = t.head();
        assert_ne!(second, first);

        let message = undo(&t, &step, "soft").unwrap();
        assert_eq!(message, format!("Moved {} to {}.", t.branch(), &first.to_string()[..7]));
        assert_eq!(t.head(), first);
        assert_eq!(status(&t), "M  a.txt");

        redo(&t, &step, "soft").unwrap();
        assert_eq!(t.head(), second);
        assert_eq!(status(&t), "");
    }

    #[test]
    fn undoing_the_first_commit_leaves_an_empty_branch() {
        let t = TempRepo::new("undo-first");
        let step = around(&t, || {
            t.commit(&[("a.txt", Some("1\n"))], "First");
        });
        let branch = step.1.head_branch.clone().unwrap();
        let message = undo(&t, &step, "soft").unwrap();
        assert_eq!(message, format!("Took {branch} back to before its first commit."));
        assert!(t.repo.head().is_err());
        assert_eq!(status(&t), "A  a.txt");
    }

    #[test]
    fn undoing_a_merge_puts_the_files_back() {
        let t = TempRepo::new("undo-merge");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        t.commit(&[("b.txt", Some("feature\n"))], "Feature");
        git(t.path(), &["switch", "-q", &main], None).unwrap();
        // An uncommitted edit the merge doesn't touch is kept throughout.
        t.write(&[("a.txt", Some("edited\n"))]);

        let step = around(&t, || {
            git(t.path(), &["merge", "-q", "--no-ff", "-m", "Merge", "feature"], None).unwrap();
        });
        assert!(t.dir.join("b.txt").exists());

        undo(&t, &step, "keep").unwrap();
        assert_eq!(t.head(), first);
        assert!(!t.dir.join("b.txt").exists());
        assert_eq!(read_to_string(t.dir.join("a.txt")).unwrap(), "edited\n");
    }

    #[test]
    fn undoing_a_merge_keeps_the_stash_it_left_behind() {
        let t = TempRepo::new("undo-autostash");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        t.commit(&[("a.txt", Some("feature\n"))], "Feature");
        git(t.path(), &["switch", "-q", &main], None).unwrap();
        t.write(&[("a.txt", Some("mine\n"))]);

        // The changes set aside conflict when put back, so git keeps them as a stash.
        let step = around(&t, || {
            git(t.path(), &["merge", "-q", "--autostash", "feature"], None).unwrap();
        });
        assert_eq!(stash_count(&t), 1);
        git(t.path(), &["checkout", "-q", "HEAD", "--", "a.txt"], None).unwrap();
        git(t.path(), &["reset", "-q"], None).unwrap();

        let message = undo(&t, &step, "keep").unwrap();
        assert!(message.contains("Kept the stash"), "{message}");
        assert_eq!(t.head(), first);
        assert_eq!(stash_count(&t), 1);
    }

    #[test]
    fn undoing_a_mixed_reset_commits_the_changes_again() {
        let t = TempRepo::new("undo-reset");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let second = t.commit(&[("a.txt", Some("2\n"))], "Second");
        let step = around(&t, || {
            run(crate::reset::reset(t.path().into(), first.to_string(), true)).unwrap();
        });
        assert_eq!(status(&t), "M a.txt");

        undo(&t, &step, "mixed").unwrap();
        assert_eq!(t.head(), second);
        assert_eq!(status(&t), "");
    }

    #[test]
    fn undoing_a_checkout_switches_back() {
        let t = TempRepo::new("undo-checkout");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        // Checking out a new branch creates it too; undoing removes it again.
        let step = around(&t, || {
            run(crate::branch::create_branch(t.path().into(), "feature".into(), None, true)).unwrap();
        });
        assert_eq!(t.branch(), "feature");

        assert_eq!(undo(&t, &step, "keep").unwrap(), format!("Switched to {main}. Deleted “feature”."));
        assert_eq!(t.branch(), main);
        assert!(t.repo.find_branch("feature", BranchType::Local).is_err());

        redo(&t, &step, "keep").unwrap();
        assert_eq!(t.branch(), "feature");
    }

    #[test]
    fn undoing_a_branch_deletion_restores_it_with_its_upstream() {
        let server = TempRepo::bare("undo-delete-server");
        let t = TempRepo::clone_of("undo-delete", &server);
        t.commit(&[("a.txt", Some("1\n"))], "First");
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        let tip = t.commit(&[("b.txt", Some("2\n"))], "Feature");
        git(t.path(), &["push", "-qu", "origin", "feature"], None).unwrap();
        git(t.path(), &["switch", "-q", "-"], None).unwrap();

        let step = around(&t, || {
            run(crate::branch::delete_branch(t.path().into(), "feature".into(), true)).unwrap();
        });
        undo(&t, &step, "keep").unwrap();
        let branch = t.repo.find_branch("feature", BranchType::Local).unwrap();
        assert_eq!(branch.get().target(), Some(tip));
        assert_eq!(branch.upstream().unwrap().name().unwrap(), Some("origin/feature"));
    }

    #[test]
    fn undoing_a_rename_of_the_current_branch() {
        let t = TempRepo::new("undo-rename");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        let step = around(&t, || {
            run(crate::branch::rename_branch(t.path().into(), main.clone(), "trunk".into())).unwrap();
            // A tag with the same name, made in the same step, is undone separately.
            git(t.path(), &["tag", "trunk"], None).unwrap();
        });
        assert_eq!(undo(&t, &step, "keep").unwrap(), format!("Renamed trunk to {main}. Deleted the tag “trunk”."));
        assert_eq!(t.branch(), main);
        assert!(t.repo.find_reference("refs/tags/trunk").is_err());
    }

    #[test]
    fn undoing_tags() {
        let t = TempRepo::new("undo-tags");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let create = around(&t, || {
            run(crate::tag::create_tag(t.path().into(), "v1".into(), None, Some("Version 1".into()))).unwrap();
        });
        let delete = around(&t, || {
            run(crate::tag::delete_tag(t.path().into(), "v1".into())).unwrap();
        });
        undo(&t, &delete, "keep").unwrap();
        let tag = t.repo.find_reference("refs/tags/v1").unwrap();
        assert_eq!(tag.peel_to_commit().unwrap().id(), first);
        assert_eq!(undo(&t, &create, "keep").unwrap(), "Deleted the tag “v1”.");
        assert!(t.repo.find_reference("refs/tags/v1").is_err());
    }

    #[test]
    fn nothing_changes_if_the_branch_has_moved_since() {
        let t = TempRepo::new("undo-stale");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let step = around(&t, || {
            t.commit(&[("a.txt", Some("2\n"))], "Second");
        });
        let third = t.commit(&[("a.txt", Some("3\n"))], "Third");

        let error = undo(&t, &step, "soft").unwrap_err();
        assert_eq!(error, format!("“{}” has changed since, so it can't be put back safely.", t.branch()));
        assert_eq!(t.head(), third);
        assert_ne!(t.head(), first);
    }

    #[test]
    fn local_changes_in_the_way_stop_the_undo() {
        let t = TempRepo::new("undo-blocked");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        t.commit(&[("a.txt", Some("feature\n"))], "Feature");
        let step = around(&t, || {
            run(crate::branch::checkout(t.path().into(), "branch".into(), main.clone())).unwrap();
        });
        t.write(&[("a.txt", Some("mine\n"))]);

        let error = undo(&t, &step, "keep").unwrap_err();
        assert!(error.starts_with("It would overwrite your uncommitted changes."), "{error}");
        assert_eq!(t.branch(), main);
        assert_eq!(read_to_string(t.dir.join("a.txt")).unwrap(), "mine\n");
    }
}
