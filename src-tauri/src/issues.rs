//! A GitHub repository's issues, for the Issues view: lists and searches them, reads
//! one with its comments, and opens, comments on, edits, closes and labels them.
//! GitHub renders their Markdown, so they look as they do on the website.

use crate::github::{api, api_get, api_get_html, api_html, api_post_text, blocking, token, Method};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct Person {
    login: String,
    avatar_url: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Label {
    name: String,
    /// Six hex digits, without the "#".
    color: String,
    description: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Issue {
    number: u64,
    title: String,
    /// "open" or "closed".
    state: String,
    /// Why it was closed: "completed", "not_planned" or "duplicate"; or "reopened".
    state_reason: Option<String>,
    user: Option<Person>,
    #[serde(default)]
    labels: Vec<Label>,
    #[serde(default)]
    assignees: Vec<Person>,
    comments: u64,
    created_at: String,
    #[serde(default)]
    updated_at: Option<String>,
    closed_at: Option<String>,
    html_url: String,
    /// The description, as HTML and as written; only when reading one issue.
    #[serde(default)]
    body_html: Option<String>,
    #[serde(default)]
    body: Option<String>,
    /// Set when the number is a pull request's, as "#123" in a commit message can be.
    #[serde(default)]
    pull_request: Option<PullRequestInfo>,
    /// Whether a pull request is a draft.
    #[serde(default)]
    draft: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PullRequestInfo {
    merged_at: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct IssuePage {
    /// How many issues match, across all pages.
    total: u64,
    issues: Vec<Issue>,
}

#[derive(Deserialize)]
struct SearchResults {
    total_count: u64,
    items: Vec<Issue>,
}

/// GitHub's search allows 1,000 results, in pages of up to 100.
const PAGE_SIZE: u32 = 50;

/// One page of the repository's issues, or with `pulls`, its pull requests, matching
/// `filters`, which are GitHub search terms ("is:open label:bug crash"). Words to
/// match put the best matches first. Otherwise `sort` orders them by when they were
/// "created" (the default) or last "updated", newest first unless `oldest`.
#[tauri::command]
pub async fn github_issues(
    owner: String,
    repo: String,
    filters: String,
    page: u32,
    pulls: Option<bool>,
    sort: Option<String>,
    oldest: Option<bool>,
) -> Result<IssuePage, String> {
    let token = token()?;
    let pulls = pulls.unwrap_or(false);
    let order = match sort.as_deref() {
        Some(by @ ("created" | "updated")) => Some(Order { by, oldest: oldest.unwrap_or(false) }),
        Some(other) => return Err(format!("Issues can't be sorted by \"{other}\".")),
        None => None,
    };
    let path = search_path(&owner, &repo, if pulls { "pr" } else { "issue" }, &filters, page, order);
    blocking(move || {
        let found: SearchResults = api_get(&token, &path).map_err(|e| {
            let e = plain(e);
            if pulls { e.replace("the Issues permission", "the Pull requests permission").replace("'s issues", "'s pull requests") } else { e }
        })?;
        Ok(IssuePage { total: found.total_count, issues: found.items })
    })
    .await
}

/// How to order search results: `by` is "created" or "updated".
#[derive(Clone, Copy)]
struct Order<'a> {
    by: &'a str,
    oldest: bool,
}

/// `kind` is "issue" or "pr".
fn search_path(owner: &str, repo: &str, kind: &str, filters: &str, page: u32, order: Option<Order>) -> String {
    let query = format!("repo:{owner}/{repo} is:{kind} {}", filters.trim());
    // Without any words, only qualifiers, best match means nothing; newest is
    // what GitHub's own list shows.
    let has_words = terms(filters).iter().any(|term| !term.contains(':'));
    let sort = match order {
        _ if has_words => String::new(),
        Some(Order { by, oldest }) => format!("&sort={by}&order={}", if oldest { "asc" } else { "desc" }),
        None => "&sort=created&order=desc".into(),
    };
    format!("/search/issues?q={}&per_page={PAGE_SIZE}&page={page}{sort}", encode(&query))
}

/// Splits search terms at spaces, except within quotes ("label:\"good first issue\"").
fn terms(filters: &str) -> Vec<String> {
    let mut terms = vec![String::new()];
    let mut quoted = false;
    for c in filters.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                terms.push(String::new());
                continue;
            }
            _ => {}
        }
        terms.last_mut().unwrap().push(c);
    }
    terms.retain(|t| !t.is_empty());
    terms
}

/// Percent-encodes a query string value.
pub(crate) fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Comment {
    id: u64,
    user: Option<Person>,
    body_html: Option<String>,
    #[serde(default)]
    body: Option<String>,
    created_at: String,
    html_url: String,
    /// The commenter's role in the repository, such as "OWNER" or "CONTRIBUTOR".
    author_association: String,
}

#[derive(Serialize, Debug)]
pub struct IssueThread {
    issue: Issue,
    comments: Vec<Comment>,
}

/// An issue with its description and every comment, as HTML.
#[tauri::command]
pub async fn github_issue(owner: String, repo: String, number: u64) -> Result<IssueThread, String> {
    let token = token()?;
    blocking(move || {
        let issue = api_get_html(&token, &format!("/repos/{owner}/{repo}/issues/{number}")).map_err(plain)?;
        let mut comments = Vec::new();
        for page in 1..=30 {
            let path = format!("/repos/{owner}/{repo}/issues/{number}/comments?per_page=100&page={page}");
            let batch: Vec<Comment> = api_get_html(&token, &path).map_err(plain)?;
            let done = batch.len() < 100;
            comments.extend(batch);
            if done {
                break;
            }
        }
        Ok(IssueThread { issue, comments })
    })
    .await
}

#[derive(Deserialize)]
struct RepoInfo {
    parent: Option<Parent>,
    permissions: Option<Permissions>,
}

/// What the signed-in account may do in a repository.
#[derive(Deserialize, Default)]
struct Permissions {
    #[serde(default)]
    push: bool,
    #[serde(default)]
    triage: bool,
}

#[derive(Deserialize)]
struct Parent {
    full_name: String,
}

/// The repository a fork was made from, as "owner/repo", or None for one that isn't
/// a fork. A fork's issues are usually its parent's.
#[tauri::command]
pub async fn github_fork_parent(owner: String, repo: String) -> Result<Option<String>, String> {
    let token = token()?;
    blocking(move || {
        let info: RepoInfo = api_get(&token, &format!("/repos/{owner}/{repo}")).map_err(plain)?;
        Ok(info.parent.map(|p| p.full_name))
    })
    .await
}

#[derive(Serialize, Debug)]
pub struct IssueFilters {
    labels: Vec<Label>,
    /// The people issues can be assigned to.
    assignees: Vec<Person>,
    /// Whether the account can label, assign, close and edit anyone's issues, rather
    /// than only its own.
    can_triage: bool,
}

/// The repository's labels and assignable people, for the filter menus and for
/// labeling and assigning, and what the account may do with them.
#[tauri::command]
pub async fn github_issue_filters(owner: String, repo: String) -> Result<IssueFilters, String> {
    let token = token()?;
    blocking(move || {
        let info: RepoInfo = api_get(&token, &format!("/repos/{owner}/{repo}")).map_err(plain)?;
        let permissions = info.permissions.unwrap_or_default();
        Ok(IssueFilters {
            labels: api_get(&token, &format!("/repos/{owner}/{repo}/labels?per_page=100")).map_err(plain)?,
            assignees: api_get(&token, &format!("/repos/{owner}/{repo}/assignees?per_page=100")).unwrap_or_default(),
            can_triage: permissions.push || permissions.triage,
        })
    })
    .await
}

/// Opens an issue.
#[tauri::command]
pub async fn github_create_issue(owner: String, repo: String, title: String, body: String) -> Result<Issue, String> {
    let token = token()?;
    let fields = serde_json::json!({ "title": title.trim(), "body": body });
    blocking(move || api_html(&token, Method::Post(fields), &format!("/repos/{owner}/{repo}/issues")).map_err(plain)).await
}

/// Changes an issue: any of title, state ("open" or "closed") and state_reason
/// ("completed", "not_planned" or "reopened"). Labels, assignees and the description
/// have their own commands, which don't overwrite what others changed meanwhile.
#[tauri::command]
pub async fn github_update_issue(owner: String, repo: String, number: u64, changes: serde_json::Value) -> Result<Issue, String> {
    let token = token()?;
    let path = format!("/repos/{owner}/{repo}/issues/{number}");
    blocking(move || api_html(&token, Method::Patch(changes), &path).map_err(plain)).await
}

/// Adds or removes one label (`field` "labels") or assignee ("assignees"), leaving
/// any others as they are now on GitHub, whoever changed them.
#[tauri::command]
pub async fn github_toggle_issue(
    owner: String,
    repo: String,
    number: u64,
    field: String,
    name: String,
    add: bool,
) -> Result<Issue, String> {
    let token = token()?;
    let path = format!("/repos/{owner}/{repo}/issues/{number}");
    blocking(move || {
        let names = serde_json::json!({ field.as_str(): [name] });
        let changed = match (field.as_str(), add) {
            ("labels", true) => api::<serde_json::Value>(&token, Method::Post(names), &format!("{path}/labels")),
            ("labels", false) => api(&token, Method::Delete, &format!("{path}/labels/{}", encode(&name))),
            ("assignees", true) => api(&token, Method::Post(names), &format!("{path}/assignees")),
            ("assignees", false) => api(&token, Method::DeleteWith(names), &format!("{path}/assignees")),
            _ => return Err(format!("Unknown field “{field}”.")),
        };
        let issue: Issue = api_get_html(&token, &path).map_err(plain)?;
        // Someone else may have made the same change first.
        let has = match field.as_str() {
            "labels" => issue.labels.iter().any(|l| l.name == name),
            _ => issue.assignees.iter().any(|p| p.login.eq_ignore_ascii_case(&name)),
        };
        if has != add {
            changed.map_err(plain)?;
        }
        Ok(issue)
    })
    .await
}

/// Saves an issue's description, as long as it's still `was`, the text the editing
/// started from, so a change someone else saved meanwhile isn't overwritten.
#[tauri::command]
pub async fn github_edit_issue_body(owner: String, repo: String, number: u64, body: String, was: String) -> Result<Issue, String> {
    let token = token()?;
    let path = format!("/repos/{owner}/{repo}/issues/{number}");
    blocking(move || {
        let now: Issue = api_get_html(&token, &path).map_err(plain)?;
        unchanged(now.body.as_deref(), &was)?;
        api_html(&token, Method::Patch(serde_json::json!({ "body": body })), &path).map_err(plain)
    })
    .await
}

const EDITED_MEANWHILE: &str =
    "Someone changed this on GitHub while you were editing it. Copy what you wrote, then refresh to see their version.";

fn unchanged(now: Option<&str>, was: &str) -> Result<(), String> {
    let normal = |text: &str| text.replace("\r\n", "\n").trim_end().to_string();
    if normal(now.unwrap_or("")) == normal(was) { Ok(()) } else { Err(EDITED_MEANWHILE.into()) }
}

#[tauri::command]
pub async fn github_add_comment(owner: String, repo: String, number: u64, body: String) -> Result<Comment, String> {
    let token = token()?;
    let path = format!("/repos/{owner}/{repo}/issues/{number}/comments");
    blocking(move || api_html(&token, Method::Post(serde_json::json!({ "body": body })), &path).map_err(plain)).await
}

/// Saves a comment, as long as it's still `was`, as for the description.
#[tauri::command]
pub async fn github_edit_comment(owner: String, repo: String, id: u64, body: String, was: String) -> Result<Comment, String> {
    let token = token()?;
    let path = format!("/repos/{owner}/{repo}/issues/comments/{id}");
    blocking(move || {
        let now: Comment = api_get_html(&token, &path).map_err(plain)?;
        unchanged(now.body.as_deref(), &was)?;
        api_html(&token, Method::Patch(serde_json::json!({ "body": body })), &path).map_err(plain)
    })
    .await
}

#[tauri::command]
pub async fn github_delete_comment(owner: String, repo: String, id: u64) -> Result<(), String> {
    let token = token()?;
    let path = format!("/repos/{owner}/{repo}/issues/comments/{id}");
    blocking(move || api(&token, Method::Delete, &path).map_err(plain)).await
}

/// Markdown as GitHub will show it in the repository's issues, with "#123" and
/// "@name" linked, for the editor's Preview.
#[tauri::command]
pub async fn github_render_markdown(owner: String, repo: String, text: String) -> Result<String, String> {
    let token = token()?;
    let body = serde_json::json!({ "text": text, "mode": "gfm", "context": format!("{owner}/{repo}") });
    blocking(move || api_post_text(&token, "/markdown", body).map_err(plain)).await
}

/// Where the Issues view sends people whose token can't do what they asked.
pub const TOKEN_HELP: &str = "TOKEN: ";

/// GitHub's refusals about issues in plain words. Those about the token start with
/// TOKEN_HELP, so the Issues view can offer a way to change it.
fn plain(error: String) -> String {
    if error.contains("Resource not accessible by personal access token") {
        format!(
            "{TOKEN_HELP}Your GitHub token isn't allowed to do that. Fine-grained tokens need the Issues \
             permission, set to Read and write, for this repository. Change it on GitHub, or sign in with \
             a classic token."
        )
    } else if error.contains("cannot be searched") {
        format!(
            "{TOKEN_HELP}Your GitHub token can't see this repository's issues. Fine-grained tokens need this \
             repository and the Issues permission added. Change it on GitHub, or sign in with a classic token."
        )
    } else if error.contains("Issues are disabled") {
        "Issues are turned off for this repository on GitHub.".into()
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn searching_a_repository() {
        assert_eq!(
            search_path("tim", "palace", "issue", "is:open label:\"good first issue\"", 2, None),
            "/search/issues?q=repo%3Atim%2Fpalace%20is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22\
             &per_page=50&page=2&sort=created&order=desc"
        );
        // Words to match are sorted by how well they match.
        assert!(!search_path("tim", "palace", "pr", "is:open crash", 1, None).contains("sort="));
        assert!(search_path("tim", "palace", "pr", "", 1, None).contains("is%3Apr"));
        // Even when an order is chosen.
        let updated = Order { by: "updated", oldest: false };
        assert!(!search_path("tim", "palace", "issue", "is:open crash", 1, Some(updated)).contains("sort="));
        assert!(search_path("tim", "palace", "issue", "is:open", 1, Some(updated)).ends_with("&sort=updated&order=desc"));
        let oldest = Order { by: "created", oldest: true };
        assert!(search_path("tim", "palace", "issue", "", 1, Some(oldest)).ends_with("&sort=created&order=asc"));
        assert_eq!(terms(r#"is:open  label:"good first issue" crash"#), ["is:open", r#"label:"good first issue""#, "crash"]);
    }

    #[test]
    fn explaining_refusals_about_issues() {
        let refused = "GitHub said: Resource not accessible by personal access token".to_string();
        assert!(plain(refused).starts_with(TOKEN_HELP));
        let unsearchable = "GitHub said: Validation Failed: The listed users and repositories cannot be searched".to_string();
        assert!(plain(unsearchable).contains("can't see this repository's issues"));
        assert_eq!(plain("GitHub said: Issues are disabled for this repo".into()), "Issues are turned off for this repository on GitHub.");
        assert_eq!(plain("Couldn't reach GitHub: timeout".into()), "Couldn't reach GitHub: timeout");
    }

    #[test]
    fn reading_an_issue() {
        let issue: Issue = serde_json::from_value(serde_json::json!({
            "number": 7, "title": "Crash", "state": "open", "state_reason": null,
            "user": { "login": "octocat", "avatar_url": "https://a" },
            "labels": [{ "name": "bug", "color": "d73a4a", "description": null }],
            "assignees": [], "comments": 2, "created_at": "2026-10-01T00:00:00Z", "closed_at": null,
            "html_url": "https://github.com/tim/palace/issues/7", "body_html": "<p>Hi</p>",
            "reactions": { "total_count": 0 }
        }))
        .unwrap();
        assert_eq!(issue.number, 7);
        assert_eq!(issue.labels[0].name, "bug");
        assert_eq!(issue.body_html.as_deref(), Some("<p>Hi</p>"));
    }
}
