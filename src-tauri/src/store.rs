//! Palace's own saved data: settings, recent repositories, the sidebar's branch order
//! and the like, as JSON values by key in a file in the app's data folder. The web
//! view's storage isn't safe for it: a web view that starts while another still holds
//! that storage starts with none, and the first thing saved then overwrites it all.

use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Whether the file was readable when Palace started. When it wasn't, nothing is
/// saved over it.
#[derive(Default)]
pub struct Store(Mutex<Option<bool>>);

// Development builds keep their own, as their web view's storage is separate too.
const FILE: &str = if cfg!(debug_assertions) { "saved-dev.json" } else { "saved.json" };

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("Couldn't find Palace's data folder: {e}"))?;
    Ok(dir.join(FILE))
}

/// Everything saved, or None before anything has been (the first start, or the first
/// since Palace kept these in the web view's storage).
#[tauri::command]
pub fn load_store(app: AppHandle, store: tauri::State<Store>) -> Result<Option<Map<String, Value>>, String> {
    let read = read(&file(&app)?);
    *store.0.lock().unwrap() = Some(read.is_ok());
    read
}

/// Saves each value under its key, leaving the others as they are in the file, which
/// may have been saved by another copy of Palace.
#[tauri::command]
pub fn save_store(app: AppHandle, store: tauri::State<Store>, values: Map<String, Value>) -> Result<(), String> {
    let readable = store.0.lock().unwrap();
    if *readable != Some(true) {
        return Err("Palace couldn't read its saved settings when it started, so it isn't saving over them.".into());
    }
    write(&file(&app)?, values)
}

/// When the file can't be read: renames it out of the way, kept in case it's needed,
/// so saving can start again.
#[tauri::command]
pub fn set_store_aside(app: AppHandle, store: tauri::State<Store>) -> Result<(), String> {
    let mut readable = store.0.lock().unwrap();
    let path = file(&app)?;
    if path.exists() {
        let aside = path.with_extension(format!("unreadable-{}.json", seconds_now()));
        fs::rename(&path, &aside).map_err(|e| format!("Couldn't rename {}: {e}", path.display()))?;
    }
    *readable = Some(true);
    Ok(())
}

/// Seconds since 1970, to tell set-aside files apart.
fn seconds_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Couldn't read {}: {e}", path.display())),
    };
    serde_json::from_str(&text).map(Some).map_err(|e| format!("{} isn't readable: {e}", path.display()))
}

fn write(path: &Path, values: Map<String, Value>) -> Result<(), String> {
    let mut all = read(path)?.unwrap_or_default();
    all.extend(values);
    let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    }
    // Written whole beside it, then swapped in, so the file is never half written.
    let partial = path.with_extension("json.partial");
    let saved = (|| {
        let mut out = fs::File::create(&partial)?;
        std::io::Write::write_all(&mut out, text.as_bytes())?;
        out.sync_all()?;
        fs::rename(&partial, path)
    })();
    saved.map_err(|e| format!("Couldn't save to {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn saving_keeps_the_other_keys() {
        let dir = std::env::temp_dir().join(format!("palace-test-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join(FILE);
        assert_eq!(read(&path).unwrap(), None);

        write(&path, map(json!({ "a": 1, "b": { "x": true } }))).unwrap();
        write(&path, map(json!({ "b": [2] }))).unwrap();
        assert_eq!(read(&path).unwrap(), Some(map(json!({ "a": 1, "b": [2] }))));

        // A file that can't be read is never written over.
        fs::write(&path, "{ not json").unwrap();
        assert!(read(&path).is_err());
        assert!(write(&path, map(json!({ "c": 3 }))).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        let _ = fs::remove_dir_all(&dir);
    }
}
