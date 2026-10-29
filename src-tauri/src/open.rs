//! Opening the repository outside Palace: its folder in the file manager, a file
//! shown in its folder, and a terminal there.

use git2::Repository;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri_plugin_opener::OpenerExt;

/// Opens the working copy's folder in the file manager.
#[tauri::command]
pub async fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = workdir(&path)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Couldn't open the folder: {e}"))
}

/// Opens the folder holding `file` in the file manager, with the file selected. A
/// deleted file's nearest remaining folder is opened instead.
#[tauri::command]
pub async fn show_in_folder(app: tauri::AppHandle, path: String, file: String) -> Result<(), String> {
    let full = workdir(&path)?.join(&file);
    if full.exists() {
        return tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(full))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Couldn't show {file}: {e}"));
    }
    let folder = full.ancestors().find(|p| p.is_dir()).unwrap_or(&full).to_path_buf();
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Couldn't open the folder: {e}"))
}

/// Opens a terminal in the working copy: the one in $TERMINAL, else the system's
/// default (x-terminal-emulator on Debian and Ubuntu), else the first of the common
/// ones that's installed.
#[tauri::command]
pub async fn open_terminal(path: String) -> Result<(), String> {
    let dir = workdir(&path)?;
    let preferred = std::env::var("TERMINAL").ok().filter(|t| !t.trim().is_empty());
    let candidates = preferred.iter().map(String::as_str).chain(TERMINALS.iter().copied());
    for name in candidates {
        let Some(program) = find_program(name.trim()) else { continue };
        let mut command = Command::new(&program);
        command
            .args(directory_args(&program, &dir))
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        leave_app_image(&mut command);
        // Its own session, so it isn't tied to Palace or to the terminal Palace was
        // started from.
        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|e| format!("Couldn't open {name}: {e}"))?;
        // Collect its exit status, whenever that is, so it doesn't linger as a zombie.
        std::thread::spawn(move || child.wait());
        return Ok(());
    }
    Err("Palace couldn't find a terminal. Set the TERMINAL environment variable to the one you use.".into())
}

const TERMINALS: &[&str] = &[
    "x-terminal-emulator",
    "ptyxis",
    "gnome-terminal",
    "kgx",
    "konsole",
    "xfce4-terminal",
    "mate-terminal",
    "tilix",
    "terminator",
    "alacritty",
    "kitty",
    "wezterm",
    "foot",
    "xterm",
];

fn workdir(path: &str) -> Result<PathBuf, String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    repo.workdir().map(Path::to_path_buf).ok_or_else(|| "This repository has no working copy.".into())
}

/// The program's full path: `name` itself if it's a path, else where it is on PATH.
fn find_program(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        return Path::new(name).is_file().then(|| PathBuf::from(name));
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// How to tell a terminal which folder to start in. `program` is followed through
/// symlinks first, since x-terminal-emulator is a link to the real one. Terminals not
/// listed start in their working directory, which is set as well.
fn directory_args(program: &Path, dir: &Path) -> Vec<String> {
    let real = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf());
    let name = real.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let dir = dir.to_string_lossy();
    match name {
        "ptyxis" => vec!["--new-window".into(), format!("--working-directory={dir}")],
        "konsole" => vec![format!("--workdir={dir}")],
        "kitty" => vec![format!("--directory={dir}")],
        "wezterm" => vec!["start".into(), format!("--cwd={dir}")],
        // gnome-terminal.wrapper is Debian's xterm-style front end for gnome-terminal,
        // which passes the option on.
        n if n.starts_with("gnome-terminal")
            || ["kgx", "xfce4-terminal", "mate-terminal", "tilix", "terminator", "alacritty", "foot"].contains(&n) =>
        {
            vec![format!("--working-directory={dir}")]
        }
        _ => Vec::new(),
    }
}

/// Inside the AppImage, Palace's environment points GTK and GLib at the libraries and
/// schemas bundled with it, which would break a terminal from the system.
fn leave_app_image(command: &mut Command) {
    let Some(appdir) = std::env::var_os("APPDIR").filter(|_| std::env::var_os("APPIMAGE").is_some()) else {
        return;
    };
    for var in [
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
    ] {
        command.env_remove(var);
    }
    if let Some(dirs) = std::env::var_os("XDG_DATA_DIRS") {
        let kept: Vec<PathBuf> = std::env::split_paths(&dirs).filter(|d| !d.starts_with(&appdir)).collect();
        if let Ok(joined) = std::env::join_paths(kept) {
            command.env("XDG_DATA_DIRS", joined);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminals_are_told_where_to_start() {
        let dir = Path::new("/home/ada/my repo");
        let args = |program: &str| directory_args(Path::new(program), dir);
        assert_eq!(args("/nowhere/ptyxis"), ["--new-window", "--working-directory=/home/ada/my repo"]);
        assert_eq!(args("/nowhere/gnome-terminal.wrapper"), ["--working-directory=/home/ada/my repo"]);
        assert_eq!(args("/nowhere/konsole"), ["--workdir=/home/ada/my repo"]);
        assert_eq!(args("/nowhere/wezterm"), ["start", "--cwd=/home/ada/my repo"]);
        assert!(args("/nowhere/xterm").is_empty());
    }

    #[test]
    fn finds_programs_on_the_path() {
        assert!(find_program("sh").is_some());
        assert!(find_program("no-such-terminal-here").is_none());
        assert_eq!(find_program("/bin/sh"), Some(PathBuf::from("/bin/sh")));
    }
}
