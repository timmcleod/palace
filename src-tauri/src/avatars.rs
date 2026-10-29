//! GitHub profile pictures for commit authors.
//!
//! Authors using GitHub's private noreply address are recognized from the address
//! alone. Anyone else is looked up through the GitHub API on the repository's own
//! GitHub remote: its recent commits link most authors to their accounts, and the
//! rest are asked about one by one. Results are remembered on disk, so each person is
//! only looked up once. Private repositories use the GitHub credentials git already
//! has, if any; without them, authors simply keep their initials.

use crate::cli;
use git2::{Repository, Sort};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// How many commits to read for the list of authors.
const AUTHOR_SCAN: usize = 3000;
/// Authors looked up one by one per request, so a big project can't use up the
/// hourly limit GitHub puts on API calls made without credentials.
const LOOKUPS: usize = 40;
/// How long to wait before asking again about someone who had no GitHub account.
const RETRY_MISSES: u64 = 7 * 24 * 60 * 60;

/// What's known about each author, by lowercased email address.
#[derive(Default)]
pub struct AvatarCache(Mutex<Option<HashMap<String, Entry>>>);

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Entry {
    /// None when the address isn't linked to a GitHub account.
    url: Option<String>,
    /// When it was looked up, in seconds since 1970.
    checked: u64,
}

#[derive(Serialize, Clone)]
struct Found {
    path: String,
    avatars: HashMap<String, String>,
}

/// Finds avatars for the repository's authors in the background, reporting them with
/// `avatars` events as they're found.
#[tauri::command]
pub fn github_avatars(app: AppHandle, path: String) -> Result<(), String> {
    let repo = Repository::discover(&path).map_err(|e| e.message().to_string())?;
    let emails = recent_authors(&repo);
    let github = github_remote(&repo);
    let workdir = cli::workdir(&path)?;
    drop(repo);

    std::thread::spawn(move || {
        let state = app.state::<AvatarCache>();
        let cache_file = app.path().app_cache_dir().ok().map(|dir| dir.join("avatars.json"));
        let report = |avatars: &HashMap<String, String>| {
            let _ = app.emit("avatars", Found { path: path.clone(), avatars: avatars.clone() });
        };

        let mut found = HashMap::new();
        let mut pending = Vec::new();
        {
            let mut guard = state.0.lock().unwrap();
            let cache = guard.get_or_insert_with(|| load(cache_file.as_ref()));
            for email in &emails {
                if let Some(url) = noreply_avatar(email) {
                    found.insert(email.clone(), url);
                } else {
                    match cache.get(email) {
                        Some(Entry { url: Some(url), .. }) => {
                            found.insert(email.clone(), url.clone());
                        }
                        Some(entry) if now() - entry.checked < RETRY_MISSES => {}
                        _ => pending.push(email.clone()),
                    }
                }
            }
        }
        report(&found);

        let Some((owner, name)) = github else { return };
        if pending.is_empty() {
            return;
        }

        let mut api = Api::new(github_token(&workdir));
        let mut learned = HashMap::new();
        let commits = format!("https://api.github.com/repos/{owner}/{name}/commits");

        // Recent commits on GitHub cover most authors in a single request.
        match api.get::<Vec<ApiCommit>>(&commits, &[("per_page", "100")]) {
            Some(list) => {
                for commit in list {
                    let email = commit.commit.author.email.to_lowercase();
                    learned.entry(email).or_insert(commit.author.map(|a| a.avatar_url));
                }
            }
            // The repository isn't reachable (private without credentials, offline,
            // rate limited): nothing more to try.
            None => return,
        }

        let mut asked = 0;
        for email in &pending {
            if learned.contains_key(email) {
                continue;
            }
            if asked == LOOKUPS {
                break;
            }
            asked += 1;
            match api.get::<Vec<ApiCommit>>(&commits, &[("author", email), ("per_page", "1")]) {
                Some(list) => {
                    let url = list.into_iter().next().and_then(|c| c.author).map(|a| a.avatar_url);
                    learned.insert(email.clone(), url);
                }
                None => break,
            }
        }

        let pending: HashSet<&String> = pending.iter().collect();
        for (email, url) in &learned {
            if let (true, Some(url)) = (pending.contains(email), url) {
                found.insert(email.clone(), url.clone());
            }
        }
        report(&found);

        let mut guard = state.0.lock().unwrap();
        let cache = guard.get_or_insert_with(HashMap::new);
        let checked = now();
        for (email, url) in learned {
            cache.insert(email, Entry { url, checked });
        }
        save(cache_file.as_ref(), cache);
    });
    Ok(())
}

/// Author addresses of recent commits on local branches, most recent first.
fn recent_authors(repo: &Repository) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut emails = Vec::new();
    let Ok(mut walk) = repo.revwalk() else { return emails };
    let _ = walk.set_sorting(Sort::TIME);
    let _ = walk.push_head();
    let _ = walk.push_glob("refs/heads");
    for oid in walk.flatten().take(AUTHOR_SCAN) {
        if let Ok(commit) = repo.find_commit(oid) {
            if let Ok(email) = commit.author().email() {
                let email = email.trim().to_lowercase();
                if !email.is_empty() && seen.insert(email.clone()) {
                    emails.push(email);
                }
            }
        }
    }
    emails
}

/// GitHub's private commit addresses name the account: 12345+login@… or login@….
fn noreply_avatar(email: &str) -> Option<String> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    match local.split_once('+') {
        Some((id, _)) if id.chars().all(|c| c.is_ascii_digit()) => {
            Some(format!("https://avatars.githubusercontent.com/u/{id}?v=4"))
        }
        _ => Some(format!("https://github.com/{local}.png")),
    }
}

/// The owner and name of the repository on GitHub, preferring origin.
fn github_remote(repo: &Repository) -> Option<(String, String)> {
    let remotes = repo.remotes().ok()?;
    let mut names: Vec<&str> = remotes.iter().flatten().flatten().collect();
    names.sort_by_key(|n| *n != "origin");
    names.into_iter().find_map(|n| repo.find_remote(n).ok()?.url().ok().and_then(parse_github_url))
}

/// Understands https://github.com/o/r(.git), git@github.com:o/r.git and
/// ssh://git@github.com/o/r.
fn parse_github_url(url: &str) -> Option<(String, String)> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.split_once('@').map_or(rest, |(_, r)| r);
    let rest = rest.strip_prefix("github.com")?;
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/'))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    (!owner.is_empty() && !name.is_empty() && !name.contains('/')).then(|| (owner.into(), name.into()))
}

/// A GitHub token from git's credential helpers (gh, a keyring, …), if one is stored.
/// Never prompts: without a stored credential, this gives up.
fn github_token(workdir: &PathBuf) -> Option<String> {
    let mut child = cli::command(workdir, &["credential", "fill"])
        .env("GIT_ASKPASS", "false")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(b"protocol=https\nhost=github.com\n\n").ok()?;
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("password="))
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

#[derive(Deserialize)]
struct ApiCommit {
    commit: ApiCommitDetails,
    author: Option<ApiUser>,
}

#[derive(Deserialize)]
struct ApiCommitDetails {
    author: ApiSignature,
}

#[derive(Deserialize)]
struct ApiSignature {
    email: String,
}

#[derive(Deserialize)]
struct ApiUser {
    avatar_url: String,
}

struct Api {
    agent: ureq::Agent,
    token: Option<String>,
}

impl Api {
    fn new(token: Option<String>) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .user_agent("Palace")
            .build();
        Api { agent: config.into(), token }
    }

    /// Gets JSON from the API, or None if the request fails for any reason.
    fn get<T: serde::de::DeserializeOwned>(&mut self, url: &str, query: &[(&str, &str)]) -> Option<T> {
        loop {
            let mut request = self.agent.get(url).header("Accept", "application/vnd.github+json");
            for (key, value) in query {
                request = request.query(*key, *value);
            }
            if let Some(token) = &self.token {
                request = request.header("Authorization", format!("Bearer {token}"));
            }
            match request.call() {
                Ok(mut response) => return response.body_mut().read_json().ok(),
                // A stale or unrelated stored credential: try again without it, which
                // still works for public repositories.
                Err(ureq::Error::StatusCode(401)) if self.token.is_some() => self.token = None,
                Err(_) => return None,
            }
        }
    }
}

fn load(file: Option<&PathBuf>) -> HashMap<String, Entry> {
    file.and_then(|f| std::fs::read(f).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(file: Option<&PathBuf>, cache: &HashMap<String, Entry>) {
    let Some(file) = file else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec(cache) {
        let _ = std::fs::write(file, json);
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    #[test]
    fn reading_github_remotes() {
        let expected = Some(("timmcleod".to_string(), "palace".to_string()));
        assert_eq!(parse_github_url("https://github.com/timmcleod/palace.git"), expected);
        assert_eq!(parse_github_url("https://github.com/timmcleod/palace"), expected);
        assert_eq!(parse_github_url("https://someone@github.com/timmcleod/palace/"), expected);
        assert_eq!(parse_github_url("git@github.com:timmcleod/palace.git"), expected);
        assert_eq!(parse_github_url("ssh://git@github.com/timmcleod/palace"), expected);
        assert_eq!(parse_github_url("https://gitlab.com/timmcleod/palace.git"), None);
        assert_eq!(parse_github_url("https://github.com/timmcleod"), None);
    }

    #[test]
    fn recognizing_noreply_addresses() {
        assert_eq!(
            noreply_avatar("12345+someone@users.noreply.github.com").as_deref(),
            Some("https://avatars.githubusercontent.com/u/12345?v=4")
        );
        assert_eq!(
            noreply_avatar("someone@users.noreply.github.com").as_deref(),
            Some("https://github.com/someone.png")
        );
        assert_eq!(noreply_avatar("someone@example.com"), None);
    }

    #[test]
    fn listing_recent_authors() {
        let t = TempRepo::new("avatar-authors");
        t.commit(&[("a.txt", Some("1"))], "first");
        t.commit(&[("a.txt", Some("2"))], "second");
        // Every TempRepo commit has the same author, so they're listed once.
        assert_eq!(recent_authors(&t.repo).len(), 1);

        t.repo.remote("origin", "git@github.com:timmcleod/palace.git").unwrap();
        assert_eq!(github_remote(&t.repo), Some(("timmcleod".into(), "palace".into())));
    }
}
