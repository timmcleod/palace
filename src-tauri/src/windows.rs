//! Palace's windows, each with a repository of its own, side by side. The first, "main",
//! reopens the last repository at startup; New Window opens another, to choose one in.
//! A repository is open in one window at a time: opening it again shows that window.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Theme, WebviewWindow, WebviewWindowBuilder};

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

/// Shows `notice`, that a terminal in `window` finished or needs the user, in the Palace
/// window the user is in, which may be `window` itself, and says whether there was one.
/// There isn't when another app is in front: then the system's notification says it.
#[tauri::command]
pub fn show_notice(app: AppHandle, window: WebviewWindow, notice: serde_json::Value) -> bool {
    let focused = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
    let Some(focused) = focused else { return false };
    let notice = Notice { window: window.label().to_string(), notice };
    app.emit_to(EventTarget::webview_window(focused.label()), "notice", notice).is_ok()
}

#[derive(Serialize, Clone)]
struct Notice {
    /// The window whose terminal it's about.
    window: String,
    #[serde(flatten)]
    notice: serde_json::Value,
}

/// Brings the window labeled `label` forward and has it show the terminal tab `key`
/// of the repository at `path`, as when its notice is clicked in another window.
#[tauri::command]
pub fn show_terminal_tab(app: AppHandle, label: String, path: String, key: u32) -> bool {
    let Some(window) = app.get_webview_window(&label) else { return false };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    app.emit_to(EventTarget::webview_window(&label), "show-terminal-tab", TerminalTab { path, key }).is_ok()
}

#[derive(Serialize, Clone)]
pub(crate) struct TerminalTab {
    pub path: String,
    pub key: u32,
}

/// Opens a new window, a little below and to the right of `window`, with no repository
/// open yet. `dark` is the theme Palace is showing, which the window takes from the
/// start: otherwise it shows white until its page has loaded and turned it dark.
#[tauri::command]
pub async fn new_window(app: AppHandle, window: WebviewWindow, dark: bool) -> Result<(), String> {
    let mut config = app.config().app.windows.first().cloned().ok_or("Palace has no window settings.")?;
    config.label = format!("window-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let mut builder = WebviewWindowBuilder::from_config(&app, &config).map_err(|e| format!("Couldn't open a window: {e}"))?;
    if let (Ok(position), Ok(scale)) = (window.outer_position(), window.scale_factor()) {
        let position = position.to_logical::<f64>(scale);
        builder = builder.position(position.x + CASCADE, position.y + CASCADE);
    }
    let theme = if dark { Theme::Dark } else { Theme::Light };
    builder = builder.theme(Some(theme)).background_color(background(dark));
    let opened = builder.build().map_err(|e| format!("Couldn't open a window: {e}"))?;
    #[cfg(target_os = "linux")]
    crate::no_pinch_zoom(&opened);
    show_themed(&opened, Some(theme));
    Ok(())
}

/// The sidebar's color in each theme (--sidebar-bg in styles.css), the page's
/// background, for a window to show until its page is drawn.
fn background(dark: bool) -> Color {
    if dark {
        Color(0x21, 0x2a, 0x3a, 0xff)
    } else {
        Color(0xf4, 0xf4, 0xf4, 0xff)
    }
}

/// Shows a window, made hidden (see tauri.conf.json), in `theme`, or the system's for
/// None. On Linux a window's theme is the system's as it's made, whatever it was asked
/// to be, and that's every window's title bar, so it's set again before it's shown.
fn show_themed(window: &WebviewWindow, theme: Option<Theme>) {
    let _ = window.set_theme(theme);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Shows the first window, which opens with Palace, in the theme its settings choose,
/// so it isn't light until its page has loaded them and turned it dark.
pub fn show_first(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let theme = match crate::store::saved_theme(app).as_deref() {
        Some("dark") => Some(Theme::Dark),
        Some("light") => Some(Theme::Light),
        _ => None,
    };
    let dark = theme.unwrap_or_else(|| window.theme().unwrap_or(Theme::Light)) == Theme::Dark;
    let _ = window.set_background_color(Some(background(dark)));
    show_themed(&window, theme);
}

/// Lets go of everything a closed window had: its terminals, the watch on its
/// repository, its history and network work, its edits, and its notifications.
pub fn forget(app: &AppHandle, window: &str) {
    app.state::<Windows>().0.lock().unwrap().remove(window);
    crate::terminal::close_window(window);
    app.state::<crate::watch::RepoWatcher>().forget(window);
    app.state::<crate::history::HistoryState>().forget(window);
    app.state::<crate::cli::Runnings>().forget(window);
    crate::quit::forget(window);
    crate::notify::forget(window);
}
