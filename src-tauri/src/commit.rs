use base64::Engine;
use git2::{Commit, Delta, Diff, DiffFile, DiffFindOptions, Oid, Patch, Repository, Signature, Tree};
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
    pub(crate) path: String,
    /// The previous path, for renames and copies.
    old_path: Option<String>,
    /// "added", "deleted", "modified", "renamed", "copied" or "typechange".
    status: &'static str,
    pub(crate) additions: usize,
    pub(crate) deletions: usize,
    binary: bool,
}

#[derive(Serialize)]
pub struct FileDiff {
    binary: bool,
    /// Lines across all hunks, so the UI can say how big a diff it held back is.
    total_lines: usize,
    /// True when the diff was longer than `max_lines` and its hunks were left out.
    truncated: bool,
    pub(crate) hunks: Vec<Hunk>,
    /// Both versions of an image, to show next to each other. None for other files.
    pub(crate) images: Option<Images>,
}

impl FileDiff {
    /// A diff for a file with no changes on the side asked about.
    pub(crate) fn unchanged() -> Self {
        FileDiff { binary: false, total_lines: 0, truncated: false, hunks: Vec::new(), images: None }
    }
}

#[derive(Serialize)]
pub struct Images {
    /// None when the image was added.
    pub(crate) old: Option<Image>,
    /// None when the image was deleted.
    pub(crate) new: Option<Image>,
}

#[derive(Serialize)]
pub struct Image {
    size: usize,
    /// The image as a data: URL, or None when it's too large to show.
    pub(crate) url: Option<String>,
}

#[derive(Serialize)]
pub struct Hunk {
    header: String,
    pub(crate) lines: Vec<Line>,
}

#[derive(Serialize)]
pub struct Line {
    /// '+', '-', ' ', or '\\' for git's "No newline at end of file" marker.
    pub(crate) kind: char,
    old: Option<u32>,
    new: Option<u32>,
    pub(crate) text: String,
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
    let files = changed_files(&diff)?;

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

/// Each file a diff changes, with its line counts.
pub(crate) fn changed_files(diff: &Diff) -> Result<Vec<ChangedFile>, git2::Error> {
    let mut files = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        let (mut additions, mut deletions, mut binary) = (0, 0, delta.flags().is_binary());
        if let Some(patch) = Patch::from_diff(diff, index)? {
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
    Ok(files)
}

fn read_file_diff(path: &str, id: &str, index: usize, max_lines: Option<usize>) -> Result<FileDiff, git2::Error> {
    let repo = Repository::discover(path)?;
    let commit = repo.find_commit(Oid::from_str(id)?)?;
    let diff = commit_diff(&repo, &commit)?;
    file_diff_at(&repo, &diff, index, max_lines)
}

/// The diff of the `index`th file in `diff`, with both versions of it if it's an image.
pub(crate) fn file_diff_at(repo: &Repository, diff: &Diff, index: usize, max_lines: Option<usize>) -> Result<FileDiff, git2::Error> {
    let mut file_diff = file_diff_from_patch(Patch::from_diff(diff, index)?, max_lines)?;
    if let Some(delta) = diff.get_delta(index) {
        let (old, new) = (image(repo, &delta.old_file()), image(repo, &delta.new_file()));
        if old.is_some() || new.is_some() {
            file_diff.images = Some(Images { old, new });
        }
    }
    Ok(file_diff)
}

const IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("svg", "image/svg+xml"),
];

/// Larger images are described but not shown.
const MAX_IMAGE: usize = 10 * 1024 * 1024;

/// One side of a diff as an image, if it's a file with an image's extension.
fn image(repo: &Repository, file: &DiffFile) -> Option<Image> {
    if !file.exists() {
        return None;
    }
    let path = file.path()?;
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let (_, mime) = IMAGE_TYPES.iter().find(|(ext, _)| *ext == extension)?;
    // The working copy's side of a diff isn't in the object database.
    let bytes = match repo.find_blob(file.id()) {
        Ok(blob) => blob.content().to_vec(),
        Err(_) => std::fs::read(repo.workdir()?.join(path)).ok()?,
    };
    let url = (bytes.len() <= MAX_IMAGE)
        .then(|| format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
    Some(Image { size: bytes.len(), url })
}

/// Converts one file's patch into lines the UI can render. `None` is what git2 returns
/// for a binary file.
pub(crate) fn file_diff_from_patch(patch: Option<Patch>, max_lines: Option<usize>) -> Result<FileDiff, git2::Error> {
    let binary = FileDiff { binary: true, ..FileDiff::unchanged() };
    let Some(patch) = patch else { return Ok(binary) };
    if patch.delta().flags().is_binary() {
        return Ok(binary);
    }

    let mut total_lines = 0;
    for h in 0..patch.num_hunks() {
        total_lines += patch.num_lines_in_hunk(h)?;
    }
    if max_lines.is_some_and(|max| total_lines > max) {
        return Ok(FileDiff { total_lines, truncated: true, ..FileDiff::unchanged() });
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

    Ok(FileDiff { total_lines, hunks, ..FileDiff::unchanged() })
}

/// The changes a commit introduced: against its first parent, or against an empty
/// tree for a root commit. Merges are shown against their first parent, as `git show
/// --first-parent` would.
fn commit_diff<'r>(repo: &'r Repository, commit: &Commit) -> Result<Diff<'r>, git2::Error> {
    let parent_tree = match commit.parent_count() {
        0 => None,
        _ => Some(commit.parent(0)?.tree()?),
    };
    tree_diff(repo, parent_tree.as_ref(), &commit.tree()?)
}

/// The changes from one tree to another, with renames found.
pub(crate) fn tree_diff<'r>(repo: &'r Repository, old: Option<&Tree>, new: &Tree) -> Result<Diff<'r>, git2::Error> {
    let mut diff = repo.diff_tree_to_tree(old, Some(new), None)?;
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
    use crate::test_support::TempRepo;

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
