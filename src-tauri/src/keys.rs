//! Which modifier keys are held, for a drag on the page: the web view doesn't say. On
//! macOS its page runs in another process, sandboxed away from the keyboard, so a drag
//! event's altKey is always false, and keys pressed mid-drag don't reach the page, as
//! macOS runs the drag.

/// Whether Alt (Option on a Mac) is held down now.
#[tauri::command]
pub async fn alt_held(app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        use objc2_app_kit::{NSEvent, NSEventModifierFlags};
        NSEvent::modifierFlags_class().contains(NSEventModifierFlags::Option)
    }
    #[cfg(target_os = "linux")]
    {
        // GTK's, read on its thread.
        let (send, receive) = std::sync::mpsc::channel();
        let asked = app.run_on_main_thread(move || {
            let held = gtk::gdk::Display::default()
                .and_then(|display| gtk::gdk::Keymap::for_display(&display))
                .map(|keymap| keymap.modifier_state() & gtk::gdk::ModifierType::MOD1_MASK.bits() != 0)
                .unwrap_or(false);
            let _ = send.send(held);
        });
        asked.is_ok() && receive.recv().unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = app;
        false
    }
}
