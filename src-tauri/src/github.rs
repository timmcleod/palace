//! Signing in to GitHub with a personal access token, so Palace can fetch, pull and
//! push without git having its own GitHub login (such as the GitHub CLI's).
//!
//! The token is kept in the system keyring. While signed in, Palace tells each git
//! it runs to ask Palace itself for github.com credentials: the helper is this same
//! program, started as `palace git-credential get`. Nothing outside Palace changes;
//! git in a terminal keeps using whatever it's set up with.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const KEYRING_SERVICE: &str = "Palace";
const KEYRING_ENTRY: &str = "github.com";

/// Whether a token is stored, so running git doesn't mean asking the keyring each time.
static SIGNED_IN: AtomicBool = AtomicBool::new(false);

/// What's kept in the keyring: the token, and who it belongs to.
#[derive(Serialize, Deserialize, Clone)]
struct Saved {
    token: String,
    #[serde(flatten)]
    account: Account,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Account {
    login: String,
    name: Option<String>,
    avatar_url: String,
}

/// Checks the keyring once at startup.
pub fn load() {
    SIGNED_IN.store(saved().is_some(), Ordering::Relaxed);
}

/// The signed-in account, if any. Read from the keyring, so it works offline.
#[tauri::command]
pub async fn github_account() -> Option<Account> {
    saved().map(|s| s.account)
}

/// Checks `token` with GitHub and, if it works, keeps it for Palace's git commands.
#[tauri::command]
pub async fn github_sign_in(token: String) -> Result<Account, String> {
    let token = token.trim().to_string();
    let account = check_token(&token)?;
    let saved = Saved { token, account: account.clone() };
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    entry()?.set_password(&json).map_err(|e| format!("Couldn't save the token in the keyring: {e}"))?;
    SIGNED_IN.store(true, Ordering::Relaxed);
    Ok(account)
}

#[tauri::command]
pub async fn github_sign_out() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("Couldn't remove the token from the keyring: {e}")),
    }
    SIGNED_IN.store(false, Ordering::Relaxed);
    Ok(())
}

/// The `-c` options that make git ask Palace for github.com credentials, or none when
/// not signed in. They replace any other github.com helper for that one command.
pub(crate) fn git_config_args() -> Vec<String> {
    if !SIGNED_IN.load(Ordering::Relaxed) {
        return Vec::new();
    }
    let Ok(exe) = std::env::current_exe() else { return Vec::new() };
    helper_args(&exe.to_string_lossy())
}

fn helper_args(exe: &str) -> Vec<String> {
    // Helpers starting with "!" run through the shell, so the path is single-quoted.
    let quoted = format!("'{}'", exe.replace('\'', r"'\''"));
    vec![
        "-c".into(),
        // An empty value clears the helpers configured so far.
        "credential.https://github.com.helper=".into(),
        "-c".into(),
        format!("credential.https://github.com.helper=!{quoted} git-credential"),
    ]
}

/// Runs as git's credential helper: `palace git-credential <get|store|erase>`. Only
/// "get" does anything; Palace's token is managed in Palace, not by git.
pub fn credential_helper(action: Option<&str>) -> i32 {
    if action != Some("get") {
        return 0;
    }
    let request: Vec<String> = std::io::stdin()
        .lock()
        .lines()
        .map_while(Result::ok)
        .take_while(|line| !line.is_empty())
        .collect();
    if let Some(saved) = saved() {
        let _ = std::io::stdout().write_all(answer(&request, &saved).as_bytes());
    }
    0
}

/// The reply to a credential request: the login and token for https://github.com,
/// nothing for anything else.
fn answer(request: &[String], saved: &Saved) -> String {
    let field = |name: &str| request.iter().find_map(|l| l.strip_prefix(&format!("{name}=")));
    if field("protocol") != Some("https") || field("host") != Some("github.com") {
        return String::new();
    }
    format!("username={}\npassword={}\n", saved.account.login, saved.token)
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ENTRY).map_err(|e| format!("Couldn't open the keyring: {e}"))
}

fn saved() -> Option<Saved> {
    let json = entry().ok()?.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

/// Asks GitHub who the token belongs to. Classic tokens list their scopes; one without
/// "repo" can't reach private repositories, so it's turned down with an explanation.
fn check_token(token: &str) -> Result<Account, String> {
    if token.is_empty() {
        return Err("Paste a token first.".into());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .user_agent("Palace")
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .get("https://api.github.com/user")
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;

    match response.status().as_u16() {
        200 => {}
        401 => return Err("GitHub didn't accept that token. Check it was copied in full and hasn't expired.".into()),
        status => return Err(format!("GitHub couldn't check the token (HTTP {status}).")),
    }
    let scopes = response.headers().get("x-oauth-scopes").and_then(|v| v.to_str().ok()).map(str::to_string);
    if let Some(scopes) = scopes {
        if !scopes.split(',').any(|s| s.trim() == "repo") {
            return Err("This token can't reach private repositories or push. Create one with the “repo” scope.".into());
        }
    }
    response.body_mut().read_json::<Account>().map_err(|e| format!("GitHub's reply didn't make sense: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved() -> Saved {
        Saved {
            token: "ghp_secret".into(),
            account: Account { login: "octocat".into(), name: None, avatar_url: String::new() },
        }
    }

    #[test]
    fn answering_only_github_over_https() {
        let request = |lines: &[&str]| lines.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        assert_eq!(
            answer(&request(&["protocol=https", "host=github.com", "path=o/r.git"]), &saved()),
            "username=octocat\npassword=ghp_secret\n"
        );
        assert_eq!(answer(&request(&["protocol=https", "host=gitlab.com"]), &saved()), "");
        assert_eq!(answer(&request(&["protocol=http", "host=github.com"]), &saved()), "");
    }

    #[test]
    fn the_helper_replaces_other_github_helpers() {
        let args = helper_args("/opt/it's here/palace");
        assert_eq!(args[1], "credential.https://github.com.helper=");
        assert_eq!(args[3], r"credential.https://github.com.helper=!'/opt/it'\''s here/palace' git-credential");
    }

    #[test]
    fn git_asks_the_helper_for_github_credentials() {
        // A stand-in helper script, set up the way Palace sets up its own.
        let dir = std::env::temp_dir().join(format!("palace-helper-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("helper.sh");
        // Started as "<script> git-credential get", like Palace would be.
        std::fs::write(&script, "#!/bin/sh\n[ \"$2\" = get ] && printf 'username=octocat\\npassword=ghp_secret\\n'\n").unwrap();
        std::process::Command::new("chmod").arg("+x").arg(&script).status().unwrap();

        let mut args: Vec<String> = helper_args(&script.to_string_lossy());
        args.extend(["credential".into(), "fill".into()]);
        let mut child = std::process::Command::new("git")
            .args(&args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"protocol=https\nhost=github.com\n\n").unwrap();
        let output = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
        assert!(output.contains("username=octocat\n") && output.contains("password=ghp_secret\n"), "{output}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
