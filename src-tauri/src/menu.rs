//! The macOS menu bar: the system's usual menus, as Tauri's default has them, with
//! Palace's own where it differs.
//!
//! - The Palace menu's About Palace and Check for Updates… open Palace's own page for
//!   them, the top of Settings, rather than the system's About panel, which can't check
//!   for updates or link anywhere.
//! - The File menu works on tabs: New Tab (⌘T) and Close Tab (⌘W), beside New Window
//!   (⌘N) and Close Window (⇧⌘W). The default's Close Window, on ⌘W, would close every
//!   tab in the window at once.
//!
//! The window in front is told which was chosen ("menu"), and does it; Close Window
//! closes it here, which asks first, as its close button does, with work to lose. With
//! no window in front, as with all of them minimized, closing does nothing.

use tauri::menu::{HELP_SUBMENU_ID, Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

/// What's chosen, as the page is told it.
const ABOUT: &str = "about";
const CHECK_FOR_UPDATES: &str = "check-for-updates";
const NEW_TAB: &str = "new-tab";
const NEW_WINDOW: &str = "new-window";
const CLOSE_TAB: &str = "close-tab";
/// Done here, not told.
const CLOSE_WINDOW: &str = "close-window";

pub fn set(app: &AppHandle) -> tauri::Result<()> {
    let palace = Submenu::with_items(
        app,
        "Palace",
        true,
        &[
            &MenuItem::with_id(app, ABOUT, "About Palace", true, None::<&str>)?,
            &MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, NEW_TAB, "New Tab", true, Some("CmdOrCtrl+T"))?,
            &MenuItem::with_id(app, NEW_WINDOW, "New Window", true, Some("CmdOrCtrl+N"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?,
            &MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, Some("CmdOrCtrl+Shift+W"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    // By these ids, the system lists the windows in the one, and puts its search in the
    // other.
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;
    app.set_menu(Menu::with_items(app, &[&palace, &file, &edit, &view, &window, &help])?)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if [ABOUT, CHECK_FOR_UPDATES, NEW_TAB, NEW_WINDOW].contains(&id) {
            tell_front_window(app, id);
        } else if id == CLOSE_TAB
            && let Some(window) = focused_window(app)
        {
            let _ = app.emit_to(EventTarget::webview_window(window.label()), "menu", id);
        } else if id == CLOSE_WINDOW
            && let Some(window) = focused_window(app)
        {
            let _ = window.close();
        }
    });
    Ok(())
}

/// The window in front, if one is: closing acts only on that, as the system's own Close
/// Window does, never on one minimized or behind another app's.
fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
}

/// The window in front, or with none focused, any window, for what opens something.
fn front_window(app: &AppHandle) -> Option<WebviewWindow> {
    focused_window(app).or_else(|| app.webview_windows().into_values().next())
}

/// Tells the window in front that `id` was chosen.
fn tell_front_window(app: &AppHandle, id: &str) {
    if let Some(window) = front_window(app) {
        let _ = window.set_focus();
        let _ = app.emit_to(EventTarget::webview_window(window.label()), "menu", id);
    }
}
