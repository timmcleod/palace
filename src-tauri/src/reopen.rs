//! Palace's windows, reopened as they were when Palace next starts: each with the tabs
//! it had, where it was on the screen and how big. They're noted as Palace quits, or its
//! last windows close, and just before it restarts itself, as into an update (see
//! restart_after_update); the next start takes the note once, however long after. Without
//! one, as after a crash, Palace opens its first window, with the last repository opened.
//!
//! On Linux under Wayland the desktop places windows itself, and doesn't say where
//! they are, so there they reopen with their tabs and sizes, where it puts them.

use crate::store::seconds_now;
use crate::windows::{make, open, show_first, show_themed, start_with, Tabs, Windows};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

// Development builds keep their own, as they do their saved data (see store.rs).
const FILE: &str = if cfg!(debug_assertions) { "reopen-dev.json" } else { "reopen.json" };

/// Why the windows are noted.
#[derive(Clone, Copy, PartialEq)]
pub enum Why {
    /// Palace is restarting itself, as into an update.
    Restart,
    /// Palace is quitting, or its last window closing.
    Quit,
}

/// Set once a restart has been noted, so the quitting that follows doesn't note again,
/// as its windows close.
static RESTARTING: AtomicBool = AtomicBool::new(false);

/// The windows about to close, by label, their closing not held: once every window
/// open is, Palace is about to quit with them, and they're noted. Several can close at
/// once, as with Close All, each before the others have gone.
static CLOSING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The note: when it was written, and the windows. Written by one version and read by
/// the next, so what a field's missing from reads as its default, rather than the whole
/// note being thrown away when a version adds one.
#[derive(Serialize, Deserialize, Debug, Default, PartialEq)]
#[serde(default)]
struct Note {
    written: u64,
    windows: Vec<Placed>,
}

/// A corner, or a size, in logical pixels.
type Pair = (f64, f64);

/// A window as it was, in logical pixels: its outer corner and its inner size, where
/// they could be read.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
#[serde(default)]
struct Placed {
    tabs: Tabs,
    /// The window's one repository, as a version before tabs noted it, read as its one
    /// tab (see take).
    #[serde(skip_serializing)]
    repo: Option<String>,
    corner: Option<Pair>,
    size: Option<Pair>,
    maximized: bool,
    focused: bool,
    /// Palace's first window, which goes there again when it can.
    first: bool,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(FILE))
}

/// Notes the windows open now, for Palace to reopen as it next starts. Best effort: if
/// the note can't be written, Palace still goes ahead, and next opens its first window
/// only. With none open, as once the last has closed, the note there is kept.
pub fn remember(app: &AppHandle, why: Why) {
    if why == Why::Quit && RESTARTING.load(Ordering::Relaxed) {
        return;
    }
    if why == Why::Restart {
        RESTARTING.store(true, Ordering::Relaxed);
    }
    let Some(path) = file(app) else { return };
    let windows: Vec<Placed> = app.webview_windows().iter().map(|(label, window)| placed(app, label, window)).collect();
    if windows.is_empty() {
        return;
    }
    let note = Note { written: seconds_now(), windows };
    if let (Some(dir), Ok(json)) = (path.parent(), serde_json::to_vec(&note)) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(&path, json);
    }
}

/// The window labeled `window` is about to close, nothing holding it: once every window
/// open is, they're noted, as Palace quits with the last.
pub fn closing(app: &AppHandle, window: &str) {
    let all_closing = {
        let mut closing = CLOSING.lock().unwrap();
        if !closing.iter().any(|w| w == window) {
            closing.push(window.to_string());
        }
        app.webview_windows().keys().all(|label| closing.contains(label))
    };
    if all_closing {
        remember(app, Why::Quit);
    }
}

/// The window labeled `window` has closed.
pub fn closed(window: &str) {
    CLOSING.lock().unwrap().retain(|w| w != window);
}

fn placed(app: &AppHandle, label: &str, window: &WebviewWindow) -> Placed {
    let scale = window.scale_factor().unwrap_or(1.0);
    Placed {
        tabs: crate::windows::tabs_in(app, label),
        repo: None,
        corner: window.outer_position().ok().map(|p| p.to_logical::<f64>(scale)).map(|p| (p.x, p.y)),
        size: size_of(window, scale),
        maximized: window.is_maximized().unwrap_or(false),
        focused: window.is_focused().unwrap_or(false),
        first: label == "main",
    }
}

/// The window's size, as it's set again (see show_windows). On Linux, GTK's own, as it
/// takes a size: the one the windowing library reports there takes in the shadow and
/// title bar GTK draws around the window, and given that, a window grew by them, 52 by
/// 89 pixels, each time it reopened. GTK's is in logical pixels already.
fn size_of(window: &WebviewWindow, scale: f64) -> Option<Pair> {
    #[cfg(target_os = "linux")]
    if let Ok(gtk_window) = window.gtk_window() {
        use gtk::prelude::GtkWindowExt;
        let (width, height) = gtk_window.size();
        return Some((f64::from(width), f64::from(height)));
    }
    window.inner_size().ok().map(|s| s.to_logical::<f64>(scale)).map(|s| (s.width, s.height))
}

/// The windows noted, taken once: the note goes as it's read, so only the next start
/// reopens them. However old it is: screens that have changed since are allowed for
/// (see fit).
fn take(path: &Path) -> Vec<Placed> {
    let read = std::fs::read(path);
    let _ = std::fs::remove_file(path);
    let note: Note = read.ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    note.windows
        .into_iter()
        .map(|mut window| {
            if let Some(repo) = window.repo.take().filter(|_| window.tabs.repos.is_empty()) {
                window.tabs = Tabs::one(repo);
            }
            window
        })
        .collect()
}

/// The windows to open, in order, the first in Palace's first window.
///
/// - A repository is open in one tab at a time, so one noted again, after the first
///   time, is left out: both would find it open in the other, and show nothing. A
///   window whose tabs were all left out that way isn't opened.
/// - One whose folder is gone (`exists` says) is left out too, rather than being kept
///   as showing it, which would bring it forward whenever it's opened. A window whose
///   tabs were all gone opens with none, to choose one in.
/// - The tab that was showing shows again, or with it left out, the first.
/// - The first window goes first, given a repository, as it was; otherwise any with
///   one, as the first window opens the last repository used when given none (see
///   App.vue), which could be open in another already.
fn in_order(windows: Vec<Placed>, exists: impl Fn(&str) -> bool) -> Vec<Placed> {
    let mut seen = HashSet::new();
    let mut windows: Vec<Placed> = windows
        .into_iter()
        .filter_map(|mut window| {
            let had = window.tabs.repos.len();
            let showing = window.tabs.active.and_then(|at| window.tabs.repos.get(at)).cloned();
            let mut again = 0;
            window.tabs.repos.retain(|repo| {
                let first_time = seen.insert(repo.clone());
                again += usize::from(!first_time);
                first_time && exists(repo)
            });
            if had > 0 && again == had {
                return None;
            }
            let repos = &window.tabs.repos;
            window.tabs.active = showing.and_then(|repo| repos.iter().position(|r| *r == repo)).or((!repos.is_empty()).then_some(0));
            Some(window)
        })
        .collect();
    let first = windows
        .iter()
        .position(|w| w.first && !w.tabs.repos.is_empty())
        .or_else(|| windows.iter().position(|w| !w.tabs.repos.is_empty()))
        .or_else(|| windows.iter().position(|w| w.first));
    if let Some(at) = first {
        let window = windows.remove(at);
        windows.insert(0, window);
    }
    windows
}

/// A screen's area in logical pixels: its corner, then its width and height.
type Screen = (f64, f64, f64, f64);

fn screens(app: &AppHandle) -> Vec<Screen> {
    let monitors = app.available_monitors().unwrap_or_default();
    monitors
        .iter()
        .map(|m| {
            let at = m.position().to_logical::<f64>(m.scale_factor());
            let size = m.size().to_logical::<f64>(m.scale_factor());
            (at.x, at.y, size.width, size.height)
        })
        .collect()
}

/// Where to put a window again, and how big, on the screens there are now, which may
/// have changed since: its corner only while that's on one of them, as a window put off
/// all of them couldn't be found, and its size no bigger than the screen it's on, or
/// the largest when it's on none. A window maximized is given only its corner, for the
/// screen it fills: its size is the screen's, and given that, it would stay as big
/// once it's made smaller.
fn fit(placed: &Placed, screens: &[Screen]) -> (Option<Pair>, Option<Pair>) {
    // A little way in from the corner: the title bar, which has to show to be moved.
    let on = placed.corner.and_then(|(x, y)| {
        let (x_in, y_in) = (x + 40.0, y + 10.0);
        screens.iter().find(|(sx, sy, w, h)| (*sx..sx + w).contains(&x_in) && (*sy..sy + h).contains(&y_in))
    });
    let largest = screens.iter().max_by(|a, b| (a.2 * a.3).total_cmp(&(b.2 * b.3)));
    let size = placed.size.filter(|_| !placed.maximized).map(|(width, height)| match on.or(largest) {
        Some((_, _, w, h)) => (width.min(*w), height.min(*h)),
        None => (width, height),
    });
    (on.and(placed.corner), size)
}

/// Shows Palace's windows as it starts: the first, and after a restart, the others it
/// had, each where it was (see fit), the one in front last in front again, where the
/// desktop allows it: GNOME under Wayland doesn't let a window be brought forward this
/// way, and keeps another in front.
pub fn show_windows(app: &AppHandle) {
    let exists = |path: &str| Path::new(path).is_dir();
    let noted = file(app).map(|path| in_order(take(&path), exists)).unwrap_or_default();
    let Some(main) = app.get_webview_window("main") else { return };
    let screens = if noted.is_empty() { Vec::new() } else { screens(app) };
    let windows = app.state::<Windows>();
    let mut front = None;
    if let Some(first) = noted.first() {
        start_with(&windows, "main", first.tabs.clone());
        let (corner, size) = fit(first, &screens);
        if let Some((width, height)) = size {
            let _ = main.set_size(LogicalSize::new(width, height));
        }
        if let Some((x, y)) = corner {
            let _ = main.set_position(LogicalPosition::new(x, y));
        }
        if first.maximized {
            let _ = main.maximize();
        }
        front = first.focused.then(|| main.clone());
    }
    let (theme, dark) = show_first(&main);

    for placed in noted.iter().skip(1) {
        // One that can't be made is left out, the others still reopening.
        let Ok((label, mut builder)) = make(app, &windows, placed.tabs.clone(), dark) else { continue };
        let (corner, size) = fit(placed, &screens);
        if let Some((width, height)) = size {
            builder = builder.inner_size(width, height);
        }
        if let Some((x, y)) = corner {
            builder = builder.position(x, y);
        }
        // One that couldn't be built has no tabs, as another window looking for its
        // repositories would otherwise find them there.
        let Ok(window) = open(builder.maximized(placed.maximized)) else {
            start_with(&windows, &label, Tabs::default());
            continue;
        };
        show_themed(&window, theme);
        if placed.focused {
            front = Some(window);
        }
    }
    if let Some(window) = front {
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A window with tabs open on `repos`, the first showing.
    fn window(repos: &[&str]) -> Placed {
        let tabs = Tabs { repos: repos.iter().map(|r| r.to_string()).collect(), active: (!repos.is_empty()).then_some(0) };
        Placed { tabs, corner: Some((10.0, 20.0)), size: Some((1200.0, 800.0)), ..Default::default() }
    }

    fn note_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("palace-reopen-{name}-{}.json", std::process::id()))
    }

    fn repos(windows: &[Placed]) -> Vec<Vec<&str>> {
        windows.iter().map(|w| w.tabs.repos.iter().map(String::as_str).collect()).collect()
    }

    #[test]
    fn the_note_is_taken_once() {
        let path = note_file("once");
        let windows = vec![window(&["/code/palace"]), window(&[])];
        std::fs::write(&path, serde_json::to_vec(&Note { written: 1000, windows: windows.clone() }).unwrap()).unwrap();
        assert_eq!(take(&path), windows);
        assert!(!path.exists());
        assert_eq!(take(&path), vec![]);
    }

    #[test]
    fn a_note_reopens_whenever_palace_next_starts() {
        let path = note_file("old");
        let windows = vec![window(&["/code/a", "/code/b"])];
        std::fs::write(&path, serde_json::to_vec(&Note { written: 1000, windows: windows.clone() }).unwrap()).unwrap();
        assert_eq!(take(&path), windows);
        assert!(!path.exists());
    }

    #[test]
    fn a_note_that_cant_be_read_reopens_nothing() {
        let path = note_file("bad");
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(take(&path), vec![]);
        assert!(!path.exists());
    }

    // As an older version may have written it, or a newer one, with fields this one
    // doesn't know.
    #[test]
    fn a_note_from_another_version_reads_what_it_has() {
        let path = note_file("version");
        std::fs::write(&path, r#"{"written": 1000, "windows": [{"repo": "/code/a", "spaces": 3}], "more": true}"#).unwrap();
        // Before tabs, a window's one repository: its one tab now.
        assert_eq!(take(&path), vec![Placed { tabs: Tabs::one("/code/a".into()), ..Default::default() }]);
    }

    #[test]
    fn a_windows_tabs_are_noted_in_order_with_the_one_showing() {
        let path = note_file("tabs");
        let tabs = Tabs { repos: vec!["/code/a".into(), "/code/b".into()], active: Some(1) };
        let windows = vec![Placed { tabs, first: true, ..Default::default() }];
        std::fs::write(&path, serde_json::to_vec(&Note { written: 1000, windows: windows.clone() }).unwrap()).unwrap();
        assert_eq!(take(&path), windows);
    }

    #[test]
    fn the_first_window_goes_first_given_a_repository() {
        let first = Placed { first: true, ..window(&["/code/b"]) };
        let ordered = in_order(vec![window(&["/code/a"]), first.clone(), window(&[])], |_| true);
        assert_eq!(repos(&ordered), [vec!["/code/b"], vec!["/code/a"], vec![]]);
        assert!(ordered[0].first);
    }

    #[test]
    fn otherwise_any_window_with_a_repository_goes_first() {
        let first = Placed { first: true, ..window(&[]) };
        let ordered = in_order(vec![first, window(&[]), window(&["/code/a"])], |_| true);
        assert_eq!(repos(&ordered), [vec!["/code/a"], vec![], vec![]]);
    }

    #[test]
    fn a_repository_noted_twice_opens_once() {
        let ordered = in_order(vec![window(&["/code/a"]), window(&["/code/b", "/code/a", "/code/c"]), window(&["/code/a"])], |_| true);
        assert_eq!(repos(&ordered), [vec!["/code/a"], vec!["/code/b", "/code/c"]]);
    }

    // A laptop's screen, and a larger one to its left, higher up.
    const SCREENS: [Screen; 2] = [(0.0, 0.0, 1440.0, 900.0), (-2560.0, -300.0, 2560.0, 1440.0)];

    #[test]
    fn a_window_goes_back_where_it_was_on_a_screen_there_still() {
        let on_laptop = Placed { corner: Some((100.0, 50.0)), size: Some((1200.0, 800.0)), ..Default::default() };
        assert_eq!(fit(&on_laptop, &SCREENS), (Some((100.0, 50.0)), Some((1200.0, 800.0))));
        let on_left = Placed { corner: Some((-2000.0, -200.0)), size: Some((1800.0, 1200.0)), ..Default::default() };
        assert_eq!(fit(&on_left, &SCREENS), (Some((-2000.0, -200.0)), Some((1800.0, 1200.0))));
    }

    #[test]
    fn a_window_off_every_screen_goes_where_the_system_puts_it_no_bigger_than_the_largest() {
        let gone = Placed { corner: Some((5000.0, 100.0)), size: Some((3000.0, 1000.0)), ..Default::default() };
        assert_eq!(fit(&gone, &SCREENS), (None, Some((2560.0, 1000.0))));
        // Its title bar just past a screen's edge, so it couldn't be moved.
        let edge = Placed { corner: Some((1420.0, 50.0)), ..Default::default() };
        assert_eq!(fit(&edge, &SCREENS), (None, None));
    }

    #[test]
    fn a_window_is_no_bigger_than_the_screen_its_on() {
        let big = Placed { corner: Some((0.0, 0.0)), size: Some((2000.0, 1200.0)), ..Default::default() };
        assert_eq!(fit(&big, &SCREENS), (Some((0.0, 0.0)), Some((1440.0, 900.0))));
    }

    #[test]
    fn a_maximized_window_gets_only_its_corner_and_with_no_screens_known_its_size() {
        let maximized = Placed { corner: Some((0.0, 0.0)), size: Some((1440.0, 900.0)), maximized: true, ..Default::default() };
        assert_eq!(fit(&maximized, &SCREENS), (Some((0.0, 0.0)), None));
        let unknown = Placed { corner: Some((10.0, 10.0)), size: Some((1200.0, 800.0)), ..Default::default() };
        assert_eq!(fit(&unknown, &[]), (None, Some((1200.0, 800.0))));
    }

    #[test]
    fn a_window_whose_repository_is_gone_opens_with_none() {
        let ordered = in_order(vec![window(&["/code/gone"]), window(&["/code/a"])], |path| path != "/code/gone");
        assert_eq!(repos(&ordered), [vec!["/code/a"], vec![]]);
    }

    #[test]
    fn the_tab_showing_shows_again_or_with_it_gone_the_first() {
        let showing_b = |repos: &[&str]| Placed { tabs: Tabs { active: Some(1), ..window(repos).tabs }, ..window(repos) };
        let ordered = in_order(vec![showing_b(&["/code/a", "/code/b", "/code/c"])], |_| true);
        assert_eq!(ordered[0].tabs.active, Some(1));
        let ordered = in_order(vec![showing_b(&["/code/a", "/code/gone", "/code/c"])], |path| path != "/code/gone");
        assert_eq!((repos(&ordered), ordered[0].tabs.active), (vec![vec!["/code/a", "/code/c"]], Some(0)));
        let ordered = in_order(vec![showing_b(&["/code/a", "/code/b"])], |path| path == "/nothing");
        assert_eq!(ordered[0].tabs.active, None);
    }
}
