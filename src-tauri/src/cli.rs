//! Running the git CLI. Palace uses it for everything that changes a repository, so
//! hooks, signing, credential helpers and the user's git config all apply.

use git2::Repository;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Runs git to completion. On failure, returns what git printed so the user can see
/// why (a failing hook, a missing identity, …).
pub(crate) fn git(path: &str, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let mut child = command(&workdir(path)?, args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run git: {e}"))?;

    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .expect("stdin is piped")
            .write_all(input.as_bytes())
            .map_err(|e| format!("Couldn't send input to git: {e}"))?;
    }

    let output = child.wait_with_output().map_err(|e| format!("git failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() { Ok(stdout) } else { Err(join_output(&stderr, &stdout)) }
}

/// The git process currently doing network work, so it can be cancelled.
#[derive(Default)]
pub struct Running(pub(crate) Mutex<Option<u32>>);

impl Running {
    /// Stops the running process and anything it started (ssh, credential helpers).
    pub(crate) fn cancel(&self) {
        if let Some(pid) = *self.0.lock().unwrap() {
            #[cfg(unix)]
            // Each git runs in its own session, so its process group holds exactly
            // git and its helpers.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGTERM);
            }
            #[cfg(not(unix))]
            let _ = pid;
        }
    }
}

/// Runs a long git command (fetch, pull, push), passing each progress update git
/// prints to `on_progress` as it arrives. Only one runs at a time.
pub(crate) fn git_with_progress(
    path: &str,
    args: &[&str],
    running: &Running,
    mut on_progress: impl FnMut(&str),
) -> Result<String, String> {
    let mut child: Child = {
        let mut slot = running.0.lock().unwrap();
        if slot.is_some() {
            return Err("Another fetch, pull or push is still running.".into());
        }
        let child = command(&workdir(path)?, args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Couldn't run git: {e}"))?;
        *slot = Some(child.id());
        child
    };

    let mut stdout = child.stdout.take().expect("stdout is piped");
    let stdout_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });

    // Git redraws progress in place with \r and ends finished lines with \n. Every
    // fragment is reported as progress; only finished lines are kept for messages.
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let mut transcript = String::new();
    let mut pending = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &byte in &buf[..n] {
            if byte == b'\r' || byte == b'\n' {
                let line = String::from_utf8_lossy(&pending).trim().to_string();
                if !line.is_empty() {
                    on_progress(&line);
                    if byte == b'\n' {
                        transcript.push_str(&line);
                        transcript.push('\n');
                    }
                }
                pending.clear();
            } else {
                pending.push(byte);
            }
        }
    }
    let leftover = String::from_utf8_lossy(&pending).trim().to_string();
    transcript.push_str(&leftover);

    let status = child.wait();
    *running.0.lock().unwrap() = None;
    let stdout = stdout_reader.join().unwrap_or_default().trim().to_string();
    let transcript = transcript.trim().to_string();

    match status {
        Ok(s) if s.success() => Ok(join_output(&transcript, &stdout)),
        #[cfg(unix)]
        Ok(s) if std::os::unix::process::ExitStatusExt::signal(&s) == Some(libc::SIGTERM) => {
            Err("Cancelled.".into())
        }
        Ok(_) => Err(join_output(&transcript, &stdout)),
        Err(e) => Err(format!("git failed: {e}")),
    }
}

fn command(workdir: &PathBuf, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workdir)
        // Fail instead of prompting for a password nobody can see. Credential helpers
        // and SSH agents still work.
        .env("GIT_TERMINAL_PROMPT", "0");

    // Start git in a new session with no controlling terminal. Otherwise, when Palace
    // is launched from a terminal, ssh would ask for a passphrase there and hang.
    // Without a terminal, ssh and gpg fall back to the desktop's agent or GUI prompt.
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    command
}

fn workdir(path: &str) -> Result<PathBuf, String> {
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    repo.workdir().map(PathBuf::from).ok_or_else(|| "This repository has no working copy.".to_string())
}

fn join_output(first: &str, second: &str) -> String {
    [first, second].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n")
}
