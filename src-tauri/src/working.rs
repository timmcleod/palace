//! The working copy: what has changed since HEAD, staging those changes, and
//! committing them.
//!
//! Reading uses git2. Anything that changes the repository runs the git CLI instead,
//! so hooks, signing and the user's git config apply exactly as they do in a terminal.

use crate::cli::git;
use crate::commit::{FileDiff, file_diff_from_patch};
use git2::{Diff, DiffFindOptions, DiffOptions, ErrorCode, Patch, Repository, StatusOptions, Tree};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct WorkingFile {
    path: String,
    /// The path before a staged rename.
    old_path: Option<String>,
    /// Change between HEAD and the index: "added", "modified", "deleted", "renamed"
    /// or "typechange".
    staged: Option<&'static str>,
    /// Change between the index and the working copy: "untracked", "modified",
    /// "deleted", "renamed" or "typechange".
    unstaged: Option<&'static str>,
    conflicted: bool,
}

#[tauri::command]
pub async fn working_status(path: String) -> Result<Vec<WorkingFile>, String> {
    let repo = Repository::discover(&path).map_err(message)?;
    read_status(&repo).map_err(message)
}

/// The staged or unstaged diff of one file in the working copy.
#[tauri::command]
pub async fn working_diff(
    path: String,
    file: String,
    old_path: Option<String>,
    staged: bool,
    max_lines: Option<usize>,
) -> Result<FileDiff, String> {
    read_working_diff(&path, &file, old_path.as_deref(), staged, max_lines).map_err(message)
}

#[tauri::command]
pub async fn stage_files(path: String, files: Vec<String>) -> Result<(), String> {
    stage(&path, &files)
}

#[tauri::command]
pub async fn unstage_files(path: String, files: Vec<String>) -> Result<(), String> {
    unstage(&path, &files)
}

/// Stages one hunk of a file's unstaged diff, or with `staged` set, unstages one hunk
/// of its staged diff. `hunk` indexes the hunks returned by `working_diff`.
#[tauri::command]
pub async fn stage_hunk(
    path: String,
    file: String,
    old_path: Option<String>,
    staged: bool,
    hunk: usize,
) -> Result<(), String> {
    apply_hunk(&path, &file, old_path.as_deref(), staged, hunk)
}

/// Throws away all changes to the listed files, staged and unstaged, returning them to
/// how they are in HEAD. The current version of each file goes to the Trash first, so
/// a mistaken discard can be recovered.
#[tauri::command]
pub async fn discard_files(path: String, files: Vec<String>) -> Result<(), String> {
    discard(&path, &files, &move_to_trash)
}

/// Throws away one hunk of a file's unstaged changes.
#[tauri::command]
pub async fn discard_hunk(path: String, file: String, hunk: usize) -> Result<(), String> {
    let patch = hunk_patch(&path, &file, None, false, hunk)?;
    git(&path, &["apply", "--reverse", "--whitespace=nowarn", "-"], Some(&patch)).map(drop)
}

#[tauri::command]
pub async fn commit_changes(path: String, message: String, amend: bool) -> Result<(), String> {
    commit(&path, &message, amend)
}

/// A conflicted file's contents as they are in the working copy, conflict markers
/// and all.
#[tauri::command]
pub async fn conflict_file(path: String, file: String) -> Result<String, String> {
    let repo = Repository::discover(&path).map_err(message)?;
    let full = repo.workdir().ok_or("This repository has no working copy.")?.join(&file);
    let bytes = std::fs::read(&full).map_err(|e| format!("Couldn't read {file}: {e}"))?;
    // A huge file would make an unusable view; the editor is the place for those.
    const LIMIT: usize = 2 * 1024 * 1024;
    if bytes.len() > LIMIT {
        return Err(format!("{file} is too large to show here. Open it in your editor to resolve it."));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Resolves a conflicted file by taking one side ("current" is HEAD's version,
/// "incoming" is the change being merged, rebased or applied), or with "resolved",
/// by staging it as it is in the working copy.
#[tauri::command]
pub async fn resolve_conflict(path: String, file: String, side: String) -> Result<(), String> {
    resolve(&path, &file, &side)
}

#[tauri::command]
pub async fn open_in_editor(app: tauri::AppHandle, path: String, file: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let repo = Repository::discover(&path).map_err(message)?;
    let full = repo.workdir().ok_or("This repository has no working copy.")?.join(&file);
    app.opener()
        .open_path(full.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Couldn't open {file}: {e}"))
}

#[derive(Serialize)]
pub struct HeadCommit {
    message: String,
    /// Whether the commit is already on the branch's upstream, so amending it would
    /// mean force pushing.
    pushed: bool,
}

/// The commit an amend would replace, or None before the first commit.
#[tauri::command]
pub async fn head_commit(path: String) -> Result<Option<HeadCommit>, String> {
    read_head_commit(&path).map_err(message)
}

impl WorkingFile {
    pub(crate) fn is_conflicted(&self) -> bool {
        self.conflicted
    }
}

pub(crate) fn read_status(repo: &Repository) -> Result<Vec<WorkingFile>, git2::Error> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true);

    let mut files = Vec::new();
    for entry in repo.statuses(Some(&mut opts))?.iter() {
        let s = entry.status();
        if s.is_ignored() {
            continue;
        }

        let staged = if s.is_index_new() {
            Some("added")
        } else if s.is_index_modified() {
            Some("modified")
        } else if s.is_index_deleted() {
            Some("deleted")
        } else if s.is_index_renamed() {
            Some("renamed")
        } else if s.is_index_typechange() {
            Some("typechange")
        } else {
            None
        };
        let unstaged = if s.is_wt_new() {
            Some("untracked")
        } else if s.is_wt_modified() {
            Some("modified")
        } else if s.is_wt_deleted() {
            Some("deleted")
        } else if s.is_wt_renamed() {
            Some("renamed")
        } else if s.is_wt_typechange() {
            Some("typechange")
        } else {
            None
        };

        let old_path = entry
            .head_to_index()
            .filter(|_| s.is_index_renamed())
            .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().into_owned()));
        // For a staged rename the entry is keyed by its new path.
        let path = entry
            .head_to_index()
            .filter(|_| s.is_index_renamed())
            .and_then(|d| d.new_file().path().map(|p| p.to_string_lossy().into_owned()))
            .unwrap_or_else(|| entry.path().unwrap_or("").to_string());

        files.push(WorkingFile { path, old_path, staged, unstaged, conflicted: s.is_conflicted() });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn read_working_diff(
    path: &str,
    file: &str,
    old_path: Option<&str>,
    staged: bool,
    max_lines: Option<usize>,
) -> Result<FileDiff, git2::Error> {
    let repo = Repository::discover(path)?;
    let diff = file_diff(&repo, file, old_path, staged)?;
    match delta_index(&diff, file) {
        Some(index) => file_diff_from_patch(Patch::from_diff(&diff, index)?, max_lines),
        None => Ok(FileDiff::unchanged()),
    }
}

/// The diff of a single file: HEAD against the index when `staged`, otherwise the
/// index against the working copy (including untracked files).
fn file_diff<'r>(repo: &'r Repository, file: &str, old_path: Option<&str>, staged: bool) -> Result<Diff<'r>, git2::Error> {
    let mut opts = DiffOptions::new();
    // Match paths literally; file names can contain glob characters.
    opts.disable_pathspec_match(true).pathspec(file);
    if let Some(old) = old_path {
        opts.pathspec(old);
    }

    if staged {
        let head = head_tree(repo)?;
        let mut diff = repo.diff_tree_to_index(head.as_ref(), None, Some(&mut opts))?;
        diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;
        Ok(diff)
    } else {
        opts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))
    }
}

fn delta_index(diff: &Diff, file: &str) -> Option<usize> {
    let file = Path::new(file);
    diff.deltas()
        .position(|d| d.new_file().path() == Some(file) || d.old_file().path() == Some(file))
}

fn head_tree(repo: &Repository) -> Result<Option<Tree<'_>>, git2::Error> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_tree()?)),
        Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn stage(path: &str, files: &[String]) -> Result<(), String> {
    // -A also stages deletions of the listed paths.
    let mut args = vec!["add", "-A", "--"];
    args.extend(files.iter().map(String::as_str));
    git(path, &args, None).map(drop)
}

fn unstage(path: &str, files: &[String]) -> Result<(), String> {
    let repo = Repository::discover(path).map_err(message)?;
    // Before the first commit there's no HEAD to restore from; removing the paths from
    // the index is the equivalent.
    let mut args = if head_tree(&repo).map_err(message)?.is_some() {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "-r", "-q", "--"]
    };
    args.extend(files.iter().map(String::as_str));
    git(path, &args, None).map(drop)
}

fn apply_hunk(path: &str, file: &str, old_path: Option<&str>, staged: bool, hunk: usize) -> Result<(), String> {
    let patch = hunk_patch(path, file, old_path, staged, hunk)?;

    // Unstaging applies the staged hunk in reverse to the index.
    let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
    if staged {
        args.push("--reverse");
    }
    args.push("-");
    git(path, &args, Some(&patch)).map(drop)
}

/// A patch holding just one hunk of a file's staged or unstaged diff.
fn hunk_patch(path: &str, file: &str, old_path: Option<&str>, staged: bool, hunk: usize) -> Result<String, String> {
    let repo = Repository::discover(path).map_err(message)?;
    let diff = file_diff(&repo, file, old_path, staged).map_err(message)?;
    let index = delta_index(&diff, file).ok_or("This file no longer has those changes.")?;
    let mut patch = Patch::from_diff(&diff, index)
        .map_err(message)?
        .ok_or("Binary files can't be changed by hunk.")?;
    let text = patch.to_buf().map_err(message)?;
    single_hunk_patch(&String::from_utf8_lossy(&text), hunk).ok_or_else(|| "That hunk no longer exists.".to_string())
}

/// Keeps a patch's file header and only its `hunk`th hunk.
fn single_hunk_patch(patch: &str, hunk: usize) -> Option<String> {
    let mut header = String::new();
    let mut hunks: Vec<String> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@") {
            hunks.push(String::new());
        }
        match hunks.last_mut() {
            Some(current) => current.push_str(line),
            None => header.push_str(line),
        }
    }

    let mut result = header + hunks.get(hunk)?;
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Some(result)
}

fn commit(path: &str, message: &str, amend: bool) -> Result<(), String> {
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    git(path, &args, Some(message)).map(drop)
}

fn read_head_commit(path: &str) -> Result<Option<HeadCommit>, git2::Error> {
    let repo = Repository::discover(path)?;
    let head = match repo.head() {
        Ok(head) => head,
        Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let commit = head.peel_to_commit()?;

    let upstream = head
        .is_branch()
        .then(|| git2::Branch::wrap(head).upstream().ok().and_then(|u| u.get().target()))
        .flatten();
    let pushed = match upstream {
        Some(upstream) => upstream == commit.id() || repo.graph_descendant_of(upstream, commit.id())?,
        None => false,
    };

    Ok(Some(HeadCommit {
        message: String::from_utf8_lossy(commit.message_bytes()).trim_end().to_string(),
        pushed,
    }))
}

fn discard(path: &str, files: &[String], backup: &dyn Fn(&Path) -> Result<(), String>) -> Result<(), String> {
    let repo = Repository::discover(path).map_err(message)?;
    let workdir = repo.workdir().ok_or("This repository has no working copy.")?.to_path_buf();
    let head = head_tree(&repo).map_err(message)?;

    // Discarding a staged rename also brings back the file under its old name.
    let status = read_status(&repo).map_err(message)?;
    let mut targets: Vec<&str> = Vec::new();
    for file in files {
        targets.push(file);
        if let Some(old) = status.iter().find(|s| &s.path == file).and_then(|s| s.old_path.as_deref()) {
            targets.push(old);
        }
    }

    for target in &targets {
        let full = workdir.join(target);
        if full.symlink_metadata().is_ok() {
            backup(&full)?;
        }
    }

    // Files HEAD knows about are restored from it; anything newer is dropped from the
    // index (its working copy is already in the Trash).
    let (known, new): (Vec<&str>, Vec<&str>) = targets
        .iter()
        .partition(|t| head.as_ref().is_some_and(|tree| tree.get_path(Path::new(t)).is_ok()));

    if !new.is_empty() {
        let mut args = vec!["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"];
        args.extend(&new);
        git(path, &args, None)?;
        for file in &new {
            remove_empty_parents(&workdir, &workdir.join(file));
        }
    }
    if !known.is_empty() {
        let mut args = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
        args.extend(&known);
        git(path, &args, None)?;
    }
    Ok(())
}

fn resolve(path: &str, file: &str, side: &str) -> Result<(), String> {
    let flag = match side {
        "current" => "--ours",
        "incoming" => "--theirs",
        "resolved" => return stage(path, &[file.to_string()]),
        _ => return Err(format!("Unknown side: {side}")),
    };
    match git(path, &["checkout", flag, "--", file], None) {
        Ok(_) => stage(path, &[file.to_string()]),
        // That side deleted the file, so taking it means deleting the file.
        Err(e) if e.contains("does not have") => git(path, &["rm", "-q", "--", file], None).map(drop),
        Err(e) => Err(e),
    }
}

fn move_to_trash(file: &Path) -> Result<(), String> {
    trash::delete(file).map_err(|e| format!("Couldn't move {} to the Trash: {e}", file.display()))
}

/// Removes directories left empty by discarding new files, as git clean would.
fn remove_empty_parents(workdir: &Path, file: &Path) {
    let mut dir = file.parent();
    while let Some(d) = dir {
        if d == workdir || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

fn message(e: git2::Error) -> String {
    e.message().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    fn statuses(t: &TempRepo) -> Vec<(String, Option<&'static str>, Option<&'static str>)> {
        read_status(&t.repo).unwrap().into_iter().map(|f| (f.path, f.staged, f.unstaged)).collect()
    }

    #[test]
    fn status_separates_staged_and_unstaged_changes() {
        let t = TempRepo::new("status");
        t.commit(&[("kept.txt", Some("a\n")), ("gone.txt", Some("b\n"))], "First");
        t.write(&[("kept.txt", Some("a\nchanged\n")), ("gone.txt", None), ("new.txt", Some("c\n"))]);
        stage(t.path(), &["kept.txt".into()]).unwrap();
        t.write(&[("kept.txt", Some("a\nchanged\nagain\n"))]);

        assert_eq!(
            statuses(&t),
            [
                ("gone.txt".into(), None, Some("deleted")),
                ("kept.txt".into(), Some("modified"), Some("modified")),
                ("new.txt".into(), None, Some("untracked")),
            ]
        );
    }

    #[test]
    fn staging_and_unstaging_whole_files() {
        let t = TempRepo::new("stage");
        t.commit(&[("a.txt", Some("a\n")), ("b.txt", Some("b\n"))], "First");
        t.write(&[("a.txt", Some("A\n")), ("b.txt", None), ("c.txt", Some("c\n"))]);

        stage(t.path(), &["a.txt".into(), "b.txt".into(), "c.txt".into()]).unwrap();
        assert_eq!(
            statuses(&t),
            [
                ("a.txt".into(), Some("modified"), None),
                ("b.txt".into(), Some("deleted"), None),
                ("c.txt".into(), Some("added"), None),
            ]
        );

        unstage(t.path(), &["a.txt".into(), "b.txt".into(), "c.txt".into()]).unwrap();
        assert_eq!(
            statuses(&t),
            [
                ("a.txt".into(), None, Some("modified")),
                ("b.txt".into(), None, Some("deleted")),
                ("c.txt".into(), None, Some("untracked")),
            ]
        );
    }

    #[test]
    fn unstaging_before_the_first_commit() {
        let t = TempRepo::new("unborn");
        t.write(&[("a.txt", Some("a\n"))]);
        stage(t.path(), &["a.txt".into()]).unwrap();
        assert_eq!(statuses(&t), [("a.txt".into(), Some("added"), None)]);

        unstage(t.path(), &["a.txt".into()]).unwrap();
        assert_eq!(statuses(&t), [("a.txt".into(), None, Some("untracked"))]);
    }

    #[test]
    fn staging_and_unstaging_a_single_hunk() {
        let t = TempRepo::new("hunk");
        let original: String = (1..=20).map(|i| format!("line {i}\n")).collect();
        t.commit(&[("a.txt", Some(&original))], "First");
        // Two changes far enough apart to be separate hunks.
        let changed = original.replace("line 2\n", "line two\n").replace("line 19\n", "line nineteen\n");
        t.write(&[("a.txt", Some(&changed))]);

        let unstaged = read_working_diff(t.path(), "a.txt", None, false, None).unwrap();
        assert_eq!(unstaged.hunks.len(), 2);

        apply_hunk(t.path(), "a.txt", None, false, 1).unwrap();
        let staged = read_working_diff(t.path(), "a.txt", None, true, None).unwrap();
        let unstaged = read_working_diff(t.path(), "a.txt", None, false, None).unwrap();
        assert_eq!((staged.hunks.len(), unstaged.hunks.len()), (1, 1));
        assert!(staged.hunks[0].lines.iter().any(|l| l.text == "line nineteen"));
        assert!(unstaged.hunks[0].lines.iter().any(|l| l.text == "line two"));

        apply_hunk(t.path(), "a.txt", None, true, 0).unwrap();
        assert_eq!(statuses(&t), [("a.txt".into(), None, Some("modified"))]);
    }

    #[test]
    fn staging_the_hunk_of_an_untracked_file() {
        let t = TempRepo::new("untracked-hunk");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        t.write(&[("new.txt", Some("one\ntwo\n"))]);

        apply_hunk(t.path(), "new.txt", None, false, 0).unwrap();
        assert_eq!(statuses(&t), [("new.txt".into(), Some("added"), None)]);

        apply_hunk(t.path(), "new.txt", None, true, 0).unwrap();
        assert_eq!(statuses(&t), [("new.txt".into(), None, Some("untracked"))]);
    }

    #[test]
    fn committing_staged_changes() {
        let t = TempRepo::new("commit");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        t.write(&[("a.txt", Some("b\n")), ("other.txt", Some("x\n"))]);
        stage(t.path(), &["a.txt".into()]).unwrap();

        commit(t.path(), "Second\n\nWith a body.", false).unwrap();

        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message(), Ok("Second\n\nWith a body.\n"));
        // Only what was staged is committed.
        assert_eq!(statuses(&t), [("other.txt".into(), None, Some("untracked"))]);
    }

    /// Stands in for the Trash: moves discarded files into a backup folder.
    fn backup_into(dir: &Path) -> impl Fn(&Path) -> Result<(), String> + '_ {
        move |file: &Path| {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::rename(file, dir.join(file.file_name().unwrap())).map_err(|e| e.to_string())
        }
    }

    fn read(t: &TempRepo, file: &str) -> Option<String> {
        std::fs::read_to_string(t.dir.join(file)).ok()
    }

    #[test]
    fn discarding_returns_files_to_head_and_keeps_a_backup() {
        let t = TempRepo::new("discard");
        t.commit(&[("kept.txt", Some("original\n")), ("gone.txt", Some("still here\n"))], "First");
        std::fs::create_dir_all(t.dir.join("new-dir")).unwrap();
        t.write(&[
            ("kept.txt", Some("staged edit\n")),
            ("gone.txt", None),
            ("new-dir/untracked.txt", Some("scratch\n")),
            ("added.txt", Some("added\n")),
        ]);
        stage(t.path(), &["kept.txt".into(), "added.txt".into()]).unwrap();
        t.write(&[("kept.txt", Some("unstaged edit on top\n"))]);

        let backup = t.dir.with_extension("backup");
        let files = ["kept.txt", "gone.txt", "new-dir/untracked.txt", "added.txt"].map(String::from);
        discard(t.path(), &files, &backup_into(&backup)).unwrap();

        assert_eq!(statuses(&t), []);
        assert_eq!(read(&t, "kept.txt").as_deref(), Some("original\n"));
        assert_eq!(read(&t, "gone.txt").as_deref(), Some("still here\n"));
        assert!(!t.dir.join("new-dir").exists(), "the emptied directory is removed");
        assert!(!t.dir.join("added.txt").exists());
        // Everything that existed in the working copy was backed up first.
        let saved = |f: &str| std::fs::read_to_string(backup.join(f)).ok();
        assert_eq!(saved("kept.txt").as_deref(), Some("unstaged edit on top\n"));
        assert_eq!(saved("untracked.txt").as_deref(), Some("scratch\n"));
        assert_eq!(saved("added.txt").as_deref(), Some("added\n"));
        let _ = std::fs::remove_dir_all(&backup);
    }

    #[test]
    fn discarding_a_staged_rename_brings_back_the_old_name() {
        let t = TempRepo::new("discard-rename");
        t.commit(&[("old.txt", Some("content\n"))], "First");
        git(t.path(), &["mv", "old.txt", "new.txt"], None).unwrap();
        assert_eq!(statuses(&t), [("new.txt".into(), Some("renamed"), None)]);

        let backup = t.dir.with_extension("backup");
        discard(t.path(), &["new.txt".into()], &backup_into(&backup)).unwrap();

        assert_eq!(statuses(&t), []);
        assert_eq!(read(&t, "old.txt").as_deref(), Some("content\n"));
        assert!(!t.dir.join("new.txt").exists());
        let _ = std::fs::remove_dir_all(&backup);
    }

    #[test]
    fn discarding_before_the_first_commit_drops_the_file() {
        let t = TempRepo::new("discard-unborn");
        t.write(&[("a.txt", Some("a\n"))]);
        stage(t.path(), &["a.txt".into()]).unwrap();

        let backup = t.dir.with_extension("backup");
        discard(t.path(), &["a.txt".into()], &backup_into(&backup)).unwrap();

        assert_eq!(statuses(&t), []);
        let _ = std::fs::remove_dir_all(&backup);
    }

    #[test]
    fn discarding_a_single_hunk_keeps_the_rest() {
        let t = TempRepo::new("discard-hunk");
        let original: String = (1..=20).map(|i| format!("line {i}\n")).collect();
        t.commit(&[("a.txt", Some(&original))], "First");
        let changed = original.replace("line 2\n", "line two\n").replace("line 19\n", "line nineteen\n");
        t.write(&[("a.txt", Some(&changed))]);

        let patch = hunk_patch(t.path(), "a.txt", None, false, 0).unwrap();
        git(t.path(), &["apply", "--reverse", "--whitespace=nowarn", "-"], Some(&patch)).unwrap();

        let now = read(&t, "a.txt").unwrap();
        assert!(now.contains("line 2\n") && now.contains("line nineteen\n"), "{now}");
    }

    #[test]
    fn amending_replaces_the_last_commit() {
        let t = TempRepo::new("amend");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let original = t.commit(&[("b.txt", Some("b\n"))], "Secnod");
        assert_eq!(read_head_commit(t.path()).unwrap().unwrap().message, "Secnod");

        t.write(&[("c.txt", Some("forgotten\n"))]);
        stage(t.path(), &["c.txt".into()]).unwrap();
        commit(t.path(), "Second", true).unwrap();

        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_ne!(head.id(), original);
        assert_eq!(head.message(), Ok("Second\n"));
        assert_eq!(head.parent(0).unwrap().message(), Ok("First"));
        assert!(head.tree().unwrap().get_path(Path::new("c.txt")).is_ok());
    }

    #[test]
    fn a_pushed_head_commit_is_flagged_before_amending() {
        let server = TempRepo::bare("amend-pushed-server");
        let t = TempRepo::new("amend-pushed");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        assert!(!read_head_commit(t.path()).unwrap().unwrap().pushed);

        t.repo.remote("origin", server.path()).unwrap();
        git(t.path(), &["push", "-u", "origin", "HEAD"], None).unwrap();
        assert!(read_head_commit(t.path()).unwrap().unwrap().pushed);

        t.commit(&[("b.txt", Some("b\n"))], "Second");
        assert!(!read_head_commit(t.path()).unwrap().unwrap().pushed);
    }

    /// Both branches changed a.txt; merging leaves it conflicted.
    fn merge_conflict(name: &str) -> TempRepo {
        let t = TempRepo::new(name);
        t.commit(&[("a.txt", Some("base\n")), ("gone.txt", Some("x\n"))], "Base");
        let main = t.branch();
        git(t.path(), &["switch", "-c", "theirs"], None).unwrap();
        t.commit(&[("a.txt", Some("theirs\n")), ("gone.txt", None)], "Theirs");
        git(t.path(), &["switch", &main], None).unwrap();
        t.commit(&[("a.txt", Some("ours\n")), ("gone.txt", Some("edited\n"))], "Ours");
        assert!(git(t.path(), &["merge", "theirs"], None).is_err());
        t
    }

    #[test]
    fn conflicts_are_listed_and_shown_with_markers() {
        let t = merge_conflict("conflict-show");
        let conflicted: Vec<_> = read_status(&t.repo).unwrap().into_iter().filter(|f| f.conflicted).map(|f| f.path).collect();
        assert_eq!(conflicted, ["a.txt", "gone.txt"]);

        let text = tauri::async_runtime::block_on(conflict_file(t.path().into(), "a.txt".into())).unwrap();
        assert!(text.contains("<<<<<<<") && text.contains("ours") && text.contains("theirs"), "{text}");
    }

    #[test]
    fn resolving_by_taking_a_side() {
        let t = merge_conflict("conflict-resolve");
        resolve(t.path(), "a.txt", "incoming").unwrap();
        assert_eq!(read(&t, "a.txt").as_deref(), Some("theirs\n"));
        // Their side deleted gone.txt, so taking it deletes the file.
        resolve(t.path(), "gone.txt", "incoming").unwrap();
        assert!(!t.dir.join("gone.txt").exists());
        assert!(read_status(&t.repo).unwrap().iter().all(|f| !f.conflicted));
    }

    #[test]
    fn resolving_by_editing_and_marking_resolved() {
        let t = merge_conflict("conflict-mark");
        t.write(&[("a.txt", Some("both\n"))]);
        resolve(t.path(), "a.txt", "resolved").unwrap();
        resolve(t.path(), "gone.txt", "current").unwrap();
        assert_eq!(read(&t, "gone.txt").as_deref(), Some("edited\n"));
        assert!(read_status(&t.repo).unwrap().iter().all(|f| !f.conflicted));
    }

    #[test]
    fn commit_errors_carry_gits_explanation() {
        let t = TempRepo::new("empty-commit");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let error = commit(t.path(), "Nothing staged", false).unwrap_err();
        assert!(error.contains("nothing to commit"), "{error}");
    }
}
