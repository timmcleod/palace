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

/// What each new window's agent is to start on, by window, as for a worktree made for a
/// task (New Agent Task), until the window's page takes it as it starts.
static TASKS: std::sync::LazyLock<Mutex<HashMap<String, String>>> = std::sync::LazyLock::new(Default::default);

/// How far each new window sits from the one it was opened from, so it doesn't hide it.
const CASCADE: f64 = 28.0;

#[derive(Serialize)]
pub struct Start {
    /// The repository this window had open, as when its page reloads.
    repo: Option<String>,
    /// Whether it's the first window, which reopens the last repository at startup.
    first: bool,
    /// What its agent is to start on, the first time only: not again as its page reloads.
    task: Option<String>,
}

/// What a window's page opens as it starts.
#[tauri::command]
pub fn window_start(window: WebviewWindow, windows: State<'_, Windows>) -> Start {
    Start {
        repo: windows.0.lock().unwrap().get(window.label()).cloned(),
        first: window.label() == "main",
        task: TASKS.lock().unwrap().remove(window.label()),
    }
}

// --- Agents' states ---------------------------------------------------------------------
// What each repository's agents are doing, as each window's terminals say (see
// repositoryStates in terminals.js), kept by window and sent to every window as they
// change, so each window's Worktrees can show which worktree's agent is working, needs
// you, or finished while you were elsewhere. The page puts them together
// (agentStates.js), so which state is most pressing is said in one place.

/// Each window's agents' states, by repository.
type AgentStates = HashMap<String, HashMap<String, String>>;
static AGENT_STATES: std::sync::LazyLock<Mutex<AgentStates>> = std::sync::LazyLock::new(Default::default);

fn send_agent_states(app: &AppHandle) {
    let by_window = AGENT_STATES.lock().unwrap().clone();
    let _ = app.emit("agent-states", by_window);
}

/// The window's agents' states, by repository, as they change: every window's are sent
/// to all of them ("agent-states").
#[tauri::command]
pub fn set_agent_states(app: AppHandle, window: WebviewWindow, states: HashMap<String, String>) {
    AGENT_STATES.lock().unwrap().insert(window.label().to_string(), states);
    send_agent_states(&app);
}

/// Forgets the window's agents, as when it closes, or its page reloads and its terminals
/// are hung up: their states go with them, from every window's Worktrees.
pub fn forget_agent_states(app: &AppHandle, window: &str) {
    if AGENT_STATES.lock().unwrap().remove(window).is_some() {
        send_agent_states(app);
    }
}

/// Every window's agents' states, by window and repository, for a window that's just
/// started.
#[tauri::command]
pub fn agent_states() -> AgentStates {
    AGENT_STATES.lock().unwrap().clone()
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

/// Another window with the folder at `path` open, as a worktree about to be removed,
/// and what closing it would lose.
#[derive(Serialize)]
pub struct Showing {
    /// The windows, by label, for remove_worktree to close.
    windows: Vec<String>,
    /// The programs running in its terminals, by name, or None for one it can't tell.
    programs: Vec<Option<String>>,
    /// Its files with edits not saved.
    edits: Vec<String>,
}

/// The labels of the windows other than `window` with the folder at `path` open.
fn others_showing(windows: &Windows, window: &WebviewWindow, path: &str) -> Vec<String> {
    let path = same_folder(path);
    windows.0.lock().unwrap().iter().filter(|(label, open)| *label != window.label() && same_folder(open) == path).map(|(label, _)| label.clone()).collect()
}

/// A folder as its real path, through any symbolic links, so the same folder compares
/// equal however it was reached; or once it's gone, as given, without a trailing slash.
fn same_folder(path: &str) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| std::path::Path::new(path).components().collect())
}

/// Whether another window has the folder at `path` open, and if so, what closing it
/// would lose.
#[tauri::command]
pub fn window_showing(window: WebviewWindow, windows: State<'_, Windows>, path: String) -> Option<Showing> {
    let labels = others_showing(&windows, &window, &path);
    if labels.is_empty() {
        return None;
    }
    Some(Showing {
        windows: labels.clone(),
        programs: labels.iter().flat_map(|label| crate::terminal::busy_programs(label)).collect(),
        edits: labels.iter().flat_map(|label| crate::quit::unsaved_in(label)).collect(),
    })
}

/// Closes the windows labeled `labels`, other than `window`, without asking: the user
/// has been asked already, as about removing the worktree they show (see
/// window_showing). Their terminals are hung up first, and what ran in them given a
/// few seconds to stop, so it's done before the folder it was in is deleted.
pub async fn close_windows(app: &AppHandle, window: &str, labels: Vec<String>) {
    let labels: Vec<String> = labels.into_iter().filter(|label| label != window).collect();
    let hung_up = labels.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        crate::terminal::close_windows_and_wait(&hung_up, std::time::Duration::from_secs(3));
    })
    .await;
    for label in &labels {
        if let Some(other) = app.get_webview_window(label) {
            let _ = other.destroy();
        }
    }
}

/// Whether the folder at `path` is still there, for a window whose repository can't be
/// read any more: it may have been removed, as a worktree, or moved.
#[tauri::command]
pub fn folder_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// Of `paths`, the recent repositories' folders, those that are gone: not found, though
/// the folder each was in is. One that can't be read, as when access to it was taken
/// away, isn't counted gone, nor one on a drive that isn't connected (a drive's own
/// folder in /Volumes, or one whose folder above it is missing too), so it's there
/// again when the drive is.
#[tauri::command]
pub async fn folders_gone(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || paths.into_iter().filter(|p| gone(std::path::Path::new(p))).collect())
        .await
        .unwrap_or_default()
}

fn gone(path: &std::path::Path) -> bool {
    let not_found = matches!(std::fs::metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    let above = path.parent().filter(|above| *above != std::path::Path::new("/Volumes"));
    not_found && above.is_some_and(|above| above.is_dir())
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

/// Opens a new window, a little below and to the right of `window`, with the repository
/// at `path` open, as for a worktree, or with none open yet. `dark` is the theme Palace
/// is showing, which the window takes from the start: otherwise it shows white until
/// its page has loaded and turned it dark.
#[tauri::command]
pub async fn new_window(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, Windows>,
    dark: bool,
    path: Option<String>,
    task: Option<String>,
) -> Result<(), String> {
    let mut config = app.config().app.windows.first().cloned().ok_or("Palace has no window settings.")?;
    config.label = format!("window-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    // What its page opens as it starts (see window_start).
    if let Some(path) = path {
        windows.0.lock().unwrap().insert(config.label.clone(), path);
    }
    if let Some(task) = task.filter(|t| !t.trim().is_empty()) {
        TASKS.lock().unwrap().insert(config.label.clone(), task);
    }
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
    TASKS.lock().unwrap().remove(window);
    forget_agent_states(app, window);
    crate::terminal::close_window(window);
    app.state::<crate::watch::RepoWatcher>().forget(window);
    app.state::<crate::history::HistoryState>().forget(window);
    app.state::<crate::cli::Runnings>().forget(window);
    crate::quit::forget(window);
    crate::notify::forget(window);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    #[test]
    fn telling_a_deleted_folder_from_one_on_a_drive_not_connected() {
        let t = TempRepo::new("folders-gone");
        let here = t.dir.to_string_lossy().into_owned();
        let deleted = t.dir.join("deleted").to_string_lossy().into_owned();
        let on_a_drive = t.dir.join("drive").join("project").to_string_lossy().into_owned();
        let a_drive = "/Volumes/Palace Test Drive Not Connected".to_string();
        let gone = tauri::async_runtime::block_on(folders_gone(vec![here, deleted.clone(), on_a_drive, a_drive]));
        assert_eq!(gone, [deleted]);
    }
}
