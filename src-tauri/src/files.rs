//! The working copy's files as they are on disk, for the Files view: its folders, a
//! file's contents, and saving edits to it. Saving only ever writes inside the working
//! copy, never into .git, and never over changes made since the file was read.

use crate::image::{data_url, image_type, MAX_IMAGE};
use crate::errors::CHANGED_ON_DISK;
use git2::Repository;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Larger files are shown read-only, up to MAX_SHOWN, and beyond that not at all: an
/// editor over megabytes of text is slow, and such files are rarely edited by hand.
const MAX_EDITABLE: u64 = 2 * 1024 * 1024;
const MAX_SHOWN: u64 = 10 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct FileEntry {
    name: String,
    path: String,
    /// "dir", "file", "link" or "submodule".
    kind: &'static str,
    /// Whether git ignores it, as it does build output and dependencies.
    ignored: bool,
}

#[derive(Serialize, Debug)]
pub struct WorkingFileContents {
    size: u64,
    /// "text", "read_only" (text too large to edit), "image", "binary" (not text, or
    /// not UTF-8) or "too_large".
    kind: &'static str,
    /// The text, with "\n" for line endings whatever the file uses, and without a
    /// byte order mark. Saving puts them back.
    text: Option<String>,
    crlf: bool,
    bom: bool,
    /// The image as a data: URL.
    image: Option<String>,
    /// Identifies this version of the file, to tell when it changes on disk.
    version: String,
}

/// The folders and files directly inside `dir` of the working copy ("" for the top),
/// folders first, never .git. Ignored ones are there too, marked, as they're often what's
/// opened to change by hand, such as .env, and the page shows them muted.
#[tauri::command]
pub async fn working_entries(path: String, dir: String) -> Result<Vec<FileEntry>, String> {
    let (repo, workdir) = open(&path)?;
    let folder = inside(&workdir, &dir)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&folder).map_err(|e| format!("Couldn't read {}: {e}", shown(&dir)))? {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        if dir.is_empty() && is_git_dir(&name) {
            continue;
        }
        let Ok(kind) = item.file_type() else { continue };
        let full = item.path();
        let kind = if kind.is_symlink() {
            "link"
        } else if kind.is_dir() {
            // A repository of its own, such as a submodule.
            if full.join(".git").exists() { "submodule" } else { "dir" }
        } else {
            "file"
        };
        let relative = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
        let ignored = ignored(&repo, Path::new(&relative), kind == "dir");
        entries.push(FileEntry { name, path: relative, kind, ignored });
    }
    entries.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// A file in the working copy as it is on disk. An image comes as one, unless `as_text`,
/// as for editing an SVG.
#[tauri::command]
pub async fn read_working_file(path: String, file: String, as_text: Option<bool>) -> Result<WorkingFileContents, String> {
    let (_, workdir) = open(&path)?;
    let full = inside(&workdir, &file)?;
    let meta = fs::metadata(&full).map_err(|e| format!("Couldn't read {file}: {e}"))?;
    let version = version(&meta);
    let size = meta.len();
    let empty = WorkingFileContents { size, kind: "binary", text: None, crlf: false, bom: false, image: None, version };

    if let Some(mime) = image_type(&file).filter(|_| !as_text.unwrap_or(false))
        && size as usize <= MAX_IMAGE
    {
        let bytes = fs::read(&full).map_err(|e| format!("Couldn't read {file}: {e}"))?;
        return Ok(WorkingFileContents { kind: "image", image: Some(data_url(mime, &bytes)), ..empty });
    }
    if size > MAX_SHOWN {
        return Ok(WorkingFileContents { kind: "too_large", ..empty });
    }
    let bytes = fs::read(&full).map_err(|e| format!("Couldn't read {file}: {e}"))?;
    // git's own test for binary: a NUL near the start.
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return Ok(empty);
    }
    let Ok(text) = String::from_utf8(bytes) else { return Ok(empty) };
    let (text, bom) = match text.strip_prefix('\u{feff}') {
        Some(rest) => (rest.to_string(), true),
        None => (text, false),
    };
    // The line endings most of its lines use; saving gives every line those.
    let crlf_count = text.matches("\r\n").count();
    let crlf = crlf_count > 0 && crlf_count >= text.matches('\n').count() - crlf_count;
    let text = if crlf { text.replace("\r\n", "\n") } else { text };
    let kind = if size > MAX_EDITABLE { "read_only" } else { "text" };
    Ok(WorkingFileContents { kind, text: Some(text), crlf, bom, ..empty })
}

/// `file` as of the last commit, as text in the form read_working_file gives it ("\n"
/// line endings, no byte order mark), for marking the lines changed since. None for a
/// file that's new since, or that isn't text.
#[tauri::command]
pub async fn committed_text(path: String, file: String) -> Result<Option<String>, String> {
    let repo = Repository::discover(&path).map_err(|e| e.message().to_string())?;
    let Ok(tree) = repo.head().and_then(|head| head.peel_to_tree()) else { return Ok(None) };
    let Ok(entry) = tree.get_path(Path::new(&file)) else { return Ok(None) };
    let Ok(blob) = entry.to_object(&repo).and_then(|object| object.peel_to_blob()) else { return Ok(None) };
    if blob.is_binary() || blob.size() as u64 > MAX_SHOWN {
        return Ok(None);
    }
    let Ok(text) = std::str::from_utf8(blob.content()) else { return Ok(None) };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    Ok(Some(text.replace("\r\n", "\n")))
}

/// Saves `text` as `file`, with the line endings and byte order mark it was read
/// with, and returns its new version. It refuses if the file changed on disk since
/// `version` was read, so edits made elsewhere, by an editor or by Claude Code, aren't
/// overwritten. Written to a temporary file then moved over the old one, so the file
/// is never left half-written, and with the old one's permissions.
#[tauri::command]
pub async fn save_working_file(path: String, file: String, text: String, crlf: bool, bom: bool, version: String) -> Result<String, String> {
    let (_, workdir) = open(&path)?;
    let full = inside(&workdir, &file)?;
    if file.is_empty() {
        return Err("Choose a file to save.".into());
    }
    let meta = fs::symlink_metadata(&full).map_err(|e| format!("Couldn't save {file}: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("{file} is a link. Open it in your editor to change it."));
    }
    if !meta.is_file() {
        return Err(format!("{file} isn't a file."));
    }
    // Through a linked folder, the file could be outside the working copy.
    let parent = full.parent().ok_or_else(|| format!("Couldn't save {file}."))?;
    let real_parent = parent.canonicalize().map_err(|e| format!("Couldn't save {file}: {e}"))?;
    let real_workdir = workdir.canonicalize().map_err(|e| format!("Couldn't save {file}: {e}"))?;
    if !real_parent.starts_with(&real_workdir) {
        return Err(format!("{file} is outside the repository's folder."));
    }
    if self::version(&meta) != version {
        return Err(format!("{CHANGED_ON_DISK}{file} has changed on disk since you opened it."));
    }

    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom {
        bytes.extend_from_slice("\u{feff}".as_bytes());
    }
    bytes.extend_from_slice(if crlf { text.replace('\n', "\r\n") } else { text }.as_bytes());

    let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let temp = parent.join(format!(".{name}.palace-{}-{nanos}.tmp", std::process::id()));
    let written = (|| {
        let mut out = fs::File::create(&temp)?;
        out.write_all(&bytes)?;
        out.set_permissions(meta.permissions())?;
        out.sync_all()?;
        fs::rename(&temp, &full)
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(format!("Couldn't save {file}: {e}"));
    }
    let meta = fs::metadata(&full).map_err(|e| format!("Couldn't save {file}: {e}"))?;
    Ok(self::version(&meta))
}

/// Creates an empty file at `file` in the working copy, or with `folder`, a folder,
/// along with any folders on the way to it. Refuses if something's already there.
#[tauri::command]
pub async fn create_working_file(path: String, file: String, folder: bool) -> Result<(), String> {
    let (_, workdir) = open(&path)?;
    let file = file.trim().trim_end_matches('/').to_string();
    if file.is_empty() {
        return Err("Enter a name.".into());
    }
    let full = inside(&workdir, &file)?;
    if fs::symlink_metadata(&full).is_ok() {
        return Err(format!("{file} already exists."));
    }
    // The folders on the way could lead out of the working copy through a link.
    let real_workdir = workdir.canonicalize().map_err(|e| format!("Couldn't create {file}: {e}"))?;
    let existing = full.ancestors().skip(1).find(|dir| dir.exists()).unwrap_or(&workdir);
    let real_existing = existing.canonicalize().map_err(|e| format!("Couldn't create {file}: {e}"))?;
    if !real_existing.starts_with(&real_workdir) {
        return Err(format!("{file} would be outside the repository's folder."));
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {file}: {e}"))?;
    }
    let created = if folder {
        fs::create_dir(&full)
    } else {
        fs::OpenOptions::new().write(true).create_new(true).open(&full).map(drop)
    };
    created.map_err(|e| format!("Couldn't create {file}: {e}"))
}

/// Copies `file` beside itself as "name copy.ext" (or "name copy 2.ext", and so on, if
/// that's taken), and returns the copy's path.
#[tauri::command]
pub async fn duplicate_working_file(path: String, file: String) -> Result<String, String> {
    let (_, workdir) = open(&path)?;
    let full = inside(&workdir, &file)?;
    let meta = fs::symlink_metadata(&full).map_err(|e| format!("Couldn't duplicate {file}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{file} isn't a file Palace can duplicate."));
    }
    let parent = full.parent().ok_or_else(|| format!("Couldn't duplicate {file}."))?;
    let real_parent = parent.canonicalize().map_err(|e| format!("Couldn't duplicate {file}: {e}"))?;
    let real_workdir = workdir.canonicalize().map_err(|e| format!("Couldn't duplicate {file}: {e}"))?;
    if !real_parent.starts_with(&real_workdir) {
        return Err(format!("{file} is outside the repository's folder."));
    }
    let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // "notes.md" -> ("notes", ".md"); ".env" and "Makefile" have no extension.
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name.as_str(), ""),
    };
    let copy = (1..1000)
        .map(|n| if n == 1 { format!("{stem} copy{extension}") } else { format!("{stem} copy {n}{extension}") })
        .find(|candidate| fs::symlink_metadata(parent.join(candidate)).is_err())
        .ok_or_else(|| format!("Couldn't find a name for a copy of {file}."))?;
    // Not over anything that appeared meanwhile.
    let mut from = fs::File::open(&full).map_err(|e| format!("Couldn't duplicate {file}: {e}"))?;
    let mut to = fs::OpenOptions::new().write(true).create_new(true).open(parent.join(&copy)).map_err(|e| format!("Couldn't duplicate {file}: {e}"))?;
    std::io::copy(&mut from, &mut to).map_err(|e| format!("Couldn't duplicate {file}: {e}"))?;
    let _ = to.set_permissions(meta.permissions());
    let folder = file.rsplit_once('/').map(|(dir, _)| dir);
    Ok(match folder {
        Some(dir) => format!("{dir}/{copy}"),
        None => copy,
    })
}

/// Renames `from` to `to`, a file or a folder, making any new folders on the way to
/// it. Refuses if something's already called `to`.
#[tauri::command]
pub async fn rename_working_file(path: String, from: String, to: String) -> Result<(), String> {
    let (_, workdir) = open(&path)?;
    let to = to.trim().trim_end_matches('/').to_string();
    if from.trim().is_empty() || to.is_empty() {
        return Err("Enter a name.".into());
    }
    let old = inside(&workdir, &from)?;
    let new = inside(&workdir, &to)?;
    fs::symlink_metadata(&old).map_err(|e| format!("Couldn't rename {from}: {e}"))?;
    if fs::symlink_metadata(&new).is_ok() && !same_file_in_other_case(&old, &new) {
        return Err(format!("{to} already exists."));
    }
    // Neither end may be outside the working copy through a linked folder.
    let real_workdir = workdir.canonicalize().map_err(|e| format!("Couldn't rename {from}: {e}"))?;
    for end in [&old, &new] {
        let existing = end.ancestors().skip(1).find(|dir| dir.exists()).unwrap_or(&workdir);
        let real = existing.canonicalize().map_err(|e| format!("Couldn't rename {from}: {e}"))?;
        if !real.starts_with(&real_workdir) {
            return Err(format!("{} is outside the repository's folder.", if end == &old { &from } else { &to }));
        }
    }
    if new.starts_with(&old) {
        return Err(format!("{from} can't go inside itself."));
    }
    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't rename {from}: {e}"))?;
    }
    fs::rename(&old, &new).map_err(|e| format!("Couldn't rename {from}: {e}"))
}

/// Moves `file`, or a folder and everything in it, to the Trash, where it can be got
/// back from.
#[tauri::command]
pub async fn delete_working_file(path: String, file: String) -> Result<(), String> {
    delete(&path, &file, &crate::working::move_to_trash)
}

fn delete(path: &str, file: &str, trash: &dyn Fn(&Path) -> Result<(), String>) -> Result<(), String> {
    let (_, workdir) = open(path)?;
    if file.trim().is_empty() {
        return Err("Choose a file to delete.".into());
    }
    let full = inside(&workdir, file)?;
    fs::symlink_metadata(&full).map_err(|e| format!("Couldn't delete {file}: {e}"))?;
    // Through a linked folder, it could be outside the working copy.
    let parent = full.parent().ok_or_else(|| format!("Couldn't delete {file}."))?;
    let real_parent = parent.canonicalize().map_err(|e| format!("Couldn't delete {file}: {e}"))?;
    let real_workdir = workdir.canonicalize().map_err(|e| format!("Couldn't delete {file}: {e}"))?;
    if !real_parent.starts_with(&real_workdir) {
        return Err(format!("{file} is outside the repository's folder."));
    }
    trash(&full)
}

/// Whether git ignores `relative`, a path in the working copy, as Palace means it: an
/// ignore rule matches it, and it isn't tracked anyway. Rules alone say a tracked file
/// is ignored when it matches one, as one added before the rule was, and so a folder
/// such as an ignored logs/ kept by a tracked .gitkeep in it.
pub(crate) fn ignored(repo: &Repository, relative: &Path, is_dir: bool) -> bool {
    // git matches folder-only patterns like "vendor/" against paths ending in a slash.
    let mut rule_path = relative.to_path_buf();
    if is_dir {
        rule_path.as_mut_os_string().push("/");
    }
    if !repo.is_path_ignored(&rule_path).unwrap_or(false) {
        return false;
    }
    // The index as it is now, as files are added: read again only if it's changed.
    let Ok(mut index) = repo.index() else { return true };
    let _ = index.read(false);
    if is_dir {
        // The index lists files, by paths with "/" between their folders.
        let prefix = format!("{}/", relative.to_string_lossy().replace('\\', "/"));
        index.find_prefix(prefix.as_str()).is_err()
    } else {
        index.get_path(relative, 0).is_none()
    }
}

fn open(path: &str) -> Result<(Repository, PathBuf), String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    let workdir = repo.workdir().ok_or("This repository has no working copy.")?.to_path_buf();
    Ok((repo, workdir))
}

/// `relative` within the working copy, refusing a path that would lead out of it or
/// into .git.
fn inside(workdir: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut full = workdir.to_path_buf();
    for (i, part) in Path::new(relative).components().enumerate() {
        match part {
            Component::Normal(name) if i == 0 && name.to_str().is_some_and(is_git_dir) => {
                return Err(format!("{relative} is inside .git."))
            }
            Component::Normal(name) => full.push(name),
            _ => return Err(format!("{relative} isn't a path inside the repository.")),
        }
    }
    Ok(full)
}

/// Whether `name` at the top of the working copy is the repository's .git, which a
/// Mac's disks, ignoring case, also find as ".GIT" or ".Git".
fn is_git_dir(name: &str) -> bool {
    name.eq_ignore_ascii_case(".git")
}

/// Whether `old` and `new` are one file under two names differing only in case, as on
/// a Mac's disks, which ignore case: renaming one to the other changes its case.
fn same_file_in_other_case(old: &Path, new: &Path) -> bool {
    if old == new || old.to_string_lossy().to_lowercase() != new.to_string_lossy().to_lowercase() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::symlink_metadata(old), fs::symlink_metadata(new)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    true
}

/// Identifies a version of a file by when it was last changed and how big it is.
fn version(meta: &fs::Metadata) -> String {
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{modified}:{}", meta.len())
}

fn shown(dir: &str) -> &str {
    if dir.is_empty() { "the repository's folder" } else { dir }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;
    use tauri::async_runtime::block_on;

    fn path(t: &TempRepo) -> String {
        t.dir.to_string_lossy().into_owned()
    }

    #[test]
    fn listing_a_folder() {
        let t = TempRepo::new("files-list");
        fs::write(t.dir.join(".gitignore"), "build/\n").unwrap();
        fs::create_dir_all(t.dir.join("src/lib")).unwrap();
        fs::create_dir_all(t.dir.join("build")).unwrap();
        fs::write(t.dir.join("src/main.rs"), "").unwrap();
        fs::write(t.dir.join("README.md"), "").unwrap();
        fs::write(t.dir.join("build/out.js"), "").unwrap();

        let names = block_on(working_entries(path(&t), "".into())).unwrap().into_iter().map(|e| (e.name, e.kind, e.ignored)).collect::<Vec<_>>();
        // Folders first, then files; never .git; ignored ones marked.
        assert_eq!(
            names,
            [("build".into(), "dir", true), ("src".into(), "dir", false), (".gitignore".into(), "file", false), ("README.md".into(), "file", false)]
        );
        let inner = block_on(working_entries(path(&t), "src".into())).unwrap();
        assert_eq!(inner[1].path, "src/main.rs");
    }

    #[test]
    fn ignored_means_matched_by_a_rule_and_not_tracked() {
        let t = TempRepo::new("files-ignored");
        // Tracked before the rules were added: a .gitkeep keeping logs/, and a log.
        t.commit(&[("logs/.gitkeep", Some("")), ("kept.log", Some("")), (".gitignore", Some("logs/\n*.log\n.env\n"))], "First");
        t.write(&[(".env", Some("")), ("debug.log", Some("")), ("logs/today.txt", Some(""))]);
        let marks = |dir: &str| {
            block_on(working_entries(path(&t), dir.into())).unwrap().into_iter().map(|e| (e.name, e.ignored)).collect::<Vec<_>>()
        };
        assert_eq!(
            marks(""),
            [("logs".into(), false), (".env".into(), true), (".gitignore".into(), false), ("debug.log".into(), true), ("kept.log".into(), false)]
        );
        assert_eq!(marks("logs"), [(".gitkeep".into(), false), ("today.txt".into(), true)]);
    }

    #[test]
    fn paths_stay_inside_the_working_copy() {
        let t = TempRepo::new("files-inside");
        for bad in ["../outside", "/etc/passwd", ".git/config", ".GIT/config", ".Git/hooks", "src/../../x"] {
            assert!(block_on(read_working_file(path(&t), bad.into(), None)).is_err(), "{bad}");
            assert!(block_on(working_entries(path(&t), bad.into())).is_err(), "{bad}");
        }
    }

    #[test]
    fn reading_text_binary_and_line_endings() {
        let t = TempRepo::new("files-read");
        fs::write(t.dir.join("unix.txt"), "a\nb\n").unwrap();
        fs::write(t.dir.join("windows.txt"), "\u{feff}a\r\nb\r\n").unwrap();
        fs::write(t.dir.join("data.bin"), [0u8, 1, 2]).unwrap();
        fs::write(t.dir.join("latin1.txt"), [b'c', b'a', b'f', 0xe9]).unwrap();

        let read = |f: &str| block_on(read_working_file(path(&t), f.into(), None)).unwrap();
        let unix = read("unix.txt");
        assert_eq!((unix.kind, unix.text.as_deref(), unix.crlf, unix.bom), ("text", Some("a\nb\n"), false, false));
        let windows = read("windows.txt");
        assert_eq!((windows.text.as_deref(), windows.crlf, windows.bom), (Some("a\nb\n"), true, true));
        assert_eq!(read("data.bin").kind, "binary");
        assert_eq!(read("latin1.txt").kind, "binary");
    }

    #[test]
    fn saving_keeps_line_endings_and_permissions() {
        let t = TempRepo::new("files-save");
        fs::write(t.dir.join("windows.txt"), "\u{feff}a\r\nb\r\n").unwrap();
        fs::write(t.dir.join("run.sh"), "echo hi\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(t.dir.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        }

        let read = block_on(read_working_file(path(&t), "windows.txt".into(), None)).unwrap();
        block_on(save_working_file(path(&t), "windows.txt".into(), "a\nchanged\n".into(), read.crlf, read.bom, read.version)).unwrap();
        assert_eq!(fs::read_to_string(t.dir.join("windows.txt")).unwrap(), "\u{feff}a\r\nchanged\r\n");

        let read = block_on(read_working_file(path(&t), "run.sh".into(), None)).unwrap();
        block_on(save_working_file(path(&t), "run.sh".into(), "echo bye\n".into(), false, false, read.version)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(t.dir.join("run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
        }
        // Nothing left behind.
        let leftovers: Vec<_> = fs::read_dir(&t.dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn saving_refuses_to_overwrite_changes_made_elsewhere() {
        let t = TempRepo::new("files-stale");
        fs::write(t.dir.join("notes.txt"), "mine\n").unwrap();
        let read = block_on(read_working_file(path(&t), "notes.txt".into(), None)).unwrap();
        // Changed by something else meanwhile, such as Claude Code.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(t.dir.join("notes.txt"), "theirs, and longer\n").unwrap();

        let refused = block_on(save_working_file(path(&t), "notes.txt".into(), "edited\n".into(), false, false, read.version)).unwrap_err();
        assert!(refused.starts_with(CHANGED_ON_DISK), "{refused}");
        assert_eq!(fs::read_to_string(t.dir.join("notes.txt")).unwrap(), "theirs, and longer\n");
    }

    #[test]
    fn creating_files_and_folders() {
        let t = TempRepo::new("files-create");
        let create = |f: &str, folder: bool| block_on(create_working_file(path(&t), f.into(), folder));

        create("docs/guide/intro.md", false).unwrap();
        assert_eq!(fs::read_to_string(t.dir.join("docs/guide/intro.md")).unwrap(), "");
        create("assets/", true).unwrap();
        assert!(t.dir.join("assets").is_dir());

        // Never over something that's there, nor outside the working copy or into .git.
        fs::write(t.dir.join("docs/guide/intro.md"), "kept\n").unwrap();
        assert!(create("docs/guide/intro.md", false).is_err());
        assert_eq!(fs::read_to_string(t.dir.join("docs/guide/intro.md")).unwrap(), "kept\n");
        assert!(create("assets", true).is_err());
        for bad in ["", "  ", "../outside.txt", ".git/hooks/pre-commit", "/tmp/x"] {
            assert!(create(bad, false).is_err(), "{bad}");
        }
    }

    #[test]
    fn reading_the_committed_version() {
        let t = TempRepo::new("files-committed");
        let committed = |f: &str| block_on(committed_text(path(&t), f.into())).unwrap();
        // Before any commit.
        fs::write(t.dir.join("a.txt"), "new\n").unwrap();
        assert_eq!(committed("a.txt"), None);

        t.commit(&[("a.txt", Some("one\r\ntwo\r\n")), ("data.bin", Some("\0\x01"))], "Start");
        fs::write(t.dir.join("a.txt"), "one\nchanged\n").unwrap();
        assert_eq!(committed("a.txt").as_deref(), Some("one\ntwo\n"));
        assert_eq!(committed("data.bin"), None);
        assert_eq!(committed("missing.txt"), None);
    }

    #[test]
    fn svgs_large_files_and_duplicates() {
        let t = TempRepo::new("files-more");
        fs::write(t.dir.join("logo.svg"), "<svg/>\n").unwrap();
        let read = |f: &str, as_text| block_on(read_working_file(path(&t), f.into(), as_text)).unwrap();
        assert_eq!(read("logo.svg", None).kind, "image");
        let svg = read("logo.svg", Some(true));
        assert_eq!((svg.kind, svg.text.as_deref()), ("text", Some("<svg/>\n")));

        // Too large to edit, but not to read.
        fs::write(t.dir.join("big.log"), "x\n".repeat(1_500_000)).unwrap();
        assert_eq!(read("big.log", None).kind, "read_only");
        fs::write(t.dir.join("huge.log"), "x\n".repeat(6_000_000)).unwrap();
        assert_eq!(read("huge.log", None).kind, "too_large");

        fs::create_dir_all(t.dir.join("docs")).unwrap();
        fs::write(t.dir.join("docs/notes.md"), "n\n").unwrap();
        fs::write(t.dir.join(".env"), "A=1\n").unwrap();
        let duplicate = |f: &str| block_on(duplicate_working_file(path(&t), f.into()));
        assert_eq!(duplicate("docs/notes.md").unwrap(), "docs/notes copy.md");
        assert_eq!(duplicate("docs/notes.md").unwrap(), "docs/notes copy 2.md");
        assert_eq!(duplicate(".env").unwrap(), ".env copy");
        assert_eq!(fs::read_to_string(t.dir.join("docs/notes copy 2.md")).unwrap(), "n\n");
        assert!(duplicate("docs").is_err());
        assert!(duplicate("../x").is_err());
    }

    #[test]
    fn renaming_files_and_folders() {
        let t = TempRepo::new("files-rename");
        fs::create_dir_all(t.dir.join("docs")).unwrap();
        fs::write(t.dir.join("docs/a.md"), "a\n").unwrap();
        fs::write(t.dir.join("b.md"), "b\n").unwrap();
        let rename = |from: &str, to: &str| block_on(rename_working_file(path(&t), from.into(), to.into()));

        rename("docs/a.md", "docs/intro.md").unwrap();
        assert_eq!(fs::read_to_string(t.dir.join("docs/intro.md")).unwrap(), "a\n");
        // Into a new folder, and a whole folder at once.
        rename("docs/intro.md", "docs/guide/intro.md").unwrap();
        rename("docs", "manual").unwrap();
        assert_eq!(fs::read_to_string(t.dir.join("manual/guide/intro.md")).unwrap(), "a\n");

        // Never over something that's there, into itself, outside the working copy or into .git.
        assert!(rename("b.md", "manual").is_err());
        assert!(rename("manual", "manual/inner").is_err());
        for bad in ["../b.md", ".git/b.md", "", "/tmp/b.md"] {
            assert!(rename("b.md", bad).is_err(), "{bad}");
        }
        assert!(rename(".git", "git").is_err());
        assert!(rename("missing.md", "found.md").is_err());
        assert_eq!(fs::read_to_string(t.dir.join("b.md")).unwrap(), "b\n");
    }

    #[test]
    fn renaming_to_change_case() {
        let t = TempRepo::new("files-rename-case");
        fs::create_dir_all(t.dir.join("docs")).unwrap();
        fs::write(t.dir.join("readme.md"), "r\n").unwrap();
        fs::write(t.dir.join("other.md"), "o\n").unwrap();
        let rename = |from: &str, to: &str| block_on(rename_working_file(path(&t), from.into(), to.into()));

        // Whether or not the disk ignores case, as a Mac's does.
        rename("readme.md", "README.md").unwrap();
        rename("docs", "Docs").unwrap();
        let names: Vec<String> = fs::read_dir(&t.dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&"README.md".into()) && !names.contains(&"readme.md".into()), "{names:?}");
        assert!(names.contains(&"Docs".into()) && !names.contains(&"docs".into()), "{names:?}");
        assert_eq!(fs::read_to_string(t.dir.join("README.md")).unwrap(), "r\n");
        // Still never over another file.
        assert!(rename("other.md", "README.md").is_err());
        assert_eq!(fs::read_to_string(t.dir.join("README.md")).unwrap(), "r\n");
    }

    #[test]
    fn deleting_moves_to_the_trash() {
        let t = TempRepo::new("files-delete");
        fs::create_dir_all(t.dir.join("docs/old")).unwrap();
        fs::write(t.dir.join("docs/old/a.md"), "").unwrap();
        fs::write(t.dir.join("notes.txt"), "").unwrap();
        // The Trash, for the test: what's moved there, and gone from the folder.
        let trashed = std::cell::RefCell::new(Vec::new());
        let real_dir = t.dir.canonicalize().unwrap();
        let trash = |full: &Path| {
            let relative = full.strip_prefix(&real_dir).or_else(|_| full.strip_prefix(&t.dir)).unwrap();
            trashed.borrow_mut().push(relative.to_path_buf());
            if full.is_dir() { fs::remove_dir_all(full) } else { fs::remove_file(full) }.map_err(|e| e.to_string())
        };

        delete(&path(&t), "notes.txt", &trash).unwrap();
        delete(&path(&t), "docs/old", &trash).unwrap();
        assert_eq!(*trashed.borrow(), [PathBuf::from("notes.txt"), PathBuf::from("docs/old")]);
        assert!(!t.dir.join("docs/old").exists() && t.dir.join("docs").exists());

        // Nothing that isn't there, nor the repository itself, outside it or .git.
        for bad in ["notes.txt", "", "..", "../x", ".git", ".git/config"] {
            assert!(delete(&path(&t), bad, &trash).is_err(), "{bad}");
        }
        assert_eq!(trashed.borrow().len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn creating_refuses_to_go_through_links_outside() {
        let t = TempRepo::new("files-create-link");
        let outside = std::env::temp_dir().join(format!("palace-test-outside-dir-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, t.dir.join("elsewhere")).unwrap();
        assert!(block_on(create_working_file(path(&t), "elsewhere/new.txt".into(), false)).is_err());
        assert!(!outside.join("new.txt").exists());
        fs::remove_dir_all(&outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn saving_refuses_links() {
        let t = TempRepo::new("files-link");
        let outside = std::env::temp_dir().join(format!("palace-test-outside-{}", std::process::id()));
        fs::write(&outside, "secret\n").unwrap();
        std::os::unix::fs::symlink(&outside, t.dir.join("link.txt")).unwrap();
        let read = block_on(read_working_file(path(&t), "link.txt".into(), None)).unwrap();
        assert!(block_on(save_working_file(path(&t), "link.txt".into(), "changed\n".into(), false, false, read.version)).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "secret\n");
        fs::remove_file(&outside).unwrap();
    }
}
