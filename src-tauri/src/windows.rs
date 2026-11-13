//! Palace's windows, side by side, each with repositories open in tabs of its own. As
//! Palace starts, it reopens the windows it had, with their tabs (see reopen.rs), or
//! with none noted, the first, "main", with the last repository; New Window opens
//! another, to choose one in. A repository is open in one tab at a time: opening it
//! again shows that tab, and its window.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Theme, WebviewWindow, WebviewWindowBuilder, Wry};

/// Each window's tabs, by window.
#[derive(Default)]
pub struct Windows(Mutex<HashMap<String, Tabs>>);

/// A window's tabs: the repositories open in them, in the order they're in, and which of
/// them is showing. A tab with none open yet, still to choose one, isn't among them.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
#[serde(default)]
pub struct Tabs {
    pub repos: Vec<String>,
    pub active: Option<usize>,
}

impl Tabs {
    /// One tab, with the repository at `path` open and showing, as a window noted before
    /// tabs had (see reopen.rs).
    pub fn one(path: String) -> Self {
        Tabs { repos: vec![path], active: Some(0) }
    }
}

static NEXT: AtomicU32 = AtomicU32::new(2);

/// How far each new window sits from the one it was opened from, so it doesn't hide it.
const CASCADE: f64 = 28.0;

#[derive(Serialize)]
pub struct Start {
    /// The tabs this window had, as when its page reloads, or is to open, as one
    /// reopened after Palace restarts itself.
    tabs: Tabs,
    /// Whether it's the first window, which reopens the last repository at startup.
    first: bool,
}

/// What a window's page opens as it starts.
#[tauri::command]
pub fn window_start(window: WebviewWindow, windows: State<'_, Windows>) -> Start {
    Start {
        tabs: windows.0.lock().unwrap().get(window.label()).cloned().unwrap_or_default(),
        first: window.label() == "main",
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

/// Notes the window's tabs, as they change: the repositories open in them, in order,
/// and which is showing.
#[tauri::command]
pub fn set_window_tabs(window: WebviewWindow, windows: State<'_, Windows>, tabs: Tabs) {
    windows.0.lock().unwrap().insert(window.label().to_string(), tabs);
}

/// Which repository a window is told to show, or to close the tab of.
#[derive(Serialize, Clone)]
struct Repository {
    path: String,
}

/// Brings forward the other window with the repository at `path` open in one of its
/// tabs, if there is one, telling it to show that tab ("show-repo"), and says whether
/// there was.
#[tauri::command]
pub fn show_window_with(app: AppHandle, window: WebviewWindow, windows: State<'_, Windows>, path: String) -> bool {
    let other = windows.0.lock().unwrap().iter().find(|(label, tabs)| *label != window.label() && tabs.repos.contains(&path)).map(|(label, _)| label.clone());
    let Some(other) = other.and_then(|label| app.get_webview_window(&label)) else { return false };
    let _ = other.unminimize();
    let _ = other.show();
    let _ = other.set_focus();
    let _ = app.emit_to(EventTarget::webview_window(other.label()), "show-repo", Repository { path });
    true
}

/// A folder open in a tab, as a worktree about to be removed, and what closing it would
/// lose.
#[derive(Serialize)]
pub struct Showing {
    /// The programs running in its terminals, by name, or None for one it can't tell.
    programs: Vec<Option<String>>,
    /// Its files with edits not saved.
    edits: Vec<String>,
}

/// The windows with the folder at `path` open in one of their tabs: each window's label,
/// and the folder as its tab has it, however that was reached.
fn windows_showing(windows: &Windows, path: &str) -> Vec<(String, String)> {
    let path = same_folder(path);
    // Looked up with no lock held: see terminal::within.
    let open: Vec<(String, Tabs)> = windows.0.lock().unwrap().iter().map(|(label, tabs)| (label.clone(), tabs.clone())).collect();
    open.into_iter()
        .flat_map(|(label, tabs)| tabs.repos.into_iter().map(move |repo| (label.clone(), repo)))
        .filter(|(_, repo)| same_folder(repo) == path)
        .collect()
}

/// A folder as its real path, through any symbolic links, so the same folder compares
/// equal however it was reached; or once it's gone, as given, without a trailing slash.
pub(crate) fn same_folder(path: &str) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| std::path::Path::new(path).components().collect())
}

/// Whether a tab, in any window, has the folder at `path` open, and if so, what closing
/// it would lose. Off the main thread, as looking up folders can take a while.
#[tauri::command]
pub async fn window_showing(app: AppHandle, path: String) -> Option<Showing> {
    tauri::async_runtime::spawn_blocking(move || {
        if windows_showing(&app.state::<Windows>(), &path).is_empty() {
            return None;
        }
        Some(Showing {
            programs: crate::terminal::busy_programs_in(&path),
            edits: crate::quit::unsaved_under(&path),
        })
    })
    .await
    .ok()
    .flatten()
}

/// Closes the tabs with the folder at `path` open, in every window, without asking: the
/// user has been asked already, as about removing the worktree they show (see
/// window_showing). Their terminals are hung up first, and what ran in them given a few
/// seconds to stop, so it's done before the folder they were in is deleted; then each
/// window's page is told to close its tab ("close-repo").
pub async fn close_tabs_with(app: &AppHandle, path: &str) {
    let labels = windows_showing(&app.state::<Windows>(), path);
    let folder = path.to_string();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        crate::terminal::close_in_and_wait(&folder, std::time::Duration::from_secs(3));
    })
    .await;
    // Told as its tab has it, which it finds the tab by.
    for (label, repo) in labels {
        let _ = app.emit_to(EventTarget::webview_window(&label), "close-repo", Repository { path: repo });
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

/// Opens a new window, a little below and to the right of `window`, with a tab to
/// choose a repository in. `dark` is the theme Palace is showing, which the window takes
/// from the start: otherwise it shows white until its page has loaded and turned it
/// dark.
#[tauri::command]
pub async fn new_window(app: AppHandle, window: WebviewWindow, windows: State<'_, Windows>, dark: bool) -> Result<(), String> {
    let (_, mut builder) = make(&app, &windows, Tabs::default(), dark)?;
    if let (Ok(position), Ok(scale)) = (window.outer_position(), window.scale_factor()) {
        let position = position.to_logical::<f64>(scale);
        builder = builder.position(position.x + CASCADE, position.y + CASCADE);
    }
    let opened = open(builder)?;
    show_themed(&opened, Some(if dark { Theme::Dark } else { Theme::Light }));
    Ok(())
}

/// A new window, to build: the first window's settings, a label of its own, returned
/// with it, and the tabs for its page to open (see window_start).
pub(crate) fn make<'a>(
    app: &'a AppHandle,
    windows: &Windows,
    tabs: Tabs,
    dark: bool,
) -> Result<(String, WebviewWindowBuilder<'a, Wry, AppHandle>), String> {
    let mut config = app.config().app.windows.first().cloned().ok_or("Palace has no window settings.")?;
    config.label = format!("window-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let theme = if dark { Theme::Dark } else { Theme::Light };
    let builder = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| format!("Couldn't open a window: {e}"))?
        .theme(Some(theme))
        .background_color(background(dark));
    // Only now there's to be a window, its tabs are its.
    start_with(windows, &config.label, tabs);
    Ok((config.label, builder))
}

/// Builds a window made with `make`, hidden until it's shown (see show_themed).
pub(crate) fn open(builder: WebviewWindowBuilder<'_, Wry, AppHandle>) -> Result<WebviewWindow, String> {
    let opened = builder.build().map_err(|e| format!("Couldn't open a window: {e}"))?;
    #[cfg(target_os = "linux")]
    crate::no_pinch_zoom(&opened);
    Ok(opened)
}

/// The tabs of the window labeled `window`.
pub(crate) fn tabs_in(app: &AppHandle, window: &str) -> Tabs {
    app.state::<Windows>().0.lock().unwrap().get(window).cloned().unwrap_or_default()
}

/// Has the window labeled `window` open `tabs` as its page starts (see window_start),
/// as one does with those it had before Palace restarted (see reopen.rs), or a new one
/// with none. Its page notes them again as they open, leaving out any it couldn't,
/// so none stands for a repository that isn't showing.
pub(crate) fn start_with(windows: &Windows, window: &str, tabs: Tabs) {
    windows.0.lock().unwrap().insert(window.to_string(), tabs);
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
pub(crate) fn show_themed(window: &WebviewWindow, theme: Option<Theme>) {
    let _ = window.set_theme(theme);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Shows the first window, which opens with Palace, in the theme its settings choose,
/// so it isn't light until its page has loaded them and turned it dark. Returns that
/// theme, None for the system's, and whether it's dark, for other windows opening now.
pub(crate) fn show_first(window: &WebviewWindow) -> (Option<Theme>, bool) {
    let (theme, dark) = saved_theme(window.app_handle(), window);
    let _ = window.set_background_color(Some(background(dark)));
    show_themed(window, theme);
    (theme, dark)
}

/// The theme Palace's settings choose, or None for the system's, and whether it's dark,
/// as the system's is for `window`.
fn saved_theme(app: &AppHandle, window: &WebviewWindow) -> (Option<Theme>, bool) {
    let theme = match crate::store::saved_theme(app).as_deref() {
        Some("dark") => Some(Theme::Dark),
        Some("light") => Some(Theme::Light),
        _ => None,
    };
    let dark = theme.unwrap_or_else(|| window.theme().unwrap_or(Theme::Light)) == Theme::Dark;
    (theme, dark)
}

/// The window is done with the repository at `path`, as on switching to another: its
/// watcher stops and its history goes. Network work under way in it goes on to the end,
/// as a push does on switching away, and its terminals go on running.
#[tauri::command]
pub fn release_repo(app: AppHandle, window: WebviewWindow, path: String) {
    app.state::<crate::watch::RepoWatcher>().release(window.label(), &path);
    app.state::<crate::history::HistoryState>().release(window.label(), &path);
}

/// Lets go of everything a closed window had: its terminals, the watch on its
/// repository, its history and network work, its edits, and its notifications.
pub fn forget(app: &AppHandle, window: &str) {
    app.state::<Windows>().0.lock().unwrap().remove(window);
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
    fn a_folder_open_in_any_tab_of_a_window_is_found_however_its_reached() {
        let t = TempRepo::new("windows-showing");
        let folder = t.dir.to_string_lossy().into_owned();
        let link = t.dir.with_extension("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&t.dir, &link).unwrap();
        let windows = Windows::default();
        start_with(&windows, "main", Tabs { repos: vec!["/code/other".into(), folder.clone()], active: Some(0) });
        start_with(&windows, "window-2", Tabs::one("/code/else".into()));
        // Each window's told the folder as its tab has it.
        let showing = [("main".to_string(), folder.clone())];
        assert_eq!(windows_showing(&windows, &link.to_string_lossy()), showing);
        assert_eq!(windows_showing(&windows, &format!("{folder}/")), showing);
        assert!(windows_showing(&windows, "/code/nowhere").is_empty());
        std::fs::remove_file(&link).unwrap();
    }

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
