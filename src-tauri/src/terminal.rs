//! Terminals in Palace's panel: the user's shell in a pseudo-terminal, started in the
//! repository's folder. What it prints streams to the panel as it comes, as bytes, and
//! what's typed there is written back.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, LazyLock, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::WebviewWindow;

struct Terminal {
    master: Box<dyn MasterPty + Send>,
    /// What's typed, for the terminal's own thread to write: a program that isn't
    /// reading holds up only that thread, not every terminal.
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    shell: Option<u32>,
    /// The window it's in, whose closing ends it.
    window: String,
    /// The folder it started in.
    folder: String,
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
    window: WebviewWindow,
    path: String,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
    exited: Channel<u32>,
) -> Result<u32, String> {
    open(window.label().to_string(), path, cols, rows, output, exited)
}

fn open(window: String, path: String, cols: u16, rows: u16, output: Channel<InvokeResponseBody>, exited: Channel<u32>) -> Result<u32, String> {
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
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut killer = child.clone_killer();
    let (input, typed) = mpsc::channel::<Vec<u8>>();
    // Ends once the terminal's closed and nothing more can be typed, or the shell has
    // gone and can't take it.
    std::thread::spawn(move || {
        for data in typed {
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });
    let terminal = Terminal { master: pair.master, input, killer: child.clone_killer(), shell: child.process_id(), window, folder: path };
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

/// Types `data` into the terminal: keys pressed, or text pasted. It's queued, so a
/// program that isn't reading doesn't hold up Palace.
#[tauri::command]
pub async fn terminal_write(id: u32, data: String) -> Result<(), String> {
    let terminals = TERMINALS.lock().unwrap();
    let terminal = terminals.get(&id).ok_or("The terminal has closed.")?;
    terminal.input.send(data.into_bytes()).map_err(|_| "The terminal has closed.".to_string())
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
    TERMINALS.lock().unwrap().get(&id).is_some_and(is_busy)
}

fn is_busy(terminal: &Terminal) -> bool {
    match (terminal.master.process_group_leader(), terminal.shell) {
        (Some(front), Some(shell)) => front as u32 != shell,
        _ => false,
    }
}

/// The program in front in the terminal, by name, such as "zsh", "vim" or "claude",
/// for keys that mean something different to Claude Code. None when it can't tell.
#[tauri::command]
pub async fn terminal_foreground(id: u32) -> Option<String> {
    let front = TERMINALS.lock().unwrap().get(&id)?.master.process_group_leader()?;
    program_name(front)
}

/// Whether the program at `path` is Claude Code's: its installer keeps it as
/// ".../claude/versions/<version>", and Homebrew and others as ".../claude".
fn is_claude_program(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == "claude")
        || path.parent().is_some_and(|dir| dir.ends_with("claude/versions"))
}

/// What the process `pid` runs. Claude Code installed with npm runs as node, so a node
/// running Claude Code's script counts as "claude", where that can be read (Linux).
#[cfg(target_os = "linux")]
fn program_name(pid: i32) -> Option<String> {
    if std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|exe| is_claude_program(&exe)) {
        return Some("claude".into());
    }
    let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?.trim().to_string();
    if name == "node" {
        let args = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        let runs_claude = args.split(|b| *b == 0).skip(1).take(2).any(|arg| {
            let arg = String::from_utf8_lossy(arg);
            arg.ends_with("/claude") || arg.contains("@anthropic-ai/claude-code")
        });
        if runs_claude {
            return Some("claude".into());
        }
    }
    Some(name)
}

#[cfg(target_os = "macos")]
fn program_name(pid: i32) -> Option<String> {
    let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: proc_pidpath writes at most the buffer's size, and returns how much it wrote.
    let len = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if len > 0 && is_claude_program(Path::new(&*String::from_utf8_lossy(&path[..len as usize]))) {
        return Some("claude".into());
    }
    let mut buffer = [0u8; 256];
    // SAFETY: proc_name writes at most the buffer's size, and returns how much it wrote.
    let len = unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    (len > 0).then(|| String::from_utf8_lossy(&buffer[..len as usize]).into_owned())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn program_name(_pid: i32) -> Option<String> {
    None
}

/// Whether `program` can be run in a terminal: found on Palace's PATH, where installers
/// usually put it, or on the PATH the user's shell sets up, which an app started from
/// the desktop may not have. When it can't tell, it says yes, leaving the terminal to
/// say otherwise.
#[tauri::command]
pub async fn program_available(program: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || available(&program)).await.unwrap_or(true)
}

/// Whether each of `programs` can be run, as `program_available` says.
#[tauri::command]
pub async fn programs_available(programs: Vec<String>) -> Vec<bool> {
    let count = programs.len();
    tauri::async_runtime::spawn_blocking(move || programs.iter().map(|program| available(program)).collect())
        .await
        .unwrap_or_else(|_| vec![true; count])
}

/// The PATH the user's login shell sets up, as last asked for: starting the shell can
/// take a moment, and the terminal panel's ⋯ menu asks each time it opens, so the
/// answer is kept for a minute. None if the shell didn't say.
fn shell_path() -> Option<String> {
    static KEPT: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
    // Held while the shell runs, so that calls at the same time start it only once.
    let mut kept = KEPT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, path)) = kept.as_ref().filter(|(at, _)| at.elapsed() < Duration::from_secs(60)) {
        return path.clone();
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let path = crate::shell_path::login_path(&shell, Duration::from_secs(5));
    *kept = Some((Instant::now(), path.clone()));
    path
}

fn available(program: &str) -> bool {
    let program = program.trim();
    if program.is_empty() {
        return false;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    // A path rather than a name; a relative one depends on where it's run.
    if program.contains('/') {
        let full = match (program.strip_prefix("~/"), &home) {
            (Some(rest), Some(home)) => home.join(rest),
            _ => PathBuf::from(program),
        };
        return !full.is_absolute() || full.is_file();
    }
    let on = |path: &OsStr| std::env::split_paths(path).any(|dir| dir.join(program).is_file());
    if std::env::var_os("PATH").is_some_and(|path| on(&path)) {
        return true;
    }
    // Where installers put programs: Claude Code's native installer and npm's, Homebrew.
    let usual = [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin"];
    if let Some(home) = &home
        && usual.iter().any(|dir| home.join(dir).join(program).is_file())
    {
        return true;
    }
    if ["/opt/homebrew/bin", "/usr/local/bin"].iter().any(|dir| Path::new(dir).join(program).is_file()) {
        return true;
    }
    match shell_path() {
        Some(path) => on(OsStr::new(&path)),
        None => true,
    }
}

/// A terminal with a program running in it, which closing its window would stop.
pub struct Busy {
    pub id: u32,
    pub window: String,
    /// The name of the folder it started in.
    pub folder: String,
}

/// The terminals with programs running in them, in every window.
pub fn busy_terminals() -> Vec<Busy> {
    TERMINALS
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, t)| is_busy(t))
        .map(|(id, t)| Busy {
            id: *id,
            window: t.window.clone(),
            folder: Path::new(&t.folder).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        })
        .collect()
}

/// The programs running in `window`'s terminals, by name, as "vim" or "claude", or None
/// where it can't tell.
pub fn busy_programs(window: &str) -> Vec<Option<String>> {
    TERMINALS
        .lock()
        .unwrap()
        .values()
        .filter(|t| t.window == window && is_busy(t))
        .map(|t| t.master.process_group_leader().and_then(program_name))
        .collect()
}

/// Hangs up the terminal, which ends its shell and what the shell started.
#[tauri::command]
pub async fn terminal_close(id: u32) {
    if let Some(mut terminal) = TERMINALS.lock().unwrap().remove(&id) {
        let _ = terminal.killer.kill();
    }
}

/// Hangs up the window's terminals: those of a page that's since been reloaded.
#[tauri::command]
pub async fn terminal_close_all(window: WebviewWindow) {
    close_window(window.label());
}

/// Hangs up the terminals in `window`, as when it closes.
pub fn close_window(window: &str) {
    let mut terminals = TERMINALS.lock().unwrap();
    let ids: Vec<u32> = terminals.iter().filter(|(_, t)| t.window == window).map(|(id, _)| *id).collect();
    for id in ids {
        if let Some(mut terminal) = terminals.remove(&id) {
            let _ = terminal.killer.kill();
        }
    }
}

/// Hangs up the terminals in `windows`, as close_window does, then waits, up to `limit`
/// for all of them, for their shells and the programs in front in them to exit: hung
/// up, a program may take a moment to stop, writing as it goes.
pub fn close_windows_and_wait(windows: &[String], limit: Duration) {
    // A shell by its process, and what's in front by its process group, which holds
    // what it started.
    let running: Vec<(i32, bool)> = TERMINALS
        .lock()
        .unwrap()
        .values()
        .filter(|t| windows.contains(&t.window))
        .flat_map(|t| {
            let front = t.master.process_group_leader().filter(|front| Some(*front as u32) != t.shell).map(|front| (front, true));
            t.shell.map(|shell| (shell as i32, false)).into_iter().chain(front)
        })
        .collect();
    for window in windows {
        close_window(window);
    }
    let started = Instant::now();
    while running.iter().any(|&(id, group)| still_running(id, group)) && started.elapsed() < limit {
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Whether the process `id`, or with `group`, any process in the group `id`, is still
/// running.
#[cfg(unix)]
fn still_running(id: i32, group: bool) -> bool {
    // SAFETY: signal 0 sends nothing; it only checks that the process exists.
    unsafe { libc::kill(if group { -id } else { id }, 0) == 0 }
}

#[cfg(not(unix))]
fn still_running(_id: i32, _group: bool) -> bool {
    false
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
        let id = open("test".into(), path, 80, 24, output, exited).unwrap();

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

    #[test]
    fn naming_the_program_in_front() {
        let dir = std::env::temp_dir().join(format!("palace-test-terminal-front-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (id, _printed) = open_collecting(&dir.to_string_lossy());
        let front = || tauri::async_runtime::block_on(terminal_foreground(id));
        let wait_for = |want: &dyn Fn(&str) -> bool| {
            let started = std::time::Instant::now();
            while !front().is_some_and(|name| want(&name)) {
                assert!(started.elapsed() < Duration::from_secs(10), "in front: {:?}", front());
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        wait_for(&|name| name != "sleep");
        tauri::async_runtime::block_on(terminal_write(id, "sleep 30\n".into())).unwrap();
        wait_for(&|name| name == "sleep");
        tauri::async_runtime::block_on(terminal_close(id));
        assert_eq!(front(), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn closing_a_window_waits_for_what_its_terminals_run_to_stop() {
        let dir = std::env::temp_dir().join(format!("palace-test-terminal-close-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A window of its own, so closing it hangs up no other test's terminals.
        let window = "test-close-and-wait";
        let output = Channel::new(|_| Ok(()));
        let exited = Channel::new(|_| Ok(()));
        let id = open(window.into(), dir.to_string_lossy().into_owned(), 80, 24, output, exited).unwrap();
        tauri::async_runtime::block_on(terminal_write(id, "sleep 30\n".into())).unwrap();
        let started = Instant::now();
        let front = loop {
            let terminals = TERMINALS.lock().unwrap();
            let terminal = &terminals[&id];
            if let Some(front) = terminal.master.process_group_leader().filter(|front| Some(*front as u32) != terminal.shell) {
                break front;
            }
            drop(terminals);
            assert!(started.elapsed() < Duration::from_secs(10), "sleep never started");
            std::thread::sleep(Duration::from_millis(50));
        };

        close_windows_and_wait(&[window.into()], Duration::from_secs(10));
        assert!(!still_running(front, true), "sleep is still running");
        assert!(busy_programs(window).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn recognizing_claude_code() {
        assert!(is_claude_program(Path::new("/home/me/.local/share/claude/versions/2.1.316")));
        assert!(is_claude_program(Path::new("/opt/homebrew/Caskroom/claude-code/2.1.316/claude")));
        assert!(!is_claude_program(Path::new("/usr/bin/zsh")));
        assert!(!is_claude_program(Path::new("/home/me/versions/2.1.316")));
    }

    #[test]
    fn finding_programs() {
        assert!(available("sh"));
        assert!(available("/bin/sh"));
        assert!(!available("palace-no-such-program"));
        assert!(!available("/no/such/program"));
        assert!(!available("  "));
        // Relative to wherever it's run, so not something to check here.
        assert!(available("./bin/claude"));
    }

    /// A terminal whose output is collected, and its id.
    fn open_collecting(path: &str) -> (u32, mpsc::Receiver<Vec<u8>>) {
        let (send, printed) = mpsc::channel();
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = send.send(bytes);
            }
            Ok(())
        });
        let exited = Channel::new(|_| Ok(()));
        let id = open("test".into(), path.into(), 80, 24, output, exited).unwrap();
        (id, printed)
    }

    #[test]
    fn pasting_into_a_program_that_isnt_reading_holds_up_nothing_else() {
        let dir = std::env::temp_dir().join(format!("palace-test-terminal-paste-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().into_owned();

        let (busy, _) = open_collecting(&path);
        tauri::async_runtime::block_on(terminal_write(busy, "sleep 30\n".into())).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        // Far more than a terminal's input buffer holds.
        let started = std::time::Instant::now();
        tauri::async_runtime::block_on(terminal_write(busy, "x".repeat(1 << 20))).unwrap();
        assert!(started.elapsed() < Duration::from_secs(1), "the paste waited {:?}", started.elapsed());

        let (other, printed) = open_collecting(&path);
        tauri::async_runtime::block_on(terminal_write(other, "echo still-typing\n".into())).unwrap();
        let mut seen = String::new();
        while !seen.contains("still-typing\r\n") {
            let bytes = printed.recv_timeout(Duration::from_secs(10)).expect("the other terminal stalled");
            seen.push_str(&String::from_utf8_lossy(&bytes));
        }

        tauri::async_runtime::block_on(terminal_close(busy));
        tauri::async_runtime::block_on(terminal_close(other));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
