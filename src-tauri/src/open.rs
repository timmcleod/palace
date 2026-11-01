//! Opening the repository outside Palace: its folder in the file manager, and a file
//! shown in its folder.

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

fn workdir(path: &str) -> Result<PathBuf, String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    repo.workdir().map(Path::to_path_buf).ok_or_else(|| "This repository has no working copy.".into())
}
