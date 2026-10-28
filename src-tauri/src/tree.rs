//! Browsing files: the repository's tracked files for file search, and any commit's
//! folders and file contents for the Tree view.

use crate::cli;
use git2::{ObjectType, Oid, Repository};
use serde::Serialize;
use std::collections::HashMap;

/// Files larger than this aren't shown in the Tree view.
const MAX_SHOWN: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct TreeEntry {
    name: String,
    path: String,
    /// "dir", "file", "link" or "submodule".
    kind: &'static str,
}

#[derive(Serialize)]
pub struct FileContents {
    size: usize,
    binary: bool,
    /// True when the file is too big to show.
    too_large: bool,
    text: Option<String>,
}

/// Every file git tracks in the working copy, for file search.
#[tauri::command]
pub async fn tracked_files(path: String) -> Result<Vec<String>, String> {
    let repo = Repository::discover(&path).map_err(message)?;
    let index = repo.index().map_err(message)?;
    Ok(index.iter().map(|entry| String::from_utf8_lossy(&entry.path).into_owned()).collect())
}

/// The folders and files directly inside `dir` ("" for the top) at commit `id`,
/// folders first.
#[tauri::command]
pub async fn tree_entries(path: String, id: String, dir: String) -> Result<Vec<TreeEntry>, String> {
    read_entries(&path, &id, &dir).map_err(message)
}

/// A file's contents at commit `id`.
#[tauri::command]
pub async fn file_contents(path: String, id: String, file: String) -> Result<FileContents, String> {
    let repo = Repository::discover(&path).map_err(message)?;
    let tree = repo.find_commit(Oid::from_str(&id).map_err(message)?).and_then(|c| c.tree()).map_err(message)?;
    let entry = tree.get_path(std::path::Path::new(&file)).map_err(message)?;
    let blob = entry.to_object(&repo).and_then(|o| o.peel_to_blob()).map_err(message)?;

    let size = blob.size();
    let binary = blob.is_binary();
    let too_large = !binary && size > MAX_SHOWN;
    let text = (!binary && !too_large).then(|| String::from_utf8_lossy(blob.content()).into_owned());
    Ok(FileContents { size, binary, too_large, text })
}

/// A run of lines last changed by the same commit.
#[derive(Serialize, Debug, PartialEq)]
pub struct BlameHunk {
    /// The first line (1-based) and how many lines the run covers.
    start: usize,
    lines: usize,
    id: String,
    short_id: String,
    author: String,
    email: String,
    time: i64,
    summary: String,
    /// The file's path in that commit, which differs if it has since been renamed.
    file: String,
}

/// Who last changed each line of `file` as of commit `id`.
#[tauri::command]
pub async fn blame_file(path: String, id: String, file: String) -> Result<Vec<BlameHunk>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = cli::git(&path, &["blame", "--porcelain", &id, "--", &file], None)?;
        Ok(parse_blame(&output))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads `git blame --porcelain`: each group starts "<commit> <old line> <line>
/// <count>", the first group for a commit is followed by its details ("author …",
/// "summary …"), and every line of the file follows as a tab-indented line.
fn parse_blame(output: &str) -> Vec<BlameHunk> {
    #[derive(Default, Clone)]
    struct Details {
        author: String,
        email: String,
        time: i64,
        summary: String,
        filename: String,
    }
    let mut details: HashMap<String, Details> = HashMap::new();
    // (commit, first line, line count, the file's path in that commit)
    let mut groups: Vec<(String, usize, usize, String)> = Vec::new();
    let mut current: Option<String> = None;

    for line in output.lines() {
        if line.starts_with('\t') {
            continue;
        }
        let mut words = line.split(' ');
        let first = words.next().unwrap_or("");
        if first.len() == 40 && first.chars().all(|c| c.is_ascii_hexdigit()) {
            let numbers: Vec<usize> = words.filter_map(|w| w.parse().ok()).collect();
            if let [_, start, count] = numbers[..] {
                groups.push((first.to_string(), start, count, String::new()));
            }
            current = Some(first.to_string());
            continue;
        }
        let Some(id) = &current else { continue };
        let entry = details.entry(id.clone()).or_default();
        let rest = line.split_once(' ').map(|(_, r)| r).unwrap_or("");
        match first {
            "author" => entry.author = rest.to_string(),
            "author-mail" => entry.email = rest.trim_matches(['<', '>']).to_string(),
            "author-time" => entry.time = rest.parse().unwrap_or(0),
            "summary" => entry.summary = rest.to_string(),
            // Given for a commit's first group, and for later ones when the file had
            // another name there.
            "filename" => {
                entry.filename = rest.to_string();
                if let Some(group) = groups.last_mut() {
                    group.3 = rest.to_string();
                }
            }
            _ => {}
        }
    }

    // Groups arrive in file order; neighbouring groups from the same commit join up.
    let mut hunks: Vec<BlameHunk> = Vec::new();
    for (id, start, count, file) in groups {
        let file = if file.is_empty() { details.get(&id).map(|d| d.filename.clone()).unwrap_or_default() } else { file };
        if let Some(last) = hunks.last_mut() {
            if last.id == id && last.start + last.lines == start && last.file == file {
                last.lines += count;
                continue;
            }
        }
        let d = details.get(&id).cloned().unwrap_or_default();
        hunks.push(BlameHunk {
            start,
            lines: count,
            short_id: id[..7].to_string(),
            id,
            author: d.author,
            email: d.email,
            time: d.time,
            summary: d.summary,
            file,
        });
    }
    hunks.sort_by_key(|h| h.start);
    hunks
}

fn read_entries(path: &str, id: &str, dir: &str) -> Result<Vec<TreeEntry>, git2::Error> {
    let repo = Repository::discover(path)?;
    let root = repo.find_commit(Oid::from_str(id)?)?.tree()?;
    let tree = if dir.is_empty() {
        root
    } else {
        root.get_path(std::path::Path::new(dir))?.to_object(&repo)?.peel_to_tree()?
    };

    let mut entries: Vec<TreeEntry> = tree
        .iter()
        .map(|entry| {
            let name = entry.name().unwrap_or("").to_string();
            let kind = match (entry.kind(), entry.filemode()) {
                (Some(ObjectType::Tree), _) => "dir",
                (Some(ObjectType::Commit), _) => "submodule",
                (_, 0o120000) => "link",
                _ => "file",
            };
            let path = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
            TreeEntry { name, path, kind }
        })
        .collect();
    // Folders first, then case-insensitively by name, like a file manager.
    entries.sort_by_key(|e| (e.kind != "dir", e.name.to_lowercase()));
    Ok(entries)
}

fn message(e: git2::Error) -> String {
    e.message().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    #[test]
    fn browsing_a_commit() {
        let t = TempRepo::new("tree");
        let id = t.commit(
            &[("b.txt", Some("bee\n")), ("A.txt", Some("ay\n")), ("src/main.rs", Some("fn main() {}\n")), ("logo.bin", Some("\0\x01\x02"))],
            "First",
        );
        let id = id.to_string();

        let top = read_entries(t.path(), &id, "").unwrap();
        let names: Vec<_> = top.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(names, [("src", "dir"), ("A.txt", "file"), ("b.txt", "file"), ("logo.bin", "file")]);

        let src = read_entries(t.path(), &id, "src").unwrap();
        assert_eq!(src[0].path, "src/main.rs");

        let source = run(file_contents(t.path().into(), id.clone(), "src/main.rs".into()));
        assert_eq!(source.text.as_deref(), Some("fn main() {}\n"));
        let bin = run(file_contents(t.path().into(), id, "logo.bin".into()));
        assert!(bin.binary && bin.text.is_none());
    }

    #[test]
    fn listing_tracked_files() {
        let t = TempRepo::new("tracked");
        t.commit(&[("a.txt", Some("a")), ("dir/b.txt", Some("b"))], "First");
        let mut files = run(tracked_files(t.path().into()));
        files.sort();
        assert_eq!(files, ["a.txt", "dir/b.txt"]);
    }

    /// Runs one of the async commands to completion; they never actually wait.
    fn run<T>(future: impl std::future::Future<Output = Result<T, String>>) -> T {
        tauri::async_runtime::block_on(future).unwrap()
    }

    #[test]
    fn blaming_lines_to_the_commits_that_last_changed_them() {
        let t = TempRepo::new("blame");
        let first = t.commit(&[("a.txt", Some("one\ntwo\nthree\nfour\n"))], "First");
        let second = t.commit(&[("a.txt", Some("one\nTWO\nTHREE\nfour\nfive\n"))], "Second");

        let hunks = run(blame_file(t.path().into(), second.to_string(), "a.txt".into()));
        let shape: Vec<_> = hunks.iter().map(|h| (h.start, h.lines, h.summary.as_str())).collect();
        assert_eq!(shape, [(1, 1, "First"), (2, 2, "Second"), (4, 1, "First"), (5, 1, "Second")]);
        assert_eq!(hunks[0].id, first.to_string());
        assert_eq!((hunks[0].author.as_str(), hunks[0].email.as_str()), ("Ada Lovelace", "ada@example.com"));
        assert!(hunks[0].time > 0);

        assert!(hunks.iter().all(|h| h.file == "a.txt"));

        // After a rename, lines still belong to the commits that wrote them, under
        // the name the file had then.
        let renamed = t.commit(&[("a.txt", None), ("b.txt", Some("one\nTWO\nTHREE\nfour\nfive\n"))], "Rename");
        let moved = run(blame_file(t.path().into(), renamed.to_string(), "b.txt".into()));
        assert_eq!(moved[0].file, "a.txt");
        assert_eq!(moved[0].id, first.to_string());

        // As of the first commit, every line is the first commit's.
        let earlier = run(blame_file(t.path().into(), first.to_string(), "a.txt".into()));
        assert_eq!(earlier.len(), 1);
        assert_eq!((earlier[0].start, earlier[0].lines), (1, 4));
    }
}
