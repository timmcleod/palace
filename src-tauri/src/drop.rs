//! Files dragged in from the desktop and dropped on a terminal, where the web view won't
//! say where they are, as WebKit on macOS may not: the page has their contents, which
//! Palace saves to a folder of its own under the system's temporary folder, so the
//! terminal can be given a path to them, as for an image for Claude Code to look at.
//! They're cleared away a day later, when Palace next starts, by when whatever was
//! given them has long read them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};
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

/// How long a dropped file's copy is kept.
const KEPT_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// Clears away the copies of dropped files saved more than a day ago, on a thread of its
/// own, as Palace starts.
pub fn clear_old() {
    std::thread::spawn(|| clear_older_than(&drops_folder(), SystemTime::now() - KEPT_FOR));
}

/// Removes the folders in `drops`, each a dropped file's, last changed before `cutoff`.
/// One that can't be read or removed is left for next time.
fn clear_older_than(drops: &Path, cutoff: SystemTime) {
    let Ok(entries) = std::fs::read_dir(drops) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).is_ok_and(|changed| changed < cutoff);
        if old && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
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
    fn clearing_away_copies_saved_more_than_a_day_ago() {
        let drops = std::env::temp_dir().join(format!("palace-test-drops-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&drops);
        let save = |name: &str, age: Duration| {
            let folder = drops.join(name);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("shot.png"), b"png").unwrap();
            std::fs::File::open(&folder).unwrap().set_modified(SystemTime::now() - age).unwrap();
        };
        save("old", KEPT_FOR + Duration::from_secs(60));
        save("new", Duration::from_secs(60));
        // Something else that's there isn't Palace's to remove.
        std::fs::write(drops.join("note.txt"), b"").unwrap();
        std::fs::File::open(drops.join("note.txt")).unwrap().set_modified(SystemTime::now() - KEPT_FOR * 2).unwrap();

        clear_older_than(&drops, SystemTime::now() - KEPT_FOR);
        assert!(!drops.join("old").exists());
        assert!(drops.join("new/shot.png").exists());
        assert!(drops.join("note.txt").exists());
        // With nothing dropped yet, there's nothing to do.
        clear_older_than(&drops.join("missing"), SystemTime::now());
        std::fs::remove_dir_all(&drops).unwrap();
    }

    #[test]
    fn naming_a_dropped_file() {
        assert_eq!(safe_name("Screenshot-2026-11-06.png"), "Screenshot-2026-11-06.png");
        assert_eq!(safe_name("../../etc/passwd"), "..-..-etc-passwd");
        assert_eq!(safe_name(".."), "dropped");
        assert_eq!(safe_name(""), "dropped");
    }
}
