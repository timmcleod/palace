//! Restarting into an update once it's installed.

use tauri::{AppHandle, Manager};

/// Restarts Palace after an update. On Linux the new copy waits until this one, and
/// its web view's helper processes, have exited: until then the web view holds on to
/// its storage, and a new copy that starts sooner finds it empty. Palace's own saved
/// data is in a file of its own (see store.rs), so that only matters for copying it
/// over from an old version, but the wait is kept long, a minute at most, for that.
#[tauri::command]
pub fn restart_after_update(app: AppHandle) {
    #[cfg(target_os = "linux")]
    if let Ok(binary) = tauri::process::current_binary(&app.env()) {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        const WAIT_THEN_START: &str = r#"pids="$1 $(pgrep -P "$1")"; shift
for _ in $(seq 300); do
  alive=""; for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
  [ -z "$alive" ] && break; sleep 0.2
done
exec "$@""#;
        let started = Command::new("sh")
            .args(["-c", WAIT_THEN_START, "sh", &std::process::id().to_string()])
            .arg(&binary)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // Its own process group, so it outlives this one.
            .process_group(0)
            .spawn();
        if started.is_ok() {
            app.exit(0);
            return;
        }
    }
    app.restart();
}
