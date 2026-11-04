//! The system notifications that say a terminal's agent finished or needs you, on Linux,
//! sent to the desktop's notification server over D-Bus by Palace itself rather than
//! through the notification plugin. Clicking one brings its terminal tab forward, and
//! for that the server first hands Palace an activation token (GNOME does), which the
//! window is raised with. The plugin passes the click on but not the token, so the
//! desktop went on showing Palace as starting, with a busy cursor, for a few seconds.
//! macOS goes on using the plugin.

/// Shows a notification, from the terminal tab `key` of the repository at `path` in
/// `window`; clicking it brings that tab forward. `body` is markup, escaped already.
#[tauri::command]
pub async fn notify_tab(app: tauri::AppHandle, window: tauri::WebviewWindow, title: String, body: String, path: String, key: u32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux::notify(app, window.label().to_string(), title, body, path, key);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, window, title, body, path, key);
        Err("Palace sends its own notifications only on Linux.".into())
    }
}

/// Withdraws the notifications shown from the terminal tab `key` in `window`, as when
/// it's been looked at, so they leave the desktop's list and the count on Palace's icon.
#[tauri::command]
pub async fn withdraw_notifications(window: tauri::WebviewWindow, key: u32) {
    #[cfg(target_os = "linux")]
    linux::withdraw(window.label(), key);
    #[cfg(not(target_os = "linux"))]
    let _ = (window, key);
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter, EventTarget, Manager};
    use zbus::blocking::{Connection, MessageIterator};
    use zbus::zvariant::Value;

    const SERVER: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    /// What a shown notification leads to, and the token to raise its window with, once
    /// the server has given one.
    struct Shown {
        window: String,
        path: String,
        key: u32,
        token: Option<String>,
    }

    /// The connection notifications are sent on, kept open: servers like GNOME's close a
    /// notification once the connection that sent it goes away, and they report what
    /// happens to it on that connection only.
    struct Server {
        connection: Connection,
        shown: Mutex<HashMap<u32, Shown>>,
    }

    static SERVER_CONNECTION: OnceLock<Option<&'static Server>> = OnceLock::new();

    fn server(app: &AppHandle) -> Option<&'static Server> {
        *SERVER_CONNECTION.get_or_init(|| {
            let connection = Connection::session().ok()?;
            let server: &'static Server = Box::leak(Box::new(Server { connection, shown: Mutex::default() }));
            let app = app.clone();
            std::thread::Builder::new().name("notifications".into()).spawn(move || listen(&app, server)).ok()?;
            Some(server)
        })
    }

    pub fn notify(app: AppHandle, window: String, title: String, body: String, path: String, key: u32) -> Result<(), String> {
        let server = server(&app).ok_or("Couldn't reach the desktop's notifications.")?;
        let mut hints: HashMap<&str, Value> = HashMap::new();
        // The app it's from, for its name and icon: Palace.desktop.
        hints.insert("desktop-entry", Value::from("Palace"));
        // "default" is the notification itself, clicked.
        let actions = vec!["default", ""];
        let reply = server
            .connection
            .call_method(Some(SERVER), PATH, Some(SERVER), "Notify", &("Palace", 0u32, "", title.as_str(), body.as_str(), actions, hints, -1i32))
            .map_err(|e| format!("Couldn't show a notification: {e}"))?;
        let id: u32 = reply.body().deserialize().map_err(|e| format!("Couldn't show a notification: {e}"))?;
        server.shown.lock().unwrap().insert(id, Shown { window, path, key, token: None });
        Ok(())
    }

    pub fn withdraw(window: &str, key: u32) {
        let Some(Some(server)) = SERVER_CONNECTION.get() else { return };
        let ids: Vec<u32> = {
            let mut shown = server.shown.lock().unwrap();
            let ids = shown.iter().filter(|(_, s)| s.window == window && s.key == key).map(|(id, _)| *id).collect();
            shown.retain(|_, s| !(s.window == window && s.key == key));
            ids
        };
        for id in ids {
            let _ = server.connection.call_method(Some(SERVER), PATH, Some(SERVER), "CloseNotification", &(id,));
        }
    }

    // What the server says of the notifications: a token, then the click it's for, then
    // that it's closed. The click brings the notification's tab forward.
    fn listen(app: &AppHandle, server: &'static Server) {
        let Ok(rule) = zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal).interface(SERVER).and_then(|rule| rule.path(PATH)) else { return };
        let Ok(messages) = MessageIterator::for_match_rule(rule.build(), &server.connection, None) else { return };
        for message in messages.flatten() {
            let header = message.header();
            let Some(member) = header.member() else { continue };
            let body = message.body();
            match member.as_str() {
                "ActivationToken" => {
                    if let Ok((id, token)) = body.deserialize::<(u32, String)>()
                        && let Some(shown) = server.shown.lock().unwrap().get_mut(&id)
                    {
                        shown.token = Some(token);
                    }
                }
                "ActionInvoked" => {
                    let Ok((id, action)) = body.deserialize::<(u32, String)>() else { continue };
                    let shown = server.shown.lock().unwrap().remove(&id);
                    if let (Some(shown), "default") = (shown, action.as_str()) {
                        bring_forward(app, shown);
                    }
                }
                "NotificationClosed" => {
                    if let Ok((id, _reason)) = body.deserialize::<(u32, u32)>() {
                        server.shown.lock().unwrap().remove(&id);
                    }
                }
                _ => {}
            }
        }
    }

    // Raises the window with the server's token, which tells the desktop the click's been
    // answered (and lets the window come forward on Wayland), then has it show the tab.
    fn bring_forward(app: &AppHandle, shown: Shown) {
        let Some(window) = app.get_webview_window(&shown.window) else { return };
        let raised = window.clone();
        let token = shown.token;
        let _ = window.run_on_main_thread(move || {
            use gtk::prelude::*;
            let Ok(gtk_window) = raised.gtk_window() else { return };
            if let Some(token) = token {
                gtk_window.set_startup_id(&token);
            }
            gtk_window.present();
        });
        let tab = crate::windows::TerminalTab { path: shown.path, key: shown.key };
        let _ = app.emit_to(EventTarget::webview_window(&shown.window), "show-terminal-tab", tab);
    }
}
