//! The macOS menu bar: the system's usual menus, with the Palace menu's About Palace and
//! Check for Updates… opening Palace's own page for them, the top of Settings, rather
//! than the system's About panel, which can't check for updates or link anywhere. The
//! window in front is told which was chosen ("menu"), and shows it.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

/// What's chosen, as the page is told it.
const ABOUT: &str = "about";
const CHECK_FOR_UPDATES: &str = "check-for-updates";

pub fn set(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    // The default's first menu is the Palace menu, which this one replaces, in the
    // order the system's has.
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
    menu.remove_at(0)?;
    menu.prepend(&palace)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == ABOUT || id == CHECK_FOR_UPDATES {
            tell_front_window(app, id);
        }
    });
    Ok(())
}

/// Tells the window in front, or with none focused, any window, that `id` was chosen.
fn tell_front_window(app: &AppHandle, id: &str) {
    let windows = app.webview_windows();
    let front = windows.values().find(|w| w.is_focused().unwrap_or(false)).or_else(|| windows.values().next());
    if let Some(window) = front {
        let _ = window.set_focus();
        let _ = app.emit_to(EventTarget::webview_window(window.label()), "menu", id);
    }
}
