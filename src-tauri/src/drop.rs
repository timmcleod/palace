//! Files dragged in from the desktop and dropped on a terminal, where the web view won't
//! say where they are, as WebKit on macOS may not: the page has their contents, which
//! Palace saves to a folder of its own under the system's temporary folder, so the
//! terminal can be given a path to them, as for an image for Claude Code to look at.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::ipc::{InvokeBody, Request};

static NEXT: AtomicU32 = AtomicU32::new(1);

/// Saves the file in the request's body, named by its "name" header, and returns the
/// path it's saved at. Each is saved in a folder of its own, so files of one name
/// dropped one after another are kept apart.
#[tauri::command]
pub fn save_dropped_file(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("The dropped file's contents didn't arrive.".into());
    };
    let name = request.headers().get("name").and_then(|v| v.to_str().ok()).map(safe_name).unwrap_or_else(|| "dropped".into());
    let folder = drops_folder().join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&folder).map_err(|e| format!("Couldn't save the dropped file: {e}"))?;
    let path = folder.join(name);
    std::fs::write(&path, data).map_err(|e| format!("Couldn't save the dropped file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn drops_folder() -> PathBuf {
    std::env::temp_dir().join("palace-drops")
}

/// A file name that stays in its folder: no separators, and not "." or "..".
fn safe_name(name: &str) -> String {
    let name: String = name.chars().map(|c| if c == '/' || c == '\\' || c.is_control() { '-' } else { c }).collect();
    match name.trim() {
        "" | "." | ".." => "dropped".into(),
        name => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naming_a_dropped_file() {
        assert_eq!(safe_name("Screenshot-2026-11-06.png"), "Screenshot-2026-11-06.png");
        assert_eq!(safe_name("../../etc/passwd"), "..-..-etc-passwd");
        assert_eq!(safe_name(".."), "dropped");
        assert_eq!(safe_name(""), "dropped");
    }
}
