//! Palace's windows, reopened as they were when Palace restarts itself, as into an
//! update: each with the repository it had, where it was on the screen and how big.
//! They're noted just before the restart (see restart_after_update), and the new copy
//! takes the note once, as it starts. Otherwise Palace opens with its first window
//! only, as it always does.
//!
//! On Linux under Wayland the desktop places windows itself, and doesn't say where
//! they are, so there they reopen with their repositories and sizes, where it puts them.

use crate::store::seconds_now;
use crate::windows::{make, open, show_first, show_themed, start_with, Windows};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

// Development builds keep their own, as they do their saved data (see store.rs).
const FILE: &str = if cfg!(debug_assertions) { "reopen-dev.json" } else { "reopen.json" };

/// How long after it's written the note is good for. The restart takes seconds, or a
/// minute at most on Linux (see restart_after_update); a note older than that was left
/// by a restart that never finished, and is ignored rather than reopening windows, long
/// after, where screens may since have changed.
const FRESH_FOR: u64 = 120;

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
/// the note can't be written, the restart still goes ahead, into the first window only.
pub fn remember(app: &AppHandle) {
    let Some(path) = file(app) else { return };
    let windows = app.webview_windows().iter().map(|(label, window)| placed(app, label, window)).collect();
    let note = Note { written: seconds_now(), windows };
    if let (Some(dir), Ok(json)) = (path.parent(), serde_json::to_vec(&note)) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(&path, json);
    }
}

fn placed(app: &AppHandle, label: &str, window: &WebviewWindow) -> Placed {
    let scale = window.scale_factor().unwrap_or(1.0);
    Placed {
        repo: crate::windows::repository_in(app, label),
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

/// The windows noted, taken once: the note goes as it's read, so only the start right
/// after the restart reopens them, and only while it's fresh (see FRESH_FOR).
fn take(path: &Path, now: u64) -> Vec<Placed> {
    let read = std::fs::read(path);
    let _ = std::fs::remove_file(path);
    let note: Note = read.ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    if now.abs_diff(note.written) > FRESH_FOR {
        return Vec::new();
    }
    note.windows
}

/// The windows to open, in order, the first in Palace's first window.
///
/// - A repository is open in one window at a time, so a second window noted with one
///   already noted isn't opened: both would find it open in the other, and open nothing.
/// - One whose folder is gone (`exists` says) opens with none, to choose one in, rather
///   than being kept as showing it, which would bring it forward whenever it's opened.
/// - The first window goes first, given a repository, as it was; otherwise any with
///   one, as the first window opens the last repository used when given none (see
///   App.vue), which could be open in another already.
fn in_order(windows: Vec<Placed>, exists: impl Fn(&str) -> bool) -> Vec<Placed> {
    let mut seen = HashSet::new();
    let mut windows: Vec<Placed> = windows
        .into_iter()
        .filter_map(|mut window| {
            if let Some(repo) = window.repo.clone() {
                if !seen.insert(repo.clone()) {
                    return None;
                }
                if !exists(&repo) {
                    window.repo = None;
                }
            }
            Some(window)
        })
        .collect();
    let first = windows
        .iter()
        .position(|w| w.first && w.repo.is_some())
        .or_else(|| windows.iter().position(|w| w.repo.is_some()))
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
    let noted = file(app).map(|path| in_order(take(&path, seconds_now()), exists)).unwrap_or_default();
    let Some(main) = app.get_webview_window("main") else { return };
    let screens = if noted.is_empty() { Vec::new() } else { screens(app) };
    let windows = app.state::<Windows>();
    let mut front = None;
    if let Some(first) = noted.first() {
        if let Some(repo) = &first.repo {
            start_with(&windows, "main", repo.clone());
        }
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
        let Ok((_, mut builder)) = make(app, &windows, placed.repo.clone(), dark) else { continue };
        let (corner, size) = fit(placed, &screens);
        if let Some((width, height)) = size {
            builder = builder.inner_size(width, height);
        }
        if let Some((x, y)) = corner {
            builder = builder.position(x, y);
        }
        let Ok(window) = open(builder.maximized(placed.maximized)) else { continue };
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

    fn window(repo: Option<&str>) -> Placed {
        Placed { repo: repo.map(String::from), corner: Some((10.0, 20.0)), size: Some((1200.0, 800.0)), ..Default::default() }
    }

    fn note_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("palace-reopen-{name}-{}.json", std::process::id()))
    }

    fn repos(windows: &[Placed]) -> Vec<Option<&str>> {
        windows.iter().map(|w| w.repo.as_deref()).collect()
    }

    #[test]
    fn the_note_is_taken_once() {
        let path = note_file("once");
        let windows = vec![window(Some("/code/palace")), window(None)];
        std::fs::write(&path, serde_json::to_vec(&Note { written: 1000, windows: windows.clone() }).unwrap()).unwrap();
        assert_eq!(take(&path, 1005), windows);
        assert!(!path.exists());
        assert_eq!(take(&path, 1005), vec![]);
    }

    #[test]
    fn a_note_left_from_long_ago_reopens_nothing() {
        let path = note_file("stale");
        std::fs::write(&path, serde_json::to_vec(&Note { written: 1000, windows: vec![window(Some("/code/a"))] }).unwrap()).unwrap();
        assert_eq!(take(&path, 1000 + FRESH_FOR + 1), vec![]);
        assert!(!path.exists());
    }

    #[test]
    fn a_note_that_cant_be_read_reopens_nothing() {
        let path = note_file("bad");
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(take(&path, 0), vec![]);
        assert!(!path.exists());
    }

    // As an older version may have written it, or a newer one, with fields this one
    // doesn't know.
    #[test]
    fn a_note_from_another_version_reads_what_it_has() {
        let path = note_file("version");
        std::fs::write(&path, r#"{"written": 1000, "windows": [{"repo": "/code/a", "spaces": 3}], "more": true}"#).unwrap();
        assert_eq!(take(&path, 1000), vec![Placed { repo: Some("/code/a".into()), ..Default::default() }]);
    }

    #[test]
    fn the_first_window_goes_first_given_a_repository() {
        let first = Placed { first: true, ..window(Some("/code/b")) };
        let ordered = in_order(vec![window(Some("/code/a")), first.clone(), window(None)], |_| true);
        assert_eq!(repos(&ordered), [Some("/code/b"), Some("/code/a"), None]);
        assert!(ordered[0].first);
    }

    #[test]
    fn otherwise_any_window_with_a_repository_goes_first() {
        let first = Placed { first: true, ..window(None) };
        let ordered = in_order(vec![first, window(None), window(Some("/code/a"))], |_| true);
        assert_eq!(repos(&ordered), [Some("/code/a"), None, None]);
    }

    #[test]
    fn a_repository_noted_twice_opens_once() {
        let ordered = in_order(vec![window(Some("/code/a")), window(Some("/code/b")), window(Some("/code/a"))], |_| true);
        assert_eq!(repos(&ordered), [Some("/code/a"), Some("/code/b")]);
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
        let ordered = in_order(vec![window(Some("/code/gone")), window(Some("/code/a"))], |path| path != "/code/gone");
        assert_eq!(repos(&ordered), [Some("/code/a"), None]);
    }
}
