//! A GitHub repository's issues, for the Issues view: lists and searches them, and
//! reads one with its comments. GitHub renders their Markdown, so they look as they do
//! on the website.

use crate::github::{api_get, api_get_html, blocking, token};
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
    closed_at: Option<String>,
    html_url: String,
    /// The description, as HTML; only when reading one issue.
    #[serde(default)]
    body_html: Option<String>,
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

/// One page of the repository's issues matching `filters`, which are GitHub search
/// terms ("is:open label:bug crash"). Without words to match, the newest come first.
#[tauri::command]
pub async fn github_issues(owner: String, repo: String, filters: String, page: u32) -> Result<IssuePage, String> {
    let token = token()?;
    blocking(move || {
        let path = search_path(&owner, &repo, &filters, page);
        let found: SearchResults = api_get(&token, &path)?;
        Ok(IssuePage { total: found.total_count, issues: found.items })
    })
    .await
}

fn search_path(owner: &str, repo: &str, filters: &str, page: u32) -> String {
    let query = format!("repo:{owner}/{repo} is:issue {}", filters.trim());
    // Without any words, only qualifiers, best match means nothing; newest is
    // what GitHub's own list shows.
    let has_words = terms(filters).iter().any(|term| !term.contains(':'));
    let sort = if has_words { "" } else { "&sort=created&order=desc" };
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
fn encode(text: &str) -> String {
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
        let issue = api_get_html(&token, &format!("/repos/{owner}/{repo}/issues/{number}"))?;
        let mut comments = Vec::new();
        for page in 1..=30 {
            let path = format!("/repos/{owner}/{repo}/issues/{number}/comments?per_page=100&page={page}");
            let batch: Vec<Comment> = api_get_html(&token, &path)?;
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
        let info: RepoInfo = api_get(&token, &format!("/repos/{owner}/{repo}"))?;
        Ok(info.parent.map(|p| p.full_name))
    })
    .await
}

#[derive(Serialize, Debug)]
pub struct IssueFilters {
    labels: Vec<Label>,
    /// The people issues can be assigned to.
    assignees: Vec<Person>,
}

/// What the Issues view's filter menus offer.
#[tauri::command]
pub async fn github_issue_filters(owner: String, repo: String) -> Result<IssueFilters, String> {
    let token = token()?;
    blocking(move || {
        Ok(IssueFilters {
            labels: api_get(&token, &format!("/repos/{owner}/{repo}/labels?per_page=100"))?,
            assignees: api_get(&token, &format!("/repos/{owner}/{repo}/assignees?per_page=100"))?,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn searching_a_repository() {
        assert_eq!(
            search_path("tim", "palace", "is:open label:\"good first issue\"", 2),
            "/search/issues?q=repo%3Atim%2Fpalace%20is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22\
             &per_page=50&page=2&sort=created&order=desc"
        );
        // Words to match are sorted by how well they match.
        assert!(!search_path("tim", "palace", "is:open crash", 1).contains("sort="));
        assert_eq!(terms(r#"is:open  label:"good first issue" crash"#), ["is:open", r#"label:"good first issue""#, "crash"]);
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
