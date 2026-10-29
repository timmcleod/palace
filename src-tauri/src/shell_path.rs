//! Apps opened from the Dock or Finder on macOS start with a bare PATH
//! (/usr/bin:/bin:/usr/sbin:/sbin), without Homebrew's git or the tools that hooks
//! run, such as node or php. Palace takes its PATH from the user's login shell
//! instead, so git and hooks find what they would in Terminal.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

// Marks the PATH in the shell's output, which startup files may print to as well.
const MARK: &str = "__PALACE_PATH__";

/// Replaces this process's PATH with the login shell's. Call it at startup, before
/// any other threads exist.
#[cfg(target_os = "macos")]
pub fn adopt_login_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Some(path) = login_path(&shell, Duration::from_secs(5)) {
        // Safe: nothing else is running yet.
        unsafe { std::env::set_var("PATH", path) };
    }
}

/// The PATH an interactive login `shell` ends up with, or None if it can't be read
/// within `timeout` (a startup file waiting for input, say).
pub(crate) fn login_path(shell: &str, timeout: Duration) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = String::new();
        let _ = stdout.read_to_string(&mut output);
        let _ = send.send(output);
    });
    let output = receive.recv_timeout(timeout);
    let _ = child.kill();
    let _ = child.wait();
    let output = output.ok()?;
    let path = output.split(MARK).nth(1)?;
    (!path.is_empty()).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_login_shells_path() {
        let path = login_path("/bin/sh", Duration::from_secs(5)).unwrap();
        assert!(path.split(':').any(|dir| dir == "/usr/bin" || dir == "/bin"), "{path}");
    }

    #[test]
    fn gives_up_on_a_shell_that_never_finishes() {
        let dir = std::env::temp_dir().join(format!("palace-shell-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shell = dir.join("slow-shell");
        std::fs::write(&shell, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&shell, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

        let started = std::time::Instant::now();
        assert_eq!(login_path(&shell.to_string_lossy(), Duration::from_millis(300)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
