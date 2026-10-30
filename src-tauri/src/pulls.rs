//! GitHub pull requests: opening one for a branch, with its title and description
//! started from the branch's commits or the repository's template.

use crate::github::{Method, api, api_get, blocking, token};
use crate::issues::{TOKEN_HELP, encode};
use git2::Repository;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Debug)]
pub struct PullSummary {
    number: u64,
    title: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
}

#[derive(Serialize, Debug)]
pub struct BranchPull {
    /// The repository's default branch, which pull requests usually go into.
    default_branch: String,
    /// The open pull request from the branch, if there is one.
    pull: Option<PullSummary>,
}

#[derive(Deserialize)]
struct RepoDefaults {
    default_branch: String,
}

#[derive(Deserialize)]
struct BranchName {
    name: String,
}

/// owner/repo's default branch, and its open pull request from `head` ("branch", or
/// "owner:branch" for a branch in a fork), if there is one.
#[tauri::command]
pub async fn github_branch_pull(owner: String, repo: String, head: String) -> Result<BranchPull, String> {
    let token = token()?;
    blocking(move || {
        let info: RepoDefaults = api_get(&token, &format!("/repos/{owner}/{repo}")).map_err(plain)?;
        // GitHub only matches `head` written as "owner:branch".
        let head = if head.contains(':') { head } else { format!("{owner}:{head}") };
        let path = format!("/repos/{owner}/{repo}/pulls?state=open&per_page=1&head={}", encode(&head));
        let pulls: Vec<PullSummary> = api_get(&token, &path).map_err(plain)?;
        Ok(BranchPull { default_branch: info.default_branch, pull: pulls.into_iter().next() })
    })
    .await
}

/// owner/repo's branches on GitHub, for choosing where a pull request goes.
#[tauri::command]
pub async fn github_branches(owner: String, repo: String) -> Result<Vec<String>, String> {
    let token = token()?;
    blocking(move || {
        let branches: Vec<BranchName> = api_get(&token, &format!("/repos/{owner}/{repo}/branches?per_page=100")).map_err(plain)?;
        Ok(branches.into_iter().map(|b| b.name).collect())
    })
    .await
}

/// Opens a pull request into owner/repo's `base` branch from `head`.
#[tauri::command]
pub async fn github_create_pull(
    owner: String,
    repo: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<PullSummary, String> {
    let token = token()?;
    let fields = serde_json::json!({ "base": base, "head": head, "title": title.trim(), "body": body, "draft": draft });
    blocking(move || api(&token, Method::Post(fields), &format!("/repos/{owner}/{repo}/pulls")).map_err(plain)).await
}

/// The full messages of the commits on `head` that `base` doesn't have, newest first
/// and at most 100, for starting a pull request's title and description.
#[tauri::command]
pub async fn branch_commit_messages(path: String, base: String, head: String) -> Result<Vec<String>, String> {
    commit_messages(&path, &base, &head).map_err(|e| e.message().to_string())
}

fn commit_messages(path: &str, base: &str, head: &str) -> Result<Vec<String>, git2::Error> {
    let repo = Repository::discover(path)?;
    let mut walk = repo.revwalk()?;
    walk.push(repo.revparse_single(head)?.peel_to_commit()?.id())?;
    walk.hide(repo.revparse_single(base)?.peel_to_commit()?.id())?;
    let mut messages = Vec::new();
    for id in walk.take(100) {
        let commit = repo.find_commit(id?)?;
        messages.push(commit.message().unwrap_or_default().trim().to_string());
    }
    Ok(messages)
}

/// The repository's pull request template, if it has one: pull_request_template.md
/// in .github, the top folder or docs, however it's capitalized.
#[tauri::command]
pub async fn pull_request_template(path: String) -> Option<String> {
    let repo = Repository::discover(&path).ok()?;
    find_template(repo.workdir()?)
}

fn find_template(workdir: &Path) -> Option<String> {
    [".github", "", "docs"].iter().find_map(|dir| {
        let found = std::fs::read_dir(workdir.join(dir)).ok()?.flatten().find(|entry| {
            entry.file_name().to_str().is_some_and(|name| name.eq_ignore_ascii_case("pull_request_template.md"))
                && entry.path().is_file()
        })?;
        std::fs::read_to_string(found.path()).ok()
    })
}

/// GitHub's refusals about pull requests in plain words. Those about the token start
/// with TOKEN_HELP.
fn plain(error: String) -> String {
    if error.contains("Resource not accessible by personal access token") {
        format!(
            "{TOKEN_HELP}Your GitHub token isn't allowed to do that. Fine-grained tokens need the Pull requests \
             permission, set to Read and write, for this repository. Change it on GitHub, or sign in with a \
             classic token."
        )
    } else if error.contains("No commits between") {
        "There's nothing to merge: the branch has no commits that the base branch doesn't.".into()
    } else if error.contains("A pull request already exists") {
        "This branch already has an open pull request into that branch.".into()
    } else if error.contains("Draft pull requests are not supported") {
        "This repository doesn't allow draft pull requests. Create it as a regular one instead.".into()
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;
    use crate::cli::git;

    #[test]
    fn listing_a_branchs_own_commits() {
        let t = TempRepo::new("pull-commits");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        t.commit(&[("b.txt", Some("1\n"))], "Add b\n\nBecause.");
        t.commit(&[("c.txt", Some("1\n"))], "Add c");
        assert_eq!(commit_messages(t.path(), &main, "feature").unwrap(), ["Add c", "Add b\n\nBecause."]);
        assert!(commit_messages(t.path(), "no-such-branch", "feature").is_err());
    }

    #[test]
    fn finding_the_template() {
        let t = TempRepo::new("pull-template");
        assert_eq!(find_template(&t.dir), None);
        t.write(&[("docs/pull_request_template.md", Some("From docs\n"))]);
        assert_eq!(find_template(&t.dir).as_deref(), Some("From docs\n"));
        t.write(&[(".github/PULL_REQUEST_TEMPLATE.md", Some("## What\n"))]);
        assert_eq!(find_template(&t.dir).as_deref(), Some("## What\n"));
    }

    #[test]
    fn explaining_refusals() {
        assert!(plain("GitHub said: Validation Failed: No commits between main and x.".into()).starts_with("There's nothing"));
        assert!(plain("GitHub said: Resource not accessible by personal access token".into()).starts_with(TOKEN_HELP));
        assert_eq!(plain("GitHub said: Not Found".into()), "GitHub said: Not Found");
    }
}
