//! Palace's windows, each with a repository of its own, side by side. The first, "main",
//! reopens the last repository at startup; New Window opens another, to choose one in.
//! A repository is open in one window at a time: opening it again shows that window.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow, WebviewWindowBuilder};

/// The repository open in each window, by window.
#[derive(Default)]
pub struct Windows(Mutex<HashMap<String, String>>);

static NEXT: AtomicU32 = AtomicU32::new(2);

/// How far each new window sits from the one it was opened from, so it doesn't hide it.
const CASCADE: f64 = 28.0;

#[derive(Serialize)]
pub struct Start {
    /// The repository this window had open, as when its page reloads.
    repo: Option<String>,
    /// Whether it's the first window, which reopens the last repository at startup.
    first: bool,
}

/// What a window's page opens as it starts.
#[tauri::command]
pub fn window_start(window: WebviewWindow, windows: State<'_, Windows>) -> Start {
    Start { repo: windows.0.lock().unwrap().get(window.label()).cloned(), first: window.label() == "main" }
}

/// Notes the repository the window has open, or None for none.
#[tauri::command]
pub fn set_window_repo(window: WebviewWindow, windows: State<'_, Windows>, path: Option<String>) {
    let mut open = windows.0.lock().unwrap();
    match path {
        Some(path) => open.insert(window.label().to_string(), path),
        None => open.remove(window.label()),
    };
}

/// Brings forward the other window with the repository at `path` open, if there is one,
/// and says whether there was.
#[tauri::command]
pub fn show_window_with(app: AppHandle, window: WebviewWindow, windows: State<'_, Windows>, path: String) -> bool {
    let other = windows.0.lock().unwrap().iter().find(|(label, open)| *label != window.label() && **open == path).map(|(label, _)| label.clone());
    let Some(other) = other.and_then(|label| app.get_webview_window(&label)) else { return false };
    let _ = other.unminimize();
    let _ = other.show();
    let _ = other.set_focus();
    true
}

/// Opens a new window, a little below and to the right of `window`, with no repository
/// open yet.
#[tauri::command]
pub async fn new_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let mut config = app.config().app.windows.first().cloned().ok_or("Palace has no window settings.")?;
    config.label = format!("window-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let mut builder = WebviewWindowBuilder::from_config(&app, &config).map_err(|e| format!("Couldn't open a window: {e}"))?;
    if let (Ok(position), Ok(scale)) = (window.outer_position(), window.scale_factor()) {
        let position = position.to_logical::<f64>(scale);
        builder = builder.position(position.x + CASCADE, position.y + CASCADE);
    }
    let opened = builder.build().map_err(|e| format!("Couldn't open a window: {e}"))?;
    #[cfg(target_os = "linux")]
    crate::no_pinch_zoom(&opened);
    let _ = opened.set_focus();
    Ok(())
}

/// Lets go of everything a closed window had: its terminals, the watch on its
/// repository, its history and network work, and its edits.
pub fn forget(app: &AppHandle, window: &str) {
    app.state::<Windows>().0.lock().unwrap().remove(window);
    crate::terminal::close_window(window);
    app.state::<crate::watch::RepoWatcher>().forget(window);
    app.state::<crate::history::HistoryState>().forget(window);
    app.state::<crate::cli::Runnings>().forget(window);
    crate::quit::forget(window);
}
