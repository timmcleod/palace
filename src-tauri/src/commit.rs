use git2::{Commit, Delta, Diff, DiffFindOptions, Oid, Patch, Repository, Signature};
use serde::Serialize;

#[derive(Serialize)]
pub struct CommitDetails {
    id: String,
    author: Person,
    committer: Person,
    message: String,
    parents: Vec<String>,
    tree_id: String,
    files: Vec<ChangedFile>,
    additions: usize,
    deletions: usize,
}

#[derive(Serialize)]
pub struct Person {
    name: String,
    email: String,
    time: i64,
}

#[derive(Serialize)]
pub struct ChangedFile {
    path: String,
    /// The previous path, for renames and copies.
    old_path: Option<String>,
    /// "added", "deleted", "modified", "renamed", "copied" or "typechange".
    status: &'static str,
    additions: usize,
    deletions: usize,
    binary: bool,
}

#[derive(Serialize)]
pub struct FileDiff {
    binary: bool,
    /// Lines across all hunks, so the UI can say how big a diff it held back is.
    total_lines: usize,
    /// True when the diff was longer than `max_lines` and its hunks were left out.
    truncated: bool,
    hunks: Vec<Hunk>,
}

#[derive(Serialize)]
pub struct Hunk {
    header: String,
    lines: Vec<Line>,
}

#[derive(Serialize)]
pub struct Line {
    /// '+', '-', ' ', or '\\' for git's "No newline at end of file" marker.
    kind: char,
    old: Option<u32>,
    new: Option<u32>,
    text: String,
}

#[tauri::command]
pub async fn commit_details(path: String, id: String) -> Result<CommitDetails, String> {
    read_details(&path, &id).map_err(|e| e.message().to_string())
}

/// The diff of one file in a commit. `index` is the file's position in the
/// `files` list returned by `commit_details`.
#[tauri::command]
pub async fn file_diff(
    path: String,
    id: String,
    index: usize,
    max_lines: Option<usize>,
) -> Result<FileDiff, String> {
    read_file_diff(&path, &id, index, max_lines).map_err(|e| e.message().to_string())
}

fn read_details(path: &str, id: &str) -> Result<CommitDetails, git2::Error> {
    let repo = Repository::discover(path)?;
    let commit = repo.find_commit(Oid::from_str(id)?)?;
    let diff = commit_diff(&repo, &commit)?;

    let mut files = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        let (mut additions, mut deletions, mut binary) = (0, 0, delta.flags().is_binary());
        if let Some(patch) = Patch::from_diff(&diff, index)? {
            (_, additions, deletions) = patch.line_stats()?;
            // Binary detection needs the file contents, which loading the patch reads.
            binary |= patch.delta().flags().is_binary();
        }

        let new_path = path_string(delta.new_file().path());
        let old_path = path_string(delta.old_file().path());
        let status = match delta.status() {
            Delta::Added => "added",
            Delta::Deleted => "deleted",
            Delta::Renamed => "renamed",
            Delta::Copied => "copied",
            Delta::Typechange => "typechange",
            _ => "modified",
        };

        files.push(ChangedFile {
            path: if delta.status() == Delta::Deleted { old_path.clone() } else { new_path.clone() },
            old_path: (old_path != new_path).then_some(old_path),
            status,
            additions,
            deletions,
            binary,
        });
    }

    Ok(CommitDetails {
        id: commit.id().to_string(),
        author: person(&commit.author()),
        committer: person(&commit.committer()),
        message: String::from_utf8_lossy(commit.message_bytes()).trim_end().to_string(),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        tree_id: commit.tree_id().to_string(),
        additions: files.iter().map(|f| f.additions).sum(),
        deletions: files.iter().map(|f| f.deletions).sum(),
        files,
    })
}

fn read_file_diff(path: &str, id: &str, index: usize, max_lines: Option<usize>) -> Result<FileDiff, git2::Error> {
    let repo = Repository::discover(path)?;
    let commit = repo.find_commit(Oid::from_str(id)?)?;
    let diff = commit_diff(&repo, &commit)?;

    let Some(patch) = Patch::from_diff(&diff, index)? else {
        return Ok(FileDiff { binary: true, total_lines: 0, truncated: false, hunks: Vec::new() });
    };
    if patch.delta().flags().is_binary() {
        return Ok(FileDiff { binary: true, total_lines: 0, truncated: false, hunks: Vec::new() });
    }

    let mut total_lines = 0;
    for h in 0..patch.num_hunks() {
        total_lines += patch.num_lines_in_hunk(h)?;
    }
    if max_lines.is_some_and(|max| total_lines > max) {
        return Ok(FileDiff { binary: false, total_lines, truncated: true, hunks: Vec::new() });
    }

    let mut hunks = Vec::new();
    for h in 0..patch.num_hunks() {
        let (hunk, line_count) = patch.hunk(h)?;
        let mut lines = Vec::with_capacity(line_count);
        for l in 0..line_count {
            let line = patch.line_in_hunk(h, l)?;
            lines.push(match line.origin() {
                // Markers for a missing newline at the end of the old or new file. They
                // aren't lines of the file, so they get no line numbers.
                '=' | '>' | '<' => Line {
                    kind: '\\',
                    old: None,
                    new: None,
                    text: "No newline at end of file".to_string(),
                },
                origin => Line {
                    kind: origin,
                    old: line.old_lineno(),
                    new: line.new_lineno(),
                    text: String::from_utf8_lossy(line.content()).trim_end_matches(['\n', '\r']).to_string(),
                },
            });
        }
        hunks.push(Hunk {
            header: String::from_utf8_lossy(hunk.header()).trim_end().to_string(),
            lines,
        });
    }

    Ok(FileDiff { binary: false, total_lines, truncated: false, hunks })
}

/// The changes a commit introduced: against its first parent, or against an empty
/// tree for a root commit. Merges are shown against their first parent, as `git show
/// --first-parent` would.
fn commit_diff<'r>(repo: &'r Repository, commit: &Commit) -> Result<Diff<'r>, git2::Error> {
    let parent_tree = match commit.parent_count() {
        0 => None,
        _ => Some(commit.parent(0)?.tree()?),
    };
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree()?), None)?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;
    Ok(diff)
}

fn person(signature: &Signature) -> Person {
    Person {
        name: signature.name().unwrap_or("").to_string(),
        email: signature.email().unwrap_or("").to_string(),
        time: signature.when().seconds(),
    }
}

fn path_string(path: Option<&std::path::Path>) -> String {
    path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    struct TempRepo {
        dir: PathBuf,
        repo: Repository,
    }

    impl TempRepo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("palace-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            let repo = Repository::init(&dir).unwrap();
            TempRepo { dir, repo }
        }

        fn commit(&self, files: &[(&str, Option<&str>)], message: &str) -> Oid {
            let mut index = self.repo.index().unwrap();
            for (path, content) in files {
                match content {
                    Some(content) => {
                        fs::write(self.dir.join(path), content).unwrap();
                        index.add_path(Path::new(path)).unwrap();
                    }
                    None => {
                        fs::remove_file(self.dir.join(path)).unwrap();
                        index.remove_path(Path::new(path)).unwrap();
                    }
                }
            }
            index.write().unwrap();
            let tree = self.repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = Signature::now("Ada Lovelace", "ada@example.com").unwrap();
            let parent = self.repo.head().ok().map(|h| h.peel_to_commit().unwrap());
            let parents: Vec<&Commit> = parent.iter().collect();
            self.repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap()
        }

        fn path(&self) -> &str {
            self.dir.to_str().unwrap()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn root_commit_shows_every_file_as_added() {
        let t = TempRepo::new("root");
        let id = t.commit(&[("a.txt", Some("one\ntwo\n"))], "First\n\nBody text.");
        let details = read_details(t.path(), &id.to_string()).unwrap();

        assert_eq!(details.message, "First\n\nBody text.");
        assert!(details.parents.is_empty());
        assert_eq!(details.files.len(), 1);
        assert_eq!((details.files[0].status, details.files[0].additions), ("added", 2));
    }

    #[test]
    fn modified_file_diff_has_numbered_lines() {
        let t = TempRepo::new("modify");
        t.commit(&[("a.txt", Some("one\ntwo\nthree\n")), ("gone.txt", Some("x\n"))], "First");
        let id = t.commit(&[("a.txt", Some("one\nTWO\nthree")), ("gone.txt", None)], "Second");

        let details = read_details(t.path(), &id.to_string()).unwrap();
        let statuses: Vec<_> = details.files.iter().map(|f| (f.path.as_str(), f.status)).collect();
        assert_eq!(statuses, [("a.txt", "modified"), ("gone.txt", "deleted")]);
        assert_eq!((details.additions, details.deletions), (2, 3));

        let diff = read_file_diff(t.path(), &id.to_string(), 0, None).unwrap();
        let lines: Vec<_> = diff.hunks[0].lines.iter().map(|l| (l.kind, l.old, l.new, l.text.as_str())).collect();
        assert_eq!(
            lines,
            [
                (' ', Some(1), Some(1), "one"),
                ('-', Some(2), None, "two"),
                ('-', Some(3), None, "three"),
                ('+', None, Some(2), "TWO"),
                ('+', None, Some(3), "three"),
                ('\\', None, None, "No newline at end of file"),
            ]
        );
    }

    #[test]
    fn large_diffs_are_held_back_when_asked() {
        let t = TempRepo::new("large");
        let big: String = (0..50).map(|i| format!("line {i}\n")).collect();
        let id = t.commit(&[("big.txt", Some(&big))], "Big");

        let diff = read_file_diff(t.path(), &id.to_string(), 0, Some(10)).unwrap();
        assert!(diff.truncated && diff.hunks.is_empty());
        assert_eq!(diff.total_lines, 50);
    }
}
