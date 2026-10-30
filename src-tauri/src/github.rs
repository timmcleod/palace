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

/// Someone whose repositories can be listed: the signed-in account, an organization
/// it belongs to, or someone whose repositories it collaborates on.
#[derive(Serialize, Debug)]
pub struct Owner {
    login: String,
    name: Option<String>,
    avatar_url: String,
    /// "me", "org" or "collaborator".
    kind: &'static str,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Repo {
    name: String,
    full_name: String,
    description: Option<String>,
    private: bool,
    fork: bool,
    /// When it was last pushed to, which is what changes as work happens.
    pushed_at: Option<String>,
    clone_url: String,
    html_url: String,
    owner: RepoOwner,
}

#[derive(Serialize, Deserialize, Debug)]
struct RepoOwner {
    login: String,
    avatar_url: String,
}

#[derive(Deserialize)]
struct Org {
    login: String,
    avatar_url: String,
}

const NOT_SIGNED_IN: &str = "Sign in to GitHub first, in Settings › GitHub.";

/// The signed-in account, its organizations, then the people whose repositories it
/// collaborates on, alphabetically within each group.
#[tauri::command]
pub async fn github_owners() -> Result<Vec<Owner>, String> {
    let saved = saved().ok_or(NOT_SIGNED_IN)?;
    blocking(move || {
        let me = &saved.account;
        let mut owners = vec![Owner {
            login: me.login.clone(),
            name: me.name.clone(),
            avatar_url: me.avatar_url.clone(),
            kind: "me",
        }];

        let mut orgs: Vec<Org> = api_get(&saved.token, "/user/orgs?per_page=100")?;
        orgs.sort_by_key(|o| o.login.to_lowercase());
        owners.extend(orgs.into_iter().map(|o| Owner { login: o.login, name: None, avatar_url: o.avatar_url, kind: "org" }));

        let mut people: Vec<RepoOwner> = Vec::new();
        for repo in all_pages(&saved.token, "/user/repos?affiliation=collaborator&per_page=100")? {
            if !people.iter().any(|p| p.login == repo.owner.login) && !owners.iter().any(|o| o.login == repo.owner.login) {
                people.push(repo.owner);
            }
        }
        people.sort_by_key(|p| p.login.to_lowercase());
        owners.extend(people.into_iter().map(|p| Owner { login: p.login, name: None, avatar_url: p.avatar_url, kind: "collaborator" }));
        Ok(owners)
    })
    .await
}

/// An owner's repositories that the account can see, private ones included, by name.
/// `kind` is the owner's kind from `github_owners`.
#[tauri::command]
pub async fn github_repos(owner: String, kind: String) -> Result<Vec<Repo>, String> {
    let token = saved().ok_or(NOT_SIGNED_IN)?.token;
    blocking(move || {
        let mut repos = match kind.as_str() {
            "me" => all_pages(&token, "/user/repos?affiliation=owner&per_page=100")?,
            "org" => all_pages(&token, &format!("/orgs/{owner}/repos?type=all&per_page=100"))?,
            _ => all_pages(&token, "/user/repos?affiliation=collaborator&per_page=100")?
                .into_iter()
                .filter(|r| r.owner.login == owner)
                .collect(),
        };
        repos.sort_by_key(|r| r.name.to_lowercase());
        Ok(repos)
    })
    .await
}

/// Every page of a repository listing; GitHub returns at most 100 a page.
fn all_pages(token: &str, path: &str) -> Result<Vec<Repo>, String> {
    let mut repos = Vec::new();
    for page in 1..=30 {
        let batch: Vec<Repo> = api_get(token, &format!("{path}&page={page}"))?;
        let done = batch.len() < 100;
        repos.extend(batch);
        if done {
            break;
        }
    }
    Ok(repos)
}

/// The signed-in account's token, for requests made elsewhere (see issues.rs).
pub(crate) fn token() -> Result<String, String> {
    saved().map(|s| s.token).ok_or_else(|| NOT_SIGNED_IN.to_string())
}

/// Runs a GitHub request off the async runtime, since the HTTP client blocks.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .user_agent("Palace")
        .http_status_as_error(false)
        .build()
        .into()
}

enum Method {
    Get,
    Post(serde_json::Value),
    // With no body, as for starring.
    Put,
    Delete,
}

/// GETs `path` from the GitHub API with the token, explaining failures in words.
pub(crate) fn api_get<T: serde::de::DeserializeOwned>(token: &str, path: &str) -> Result<T, String> {
    api(token, Method::Get, path)
}

/// Calls the GitHub API with the token. A reply with no body (as for a deletion)
/// reads as `()`.
fn api<T: serde::de::DeserializeOwned>(token: &str, method: Method, path: &str) -> Result<T, String> {
    api_as(token, method, path, "application/vnd.github+json")
}

/// GETs `path` with the Markdown in it (issues, comments) also rendered as HTML, in
/// `body_html`.
pub(crate) fn api_get_html<T: serde::de::DeserializeOwned>(token: &str, path: &str) -> Result<T, String> {
    api_as(token, Method::Get, path, "application/vnd.github.full+json")
}

fn api_as<T: serde::de::DeserializeOwned>(token: &str, method: Method, path: &str, accept: &str) -> Result<T, String> {
    let url = format!("https://api.github.com{path}");
    let auth = format!("Bearer {token}");
    let sent = match method {
        Method::Get => agent().get(&url).header("Accept", accept).header("Authorization", &auth).call(),
        Method::Delete => agent().delete(&url).header("Accept", accept).header("Authorization", &auth).call(),
        Method::Put => agent().put(&url).header("Accept", accept).header("Authorization", &auth).send_empty(),
        Method::Post(body) => agent().post(&url).header("Accept", accept).header("Authorization", &auth).send_json(&body),
    };
    let mut response = sent.map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
    let status = response.status().as_u16();
    if status == 204 {
        return serde_json::from_value(serde_json::Value::Null).map_err(|e| e.to_string());
    }
    let body: Option<serde_json::Value> = response.body_mut().read_json().ok();
    if (200..300).contains(&status) {
        let body = body.ok_or("GitHub's reply didn't make sense.")?;
        return serde_json::from_value(body).map_err(|e| format!("GitHub's reply didn't make sense: {e}"));
    }
    Err(explain(status, body.as_ref()))
}

/// Puts a refusal from GitHub into words. GitHub explains in "message", with any
/// details about invalid fields in "errors".
fn explain(status: u16, body: Option<&serde_json::Value>) -> String {
    if status == 401 {
        return "GitHub no longer accepts your token. Sign in again in Settings › GitHub.".into();
    }
    let text = |v: &serde_json::Value, key: &str| v.get(key).and_then(|m| m.as_str()).map(str::to_string);
    let Some(message) = body.and_then(|b| text(b, "message")) else {
        return format!("GitHub refused that (HTTP {status}).");
    };
    let details: Vec<String> = body
        .and_then(|b| b.get("errors"))
        .and_then(|e| e.as_array())
        .map(|errors| errors.iter().filter_map(|e| text(e, "message")).collect())
        .unwrap_or_default();
    if details.is_empty() {
        format!("GitHub said: {message}")
    } else {
        format!("GitHub said: {}: {}.", message.trim_end_matches('.'), details.join("; "))
    }
}

/// What the token is allowed to do, from its scopes; None for fine-grained tokens,
/// which don't list them.
#[tauri::command]
pub async fn github_scopes() -> Result<Option<Vec<String>>, String> {
    let token = saved().ok_or(NOT_SIGNED_IN)?.token;
    blocking(move || {
        let response = agent()
            .get("https://api.github.com/user")
            .header("Accept", "application/vnd.github+json")
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
        if response.status().as_u16() != 200 {
            return Err(explain(response.status().as_u16(), None));
        }
        let header = response.headers().get("x-oauth-scopes").and_then(|v| v.to_str().ok());
        Ok(header.map(|h| h.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()))
    })
    .await
}

/// Creates a repository for the signed-in account (`kind` "me") or an organization.
/// With `readme`, GitHub gives it a first commit, so it isn't empty when cloned.
#[tauri::command]
pub async fn github_create_repo(
    owner: String,
    kind: String,
    name: String,
    description: String,
    private: bool,
    readme: bool,
) -> Result<Repo, String> {
    let token = saved().ok_or(NOT_SIGNED_IN)?.token;
    let path = if kind == "me" { "/user/repos".to_string() } else { format!("/orgs/{owner}/repos") };
    let body = serde_json::json!({
        "name": name.trim(),
        "description": description.trim(),
        "private": private,
        "auto_init": readme,
    });
    blocking(move || api(&token, Method::Post(body), &path)).await
}

/// An SSH key on the signed-in GitHub account.
#[derive(Serialize, Deserialize, Debug)]
pub struct SshKey {
    id: u64,
    title: String,
    /// "ssh-ed25519 AAAA…", without a comment.
    key: String,
    created_at: Option<String>,
}

#[tauri::command]
pub async fn github_keys() -> Result<Vec<SshKey>, String> {
    let token = saved().ok_or(NOT_SIGNED_IN)?.token;
    blocking(move || api_get(&token, "/user/keys?per_page=100")).await
}

#[tauri::command]
pub async fn github_add_key(title: String, key: String) -> Result<SshKey, String> {
    let token = saved().ok_or(NOT_SIGNED_IN)?.token;
    let body = serde_json::json!({ "title": title.trim(), "key": key.trim() });
    blocking(move || api(&token, Method::Post(body), "/user/keys")).await
}

#[tauri::command]
pub async fn github_delete_key(id: u64) -> Result<(), String> {
    let token = saved().ok_or(NOT_SIGNED_IN)?.token;
    blocking(move || api(&token, Method::Delete, &format!("/user/keys/{id}"))).await
}

// Palace's own repository, which Palace asks people to star once.
const PALACE_REPO: &str = "timmcleod/palace";

/// Whether the signed-in account has starred Palace's repository. None when GitHub
/// won't say, as for fine-grained tokens without the starring permission.
#[tauri::command]
pub async fn github_starred_palace() -> Result<Option<bool>, String> {
    let token = saved().ok_or(NOT_SIGNED_IN)?.token;
    blocking(move || {
        let response = agent()
            .get(&format!("https://api.github.com/user/starred/{PALACE_REPO}"))
            .header("Accept", "application/vnd.github+json")
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
        Ok(starred_from(response.status().as_u16()))
    })
    .await
}

// GitHub answers 204 for starred and 404 for not; anything else means it won't say.
fn starred_from(status: u16) -> Option<bool> {
    match status {
        204 => Some(true),
        404 => Some(false),
        _ => None,
    }
}

/// Stars Palace's repository as the signed-in account.
#[tauri::command]
pub async fn github_star_palace() -> Result<(), String> {
    let token = saved().ok_or(NOT_SIGNED_IN)?.token;
    blocking(move || api(&token, Method::Put, &format!("/user/starred/{PALACE_REPO}"))).await
}

/// A public key in ~/.ssh, offered when adding a key to GitHub.
#[derive(Serialize, Debug, PartialEq)]
pub struct LocalKey {
    path: String,
    /// The type and key ("ssh-ed25519 AAAA…"), as GitHub lists them.
    key: String,
    /// The note at the end of the file, usually user@host.
    comment: String,
}

#[tauri::command]
pub async fn local_ssh_keys() -> Vec<LocalKey> {
    std::env::var_os("HOME").map(|home| read_public_keys(&std::path::Path::new(&home).join(".ssh"))).unwrap_or_default()
}

fn read_public_keys(dir: &std::path::Path) -> Vec<LocalKey> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut keys: Vec<LocalKey> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "pub"))
        .filter_map(|path| {
            let text = std::fs::read_to_string(&path).ok()?;
            let mut parts = text.split_whitespace();
            let (kind, data) = (parts.next()?, parts.next()?);
            if !(kind.starts_with("ssh-") || kind.starts_with("ecdsa-") || kind.starts_with("sk-")) {
                return None;
            }
            Some(LocalKey {
                path: path.to_string_lossy().into_owned(),
                key: format!("{kind} {data}"),
                comment: parts.collect::<Vec<_>>().join(" "),
            })
        })
        .collect();
    keys.sort_by(|a, b| a.path.cmp(&b.path));
    keys
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
    let mut response = agent()
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
    fn reading_whether_starred() {
        assert_eq!(starred_from(204), Some(true));
        assert_eq!(starred_from(404), Some(false));
        assert_eq!(starred_from(403), None);
    }

    #[test]
    fn explaining_refusals() {
        let body = serde_json::json!({
            "message": "Repository creation failed.",
            "errors": [{ "resource": "Repository", "field": "name", "message": "name already exists on this account" }]
        });
        assert_eq!(
            explain(422, Some(&body)),
            "GitHub said: Repository creation failed: name already exists on this account."
        );
        assert_eq!(explain(404, Some(&serde_json::json!({ "message": "Not Found" }))), "GitHub said: Not Found");
        assert_eq!(explain(500, None), "GitHub refused that (HTTP 500).");
        assert!(explain(401, None).starts_with("GitHub no longer accepts your token"));
    }

    #[test]
    fn finding_local_public_keys() {
        let dir = std::env::temp_dir().join(format!("palace-ssh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("id_ed25519.pub"), "ssh-ed25519 AAAAC3Nz tim@laptop\n").unwrap();
        std::fs::write(dir.join("id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();
        std::fs::write(dir.join("other.pub"), "not a key\n").unwrap();
        std::fs::write(dir.join("work.pub"), "ecdsa-sha2-nistp256 AAAAE2Vj\n").unwrap();

        let keys = read_public_keys(&dir);
        let found: Vec<_> = keys.iter().map(|k| (k.key.as_str(), k.comment.as_str())).collect();
        assert_eq!(found, [("ssh-ed25519 AAAAC3Nz", "tim@laptop"), ("ecdsa-sha2-nistp256 AAAAE2Vj", "")]);
        let _ = std::fs::remove_dir_all(dir);
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
