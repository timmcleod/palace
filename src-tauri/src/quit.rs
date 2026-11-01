//! Quitting, or closing the window, with work that quitting would lose: programs
//! running in terminals, or edits in the Files view that aren't saved. Palace asks
//! first, naming them, and quits only if told to.

use crate::terminal;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

/// Set once the user has said to quit anyway.
static CONFIRMED: AtomicBool = AtomicBool::new(false);
/// Whether the page has edits that aren't saved, as it last said.
static UNSAVED_EDITS: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
struct Held {
    /// The terminals with programs running in them.
    terminals: Vec<u32>,
    /// Whether there are edits that aren't saved; the page knows which.
    edits: bool,
}

/// Whether quitting should wait for the user, who's asked ("quit-requested") once it
/// would lose something. Quitting goes ahead with `quit_confirmed`.
pub fn hold(app: &AppHandle) -> bool {
    if CONFIRMED.load(Ordering::Relaxed) {
        return false;
    }
    let held = Held { terminals: terminal::busy_terminals(), edits: UNSAVED_EDITS.load(Ordering::Relaxed) };
    if held.terminals.is_empty() && !held.edits {
        return false;
    }
    let _ = app.emit("quit-requested", held);
    true
}

/// The page saying whether it has edits that aren't saved.
#[tauri::command]
pub fn set_unsaved_edits(unsaved: bool) {
    UNSAVED_EDITS.store(unsaved, Ordering::Relaxed);
}

/// Quits after all, losing what was held.
#[tauri::command]
pub fn quit_confirmed(app: AppHandle) {
    CONFIRMED.store(true, Ordering::Relaxed);
    app.exit(0);
}
