//! The working copy: what has changed since HEAD, staging those changes, and
//! committing them.
//!
//! Reading uses git2. Anything that changes the repository runs the git CLI instead,
//! so hooks, signing and the user's git config apply exactly as they do in a terminal.

use crate::commit::{FileDiff, file_diff_from_patch};
use git2::{Diff, DiffFindOptions, DiffOptions, ErrorCode, Patch, Repository, StatusOptions, Tree};
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

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

#[tauri::command]
pub async fn commit_changes(path: String, message: String) -> Result<(), String> {
    commit(&path, &message)
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
    let patch = {
        let repo = Repository::discover(path).map_err(message)?;
        let diff = file_diff(&repo, file, old_path, staged).map_err(message)?;
        let index = delta_index(&diff, file).ok_or("This file no longer has those changes.")?;
        let mut patch = Patch::from_diff(&diff, index)
            .map_err(message)?
            .ok_or("Binary files can't be staged by hunk.")?;
        let text = patch.to_buf().map_err(message)?;
        single_hunk_patch(&String::from_utf8_lossy(&text), hunk).ok_or("That hunk no longer exists.")?
    };

    // Unstaging applies the staged hunk in reverse to the index.
    let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
    if staged {
        args.push("--reverse");
    }
    args.push("-");
    git(path, &args, Some(&patch)).map(drop)
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

fn commit(path: &str, message: &str) -> Result<(), String> {
    git(path, &["commit", "-F", "-"], Some(message)).map(drop)
}

/// Runs git in the repository's working directory. On failure, returns what git
/// printed so the user can see why (a failing hook, a missing identity, …).
fn git(path: &str, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let repo = Repository::discover(path).map_err(message)?;
    let workdir = repo.workdir().ok_or("This repository has no working copy.")?;

    let mut child = Command::new("git")
        .args(args)
        .current_dir(workdir)
        // Never block on a credentials prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run git: {e}"))?;

    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .expect("stdin is piped")
            .write_all(input.as_bytes())
            .map_err(|e| format!("Couldn't send input to git: {e}"))?;
    }

    let output = child.wait_with_output().map_err(|e| format!("git failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    // Hooks often report problems on stdout, so include both.
    Err([stderr, stdout].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"))
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

        commit(t.path(), "Second\n\nWith a body.").unwrap();

        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message(), Ok("Second\n\nWith a body.\n"));
        // Only what was staged is committed.
        assert_eq!(statuses(&t), [("other.txt".into(), None, Some("untracked"))]);
    }

    #[test]
    fn commit_errors_carry_gits_explanation() {
        let t = TempRepo::new("empty-commit");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let error = commit(t.path(), "Nothing staged").unwrap_err();
        assert!(error.contains("nothing to commit"), "{error}");
    }
}
