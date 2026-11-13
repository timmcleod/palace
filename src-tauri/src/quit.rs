//! Closing a window, or quitting, with work that would be lost: programs running in
//! terminals, or edits in the Files view that aren't saved. Palace asks first, in the
//! window being closed, or for quitting, the one in front, naming what's at stake, and
//! goes ahead only if told to.

use crate::terminal;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

/// Set once the user has said to quit anyway.
static CONFIRMED: AtomicBool = AtomicBool::new(false);
/// The files with edits not saved in each window, by window, as the page last said.
static UNSAVED: LazyLock<Mutex<HashMap<String, Vec<Unsaved>>>> = LazyLock::new(Default::default);

/// A file with edits not saved: the repository it's in, and the file as the user's told
/// of it, “name” in repository.
#[derive(Deserialize, Clone)]
pub struct Unsaved {
    path: String,
    described: String,
}
/// When a page was last asked, until it says it's asking the user. A page that never
/// says so, broken or still loading, can't ask, so trying again goes ahead rather than
/// leaving Palace impossible to close.
static UNANSWERED: Mutex<Option<Instant>> = Mutex::new(None);
const PAGE_ANSWERS_WITHIN: Duration = Duration::from_secs(2);

#[derive(Serialize, Clone)]
struct Held {
    /// Whether Palace is quitting, rather than only this window closing.
    quitting: bool,
    /// This window's terminals with programs running in them.
    terminals: Vec<u32>,
    /// Whether this window has edits that aren't saved; the page knows which.
    edits: bool,
    /// Quitting, the folders of other windows' terminals with programs running.
    other_terminals: Vec<String>,
    /// Quitting, the files with edits not saved in other windows.
    other_edits: Vec<String>,
}

/// Whether closing `window`, or with None, quitting, should wait for the user, who's
/// asked ("quit-requested") when it would lose something. It goes ahead with
/// `quit_confirmed`.
pub fn hold(app: &AppHandle, window: Option<&str>) -> bool {
    if CONFIRMED.load(Ordering::Relaxed) {
        return false;
    }
    let asking = match window {
        Some(label) => label.to_string(),
        None => {
            let windows = app.webview_windows();
            let front = windows.values().find(|w| w.is_focused().unwrap_or(false)).or_else(|| windows.values().next());
            match front {
                Some(front) => front.label().to_string(),
                None => return false,
            }
        }
    };
    let quitting = window.is_none();
    let busy = terminal::busy_terminals();
    let unsaved = UNSAVED.lock().unwrap().clone();
    let held = Held {
        quitting,
        terminals: busy.iter().filter(|t| t.window == asking).map(|t| t.id).collect(),
        edits: unsaved.get(&asking).is_some_and(|files| !files.is_empty()),
        other_terminals: busy.iter().filter(|t| quitting && t.window != asking).map(|t| t.folder.clone()).collect(),
        other_edits: unsaved.iter().filter(|(w, _)| quitting && **w != asking).flat_map(|(_, files)| files.iter().map(|f| f.described.clone())).collect(),
    };
    if held.terminals.is_empty() && !held.edits && held.other_terminals.is_empty() && held.other_edits.is_empty() {
        return false;
    }
    let mut unanswered = UNANSWERED.lock().unwrap();
    if unanswered.is_some_and(|asked| asked.elapsed() >= PAGE_ANSWERS_WITHIN) {
        *unanswered = None;
        return false;
    }
    unanswered.get_or_insert_with(Instant::now);
    drop(unanswered);
    // Asked where it's seen: quitting with every window minimized, or hidden, the one
    // asked would otherwise ask out of sight, and Palace seem not to quit.
    if let Some(window) = app.get_webview_window(&asking) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit_to(EventTarget::webview_window(&asking), "quit-requested", held);
    true
}

/// The page saying it's asking the user whether to close or quit.
#[tauri::command]
pub fn quit_asking() {
    *UNANSWERED.lock().unwrap() = None;
}

/// The page saying which of its files have edits that aren't saved.
#[tauri::command]
pub fn set_unsaved_edits(window: WebviewWindow, files: Vec<Unsaved>) {
    UNSAVED.lock().unwrap().insert(window.label().to_string(), files);
}

/// The files with edits not saved in the repository at `path`, or one in a folder in
/// it, as terminals are counted (see busy_programs_in), in any window, each described as
/// “name” in repository.
pub fn unsaved_under(path: &str) -> Vec<String> {
    let folder = crate::windows::same_folder(path);
    // Looked up with no lock held: see terminal::within.
    let unsaved: Vec<Unsaved> = UNSAVED.lock().unwrap().values().flatten().cloned().collect();
    unsaved.into_iter().filter(|f| crate::windows::same_folder(&f.path).starts_with(&folder)).map(|f| f.described).collect()
}

/// Forgets the edits of a window that's closed.
pub fn forget(window: &str) {
    UNSAVED.lock().unwrap().remove(window);
}

/// Closes the window, or with `quitting`, quits, after all, losing what was held.
#[tauri::command]
pub fn quit_confirmed(app: AppHandle, window: WebviewWindow, quitting: bool) {
    if quitting {
        CONFIRMED.store(true, Ordering::Relaxed);
        app.exit(0);
    } else {
        crate::reopen::closing(&app, window.label());
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_not_saved_in_a_repository_or_one_in_a_folder_of_it_are_found_in_any_window() {
        let unsaved = |path: &str, described: &str| Unsaved { path: path.into(), described: described.into() };
        UNSAVED.lock().unwrap().insert("test-unsaved-1".into(), vec![unsaved("/code/palace-unsaved", "“a.rs” in palace")]);
        UNSAVED.lock().unwrap().insert("test-unsaved-2".into(), vec![unsaved("/code/palace-unsaved/inner", "“b.rs” in inner"), unsaved("/code/other-unsaved", "“c.rs” in other")]);
        let mut found = unsaved_under("/code/palace-unsaved");
        found.sort();
        assert_eq!(found, ["“a.rs” in palace", "“b.rs” in inner"]);
        // A folder that only starts the same way isn't one in it.
        assert!(unsaved_under("/code/palace").is_empty());
        forget("test-unsaved-1");
        forget("test-unsaved-2");
    }
}
