//! Opening the repository outside Palace: its folder in the file manager, a file shown
//! in its folder, and a file in the app the system has for it.

use git2::Repository;
use std::path::{Path, PathBuf};
use tauri_plugin_opener::OpenerExt;

/// Opens the working copy's folder in the file manager.
#[tauri::command]
pub async fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = workdir(&path)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Couldn't open the folder: {e}"))
}

/// Opens the folder holding `file` in the file manager, with the file selected. A
/// deleted file's nearest remaining folder is opened instead.
#[tauri::command]
pub async fn show_in_folder(app: tauri::AppHandle, path: String, file: String) -> Result<(), String> {
    let full = workdir(&path)?.join(&file);
    if full.exists() {
        return tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(full))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Couldn't show {file}: {e}"));
    }
    let folder = full.ancestors().find(|p| p.is_dir()).unwrap_or(&full).to_path_buf();
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Couldn't open the folder: {e}"))
}

/// Opens `file` in the app the system has for its type. On a Mac, a text file of a type no
/// app has claimed, as .vue before an editor has said it opens them, opens in the text
/// editor instead, rather than not at all.
#[tauri::command]
pub async fn open_in_editor(app: tauri::AppHandle, path: String, file: String) -> Result<(), String> {
    let full = workdir(&path)?.join(&file);
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || open_on_mac(&full, &file)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    app.opener()
        .open_path(full.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Couldn't open {file}: {e}"))
}

// Runs `open` itself, rather than through the opener plugin, to read why it failed: the
// plugin says only its exit status.
#[cfg(target_os = "macos")]
fn open_on_mac(full: &Path, file: &str) -> Result<(), String> {
    use std::process::Command;
    let run = |args: &[&str]| Command::new("/usr/bin/open").args(args).arg("--").arg(full).output();
    let opened = run(&[]).map_err(|e| format!("Couldn't open {file}: {e}"))?;
    if opened.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&opened.stderr);
    if !no_app_claims(&why) {
        return Err(format!("Couldn't open {file}: {}", why.trim()));
    }
    // Opening a binary file as text would only show it garbled.
    if is_text(full) && run(&["-t"]).is_ok_and(|o| o.status.success()) {
        return Ok(());
    }
    Err(no_app_message(file))
}

#[cfg(target_os = "macos")]
/// Whether `open` failed because no app on the Mac claims the file's type.
fn no_app_claims(stderr: &str) -> bool {
    stderr.contains("kLSApplicationNotFoundErr") || stderr.contains("-10814")
}

#[cfg(target_os = "macos")]
/// What to say when no app opens `file`, with how to choose one.
fn no_app_message(file: &str) -> String {
    let name = Path::new(file).file_name().map_or(file.into(), |n| n.to_string_lossy());
    let kind = match Path::new(file).extension() {
        Some(ext) => format!(".{} files", ext.to_string_lossy()),
        None => format!("“{name}”"),
    };
    format!(
        "No app is set to open {kind}. To choose one, select {name} in Finder, choose File > Get Info, \
         pick an app under “Open with”, and click Change All."
    )
}

#[cfg(target_os = "macos")]
/// Whether the file reads as text, as git decides: no NUL byte near its start.
fn is_text(full: &Path) -> bool {
    use std::io::Read;
    let mut start = Vec::new();
    std::fs::File::open(full).and_then(|f| f.take(8000).read_to_end(&mut start)).is_ok_and(|_| !start.contains(&0))
}

fn workdir(path: &str) -> Result<PathBuf, String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    repo.workdir().map(Path::to_path_buf).ok_or_else(|| "This repository has no working copy.".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn knows_when_no_app_claims_a_file() {
        let stderr = "No application knows how to open URL file:///x/App.vue (Error Domain=NSOSStatusErrorDomain \
                      Code=-10814 \"kLSApplicationNotFoundErr: E.g. no application claims the file\")";
        assert!(no_app_claims(stderr));
        assert!(!no_app_claims("The file /x/App.vue does not exist."));
    }

    #[test]
    fn says_which_files_need_an_app_and_how_to_choose_one() {
        let said = no_app_message("src/App.vue");
        assert!(said.starts_with("No app is set to open .vue files. To choose one, select App.vue in Finder"), "{said}");
        assert!(no_app_message("Procfile").starts_with("No app is set to open “Procfile”."));
    }

    #[test]
    fn a_file_with_a_nul_byte_isnt_text() {
        let dir = std::env::temp_dir().join(format!("palace-open-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.vue"), "<template></template>\n").unwrap();
        std::fs::write(dir.join("b.bin"), [0x89, b'P', 0, 1]).unwrap();
        assert!(is_text(&dir.join("a.vue")));
        assert!(!is_text(&dir.join("b.bin")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
