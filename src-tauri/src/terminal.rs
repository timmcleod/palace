//! Terminals in Palace's panel: the user's shell in a pseudo-terminal, started in the
//! repository's folder. What it prints streams to the panel as it comes, as bytes, and
//! what's typed there is written back.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    shell: Option<u32>,
}

static TERMINALS: LazyLock<Mutex<HashMap<u32, Terminal>>> = LazyLock::new(Default::default);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// What Palace may have inherited from the terminal or IDE it was started in, which
/// would tell programs in its terminals they're in that one: Claude Code, say, takes
/// itself to be in RustRover's terminal, connected to it, and reads keys as there.
const INHERITED: &[&str] = &[
    "TERMINAL_EMULATOR",
    "ENABLE_IDE_INTEGRATION",
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    "VTE_VERSION",
    "TERM_SESSION_ID",
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "KITTY_WINDOW_ID",
    "KITTY_PID",
    "KONSOLE_VERSION",
    "WEZTERM_PANE",
    "WEZTERM_EXECUTABLE",
    "WT_SESSION",
    "GHOSTTY_RESOURCES_DIR",
    "VSCODE_INJECTION",
    "VSCODE_GIT_IPC_HANDLE",
    "VSCODE_IPC_HOOK_CLI",
];

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

/// Starts the user's login shell in `path`, `cols` by `rows`, and returns its id.
/// `output` receives what it prints, and `exited` its exit code once it's gone.
#[tauri::command]
pub async fn terminal_open(
    path: String,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
    exited: Channel<u32>,
) -> Result<u32, String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| format!("Couldn't start a terminal: {e}"))?;
    let mut command = CommandBuilder::new_default_prog();
    command.cwd(&path);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // Programs that adapt to the terminal they're in should know it's Palace's, not
    // the one Palace may have been started from.
    command.env("TERM_PROGRAM", "Palace");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    for var in INHERITED.iter().copied() {
        command.env_remove(var);
    }
    // Claude Code's own, from a session Palace was started in: Claude Code in Palace's
    // terminals would take itself for part of that session.
    for (var, _) in std::env::vars_os() {
        if var.to_str().is_some_and(|var| var.starts_with("CLAUDE_CODE_")) {
            command.env_remove(var);
        }
    }
    #[cfg(not(target_os = "macos"))]
    for (var, value) in app_image_env() {
        match value {
            Some(value) => command.env(var, value),
            None => command.env_remove(var),
        }
    }

    let mut child = pair.slave.spawn_command(command).map_err(|e| format!("Couldn't start the shell: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut killer = child.clone_killer();
    let terminal = Terminal { master: pair.master, writer, killer: child.clone_killer(), shell: child.process_id() };
    TERMINALS.lock().unwrap().insert(id, terminal);

    std::thread::spawn(move || {
        let mut buffer = vec![0; 64 * 1024];
        loop {
            match reader.read(&mut buffer) {
                // The shell is gone, and whatever it started that was still printing.
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // With nothing to show it, the shell would only stall once its
                    // output filled up.
                    if output.send(InvokeResponseBody::Raw(buffer[..n].to_vec())).is_err() {
                        let _ = killer.kill();
                        break;
                    }
                }
            }
        }
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        TERMINALS.lock().unwrap().remove(&id);
        let _ = exited.send(code);
    });
    Ok(id)
}

/// Types `data` into the terminal: keys pressed, or text pasted.
#[tauri::command]
pub async fn terminal_write(id: u32, data: String) -> Result<(), String> {
    let mut terminals = TERMINALS.lock().unwrap();
    let terminal = terminals.get_mut(&id).ok_or("The terminal has closed.")?;
    terminal.writer.write_all(data.as_bytes()).and_then(|_| terminal.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let terminals = TERMINALS.lock().unwrap();
    let terminal = terminals.get(&id).ok_or("The terminal has closed.")?;
    terminal.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

/// Whether something other than the shell is running in the terminal, in front, such
/// as a dev server or Claude Code.
#[tauri::command]
pub async fn terminal_busy(id: u32) -> bool {
    let terminals = TERMINALS.lock().unwrap();
    let Some(terminal) = terminals.get(&id) else { return false };
    match (terminal.master.process_group_leader(), terminal.shell) {
        (Some(front), Some(shell)) => front as u32 != shell,
        _ => false,
    }
}

/// Hangs up the terminal, which ends its shell and what the shell started.
#[tauri::command]
pub async fn terminal_close(id: u32) {
    if let Some(mut terminal) = TERMINALS.lock().unwrap().remove(&id) {
        let _ = terminal.killer.kill();
    }
}

/// Hangs up every terminal: those of a page that's since been reloaded.
#[tauri::command]
pub async fn terminal_close_all() {
    for (_, mut terminal) in TERMINALS.lock().unwrap().drain() {
        let _ = terminal.killer.kill();
    }
}

/// How to undo the AppImage's environment for the shell: each variable to remove (None)
/// or set. Inside the AppImage, it points GTK and GLib at the libraries and schemas
/// bundled with Palace, which would break programs from the system started in a
/// terminal. Nothing outside the AppImage.
#[cfg(not(target_os = "macos"))]
fn app_image_env() -> Vec<(&'static str, Option<std::ffi::OsString>)> {
    let Some(appdir) = std::env::var_os("APPDIR").filter(|_| std::env::var_os("APPIMAGE").is_some()) else {
        return Vec::new();
    };
    let mut changes: Vec<_> = [
        "GTK_DATA_PREFIX",
        "GTK_THEME",
        "GSETTINGS_SCHEMA_DIR",
        "GI_TYPELIB_PATH",
        "GIO_MODULE_DIR",
        "GTK_EXE_PREFIX",
        "GTK_PATH",
        "GTK_IM_MODULE_FILE",
        "GDK_PIXBUF_MODULE_FILE",
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "OWD",
    ]
    .into_iter()
    .map(|var| (var, None))
    .collect();
    if let Some(dirs) = std::env::var_os("XDG_DATA_DIRS") {
        let kept: Vec<std::path::PathBuf> = std::env::split_paths(&dirs).filter(|d| !d.starts_with(&appdir)).collect();
        if let Ok(joined) = std::env::join_paths(kept) {
            changes.push(("XDG_DATA_DIRS", Some(joined)));
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::ipc::InvokeResponseBody;

    #[test]
    fn a_shell_starts_in_the_folder_and_takes_what_is_typed() {
        let dir = std::env::temp_dir().join(format!("palace-test-terminal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let (send, printed) = mpsc::channel();
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = send.send(bytes);
            }
            Ok(())
        });
        let (send, exit) = mpsc::channel();
        let exited = Channel::new(move |body| {
            if let InvokeResponseBody::Json(code) = body {
                let _ = send.send(code);
            }
            Ok(())
        });
        let path = dir.to_string_lossy().into_owned();
        let id = tauri::async_runtime::block_on(terminal_open(path, 80, 24, output, exited)).unwrap();

        // Run with TERMINAL_EMULATOR or CLAUDE_CODE_SSE_PORT set, the shell shouldn't see them.
        let typed = "echo \"in:$(pwd) from:${TERMINAL_EMULATOR-}${CLAUDE_CODE_SSE_PORT-}:\"; exit 3\n";
        tauri::async_runtime::block_on(terminal_write(id, typed.into())).unwrap();
        let mut seen = Vec::new();
        while let Ok(bytes) = printed.recv_timeout(Duration::from_secs(10)) {
            seen.extend(bytes);
        }
        let seen = String::from_utf8_lossy(&seen);
        let folder = dir.canonicalize().unwrap();
        assert!(seen.contains(&format!("in:{} from::", folder.display())), "{seen}");
        assert_eq!(exit.recv_timeout(Duration::from_secs(10)).unwrap(), "3");
        assert!(tauri::async_runtime::block_on(terminal_write(id, "more\n".into())).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
