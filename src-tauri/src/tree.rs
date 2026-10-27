//! Browsing files: the repository's tracked files for file search, and any commit's
//! folders and file contents for the Tree view.

use git2::{ObjectType, Oid, Repository};
use serde::Serialize;

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
}
