//! Whether Alt (Option) is held, for a branch dragged in the sidebar on macOS: there,
//! while the mouse button is down, the page's pointer events say it isn't, and pressing
//! it doesn't reach the page either. Palace's own process can read it from AppKit.

/// Whether Option is held down now.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn alt_held() -> bool {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags};
    NSEvent::modifierFlags_class().contains(NSEventModifierFlags::Option)
}

/// Elsewhere the page's own events say, so it doesn't ask.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn alt_held() -> bool {
    false
}
