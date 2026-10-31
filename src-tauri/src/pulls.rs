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
        // A page at a time, up to a thousand.
        let mut names = Vec::new();
        for page in 1..=10 {
            let branches: Vec<BranchName> =
                api_get(&token, &format!("/repos/{owner}/{repo}/branches?per_page=100&page={page}")).map_err(plain)?;
            let last = branches.len() < 100;
            names.extend(branches.into_iter().map(|b| b.name));
            if last {
                break;
            }
        }
        Ok(names)
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

/// Where a pull request stands for merging, and what merging it would write.
#[derive(Serialize, Debug)]
pub struct MergeState {
    /// GitHub's GraphQL id, for marking a draft ready.
    node_id: String,
    draft: bool,
    merged: bool,
    /// GitHub's verdict: "clean", "unstable" (checks haven't passed but aren't
    /// required), "dirty" (conflicts), "blocked", "behind", "draft", "has_hooks" or
    /// "unknown" while it's still working it out.
    mergeable_state: String,
    base: String,
    head: String,
    /// The repository the head branch is in, as "owner/repo".
    head_repo: Option<String>,
    head_sha: String,
    /// The ways the repository allows: "merge", "squash" and "rebase".
    methods: Vec<&'static str>,
    /// Whether the account may merge into the repository.
    can_merge: bool,
    /// Whether GitHub deletes the head branch itself after merging.
    deletes_branch: bool,
    checks: Option<Checks>,
    /// The commit title and message GitHub would write, for a merge commit and for a
    /// squash, as the repository's settings say.
    merge_title: String,
    merge_message: String,
    squash_title: String,
    squash_message: String,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Checks {
    passed: usize,
    failed: usize,
    pending: usize,
}

#[derive(Deserialize)]
struct Pull {
    number: u64,
    node_id: String,
    title: String,
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    merged: bool,
    mergeable: Option<bool>,
    #[serde(default)]
    mergeable_state: String,
    head: PullBranch,
    base: PullBranch,
}

#[derive(Deserialize)]
struct PullBranch {
    #[serde(rename = "ref")]
    name: String,
    sha: String,
    /// "owner:branch".
    label: String,
    repo: Option<RepoName>,
}

#[derive(Deserialize)]
struct RepoName {
    full_name: String,
}

/// A repository's merge settings. Those about commit messages are only there for
/// accounts that can merge; GitHub's defaults stand in for the others.
#[derive(Deserialize, Default)]
#[serde(default)]
struct MergeSettings {
    allow_merge_commit: Option<bool>,
    allow_squash_merge: Option<bool>,
    allow_rebase_merge: Option<bool>,
    delete_branch_on_merge: bool,
    merge_commit_title: Option<String>,
    merge_commit_message: Option<String>,
    squash_merge_commit_title: Option<String>,
    squash_merge_commit_message: Option<String>,
    permissions: Option<Permissions>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Permissions {
    push: bool,
}

#[derive(Deserialize)]
struct PullCommit {
    commit: CommitMessage,
}

#[derive(Deserialize)]
struct CommitMessage {
    message: String,
}

#[derive(Deserialize)]
struct CheckRuns {
    check_runs: Vec<CheckRun>,
}

#[derive(Deserialize)]
struct CheckRun {
    status: String,
    conclusion: Option<String>,
}

#[derive(Deserialize)]
struct CombinedStatus {
    statuses: Vec<Status>,
}

#[derive(Deserialize)]
struct Status {
    state: String,
}

/// Whether pull request `number` can be merged, how, and with what message.
#[tauri::command]
pub async fn github_merge_state(owner: String, repo: String, number: u64) -> Result<MergeState, String> {
    let token = token()?;
    blocking(move || {
        let path = format!("/repos/{owner}/{repo}/pulls/{number}");
        let mut pull: Pull = api_get(&token, &path).map_err(plain)?;
        // GitHub works mergeability out in the background after changes; it's
        // usually ready a moment later.
        for _ in 0..3 {
            if pull.mergeable.is_some() || pull.merged {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1500));
            pull = api_get(&token, &path).map_err(plain)?;
        }
        let settings: MergeSettings = api_get(&token, &format!("/repos/{owner}/{repo}")).map_err(plain)?;
        let commits: Vec<PullCommit> = api_get(&token, &format!("{path}/commits?per_page=100")).unwrap_or_default();
        let messages: Vec<String> = commits.into_iter().map(|c| c.commit.message).collect();
        let checks = read_checks(&token, &owner, &repo, &pull.head.sha);
        Ok(merge_state(pull, &settings, &messages, checks))
    })
    .await
}

fn merge_state(pull: Pull, settings: &MergeSettings, messages: &[String], checks: Option<Checks>) -> MergeState {
    let allowed = |setting: Option<bool>| setting.unwrap_or(true);
    let methods = [
        (allowed(settings.allow_merge_commit), "merge"),
        (allowed(settings.allow_squash_merge), "squash"),
        (allowed(settings.allow_rebase_merge), "rebase"),
    ]
    .into_iter()
    .filter_map(|(on, method)| on.then_some(method))
    .collect();
    let (merge_title, merge_message, squash_title, squash_message) = commit_texts(&pull, settings, messages);
    let name = |branch: &PullBranch| branch.repo.as_ref().map(|r| r.full_name.to_lowercase());
    let same_repo = name(&pull.head).is_some() && name(&pull.head) == name(&pull.base);
    MergeState {
        node_id: pull.node_id,
        draft: pull.draft,
        merged: pull.merged,
        mergeable_state: if pull.mergeable.is_none() && !pull.merged { "unknown".into() } else { pull.mergeable_state },
        base: pull.base.name,
        head: pull.head.name,
        head_repo: pull.head.repo.map(|r| r.full_name),
        head_sha: pull.head.sha,
        methods,
        can_merge: settings.permissions.as_ref().is_some_and(|p| p.push),
        // Only for branches in the repository itself, not in forks.
        deletes_branch: settings.delete_branch_on_merge && same_repo,
        checks,
        merge_title,
        merge_message,
        squash_title,
        squash_message,
    }
}

/// The titles and messages GitHub writes for a merge commit and a squash, following
/// the repository's settings, or GitHub's defaults where it doesn't say.
fn commit_texts(pull: &Pull, settings: &MergeSettings, messages: &[String]) -> (String, String, String, String) {
    let numbered = format!("{} (#{})", pull.title, pull.number);
    let body = pull.body.clone().unwrap_or_default();
    let merge_title = match settings.merge_commit_title.as_deref() {
        Some("PR_TITLE") => numbered.clone(),
        _ => format!("Merge pull request #{} from {}", pull.number, pull.head.label.replacen(':', "/", 1)),
    };
    let merge_message = match settings.merge_commit_message.as_deref() {
        Some("PR_BODY") => body.clone(),
        Some("BLANK") => String::new(),
        _ => pull.title.clone(),
    };
    let subject = |message: &String| message.lines().next().unwrap_or_default().to_string();
    let squash_title = match (settings.squash_merge_commit_title.as_deref(), messages) {
        (Some("PR_TITLE"), _) | (_, [] | [_, _, ..]) => numbered,
        (_, [only]) => format!("{} (#{})", subject(only), pull.number),
    };
    let squash_message = match (settings.squash_merge_commit_message.as_deref(), messages) {
        (Some("PR_BODY"), _) => body,
        (Some("BLANK"), _) => String::new(),
        (_, [only]) => only.lines().skip(1).collect::<Vec<_>>().join("\n").trim().to_string(),
        (_, many) => many.iter().map(|m| format!("* {}", m.trim())).collect::<Vec<_>>().join("\n\n"),
    };
    (merge_title, merge_message, squash_title, squash_message)
}

/// How the head commit's checks and statuses stand, or None when the token can't
/// read them.
fn read_checks(token: &str, owner: &str, repo: &str, sha: &str) -> Option<Checks> {
    let runs: Option<CheckRuns> = api_get(token, &format!("/repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100")).ok();
    let statuses: Option<CombinedStatus> = api_get(token, &format!("/repos/{owner}/{repo}/commits/{sha}/status")).ok();
    if runs.is_none() && statuses.is_none() {
        return None;
    }
    let mut checks = Checks::default();
    for run in runs.map(|r| r.check_runs).unwrap_or_default() {
        match (run.status.as_str(), run.conclusion.as_deref()) {
            ("completed", Some("success" | "neutral" | "skipped")) => checks.passed += 1,
            ("completed", _) => checks.failed += 1,
            _ => checks.pending += 1,
        }
    }
    for status in statuses.map(|s| s.statuses).unwrap_or_default() {
        match status.state.as_str() {
            "success" => checks.passed += 1,
            "pending" => checks.pending += 1,
            _ => checks.failed += 1,
        }
    }
    Some(checks)
}

#[derive(Deserialize, Serialize)]
pub struct Merged {
    sha: String,
}

/// Merges pull request `number` by `method` ("merge", "squash" or "rebase"), as long
/// as its head is still `sha`. A rebase takes no title or message.
#[tauri::command]
pub async fn github_merge_pull(
    owner: String,
    repo: String,
    number: u64,
    method: String,
    title: Option<String>,
    message: Option<String>,
    sha: String,
) -> Result<Merged, String> {
    let token = token()?;
    let mut fields = serde_json::json!({ "merge_method": method, "sha": sha });
    if let Some(title) = title {
        fields["commit_title"] = title.trim().into();
    }
    if let Some(message) = message {
        fields["commit_message"] = message.into();
    }
    let path = format!("/repos/{owner}/{repo}/pulls/{number}/merge");
    blocking(move || api(&token, Method::Put(Some(fields)), &path).map_err(plain)).await
}

#[derive(Deserialize)]
struct GraphQlReply {
    #[serde(default)]
    errors: Vec<GraphQlError>,
}

#[derive(Deserialize)]
struct GraphQlError {
    message: String,
}

/// Marks a draft pull request ready for review. Only GitHub's GraphQL API can.
#[tauri::command]
pub async fn github_ready_for_review(node_id: String) -> Result<(), String> {
    let token = token()?;
    let query = "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }";
    let fields = serde_json::json!({ "query": query, "variables": { "id": node_id } });
    blocking(move || {
        let reply: GraphQlReply = api(&token, Method::Post(fields), "/graphql").map_err(plain)?;
        match reply.errors.first() {
            Some(error) => Err(plain(format!("GitHub said: {}", error.message))),
            None => Ok(()),
        }
    })
    .await
}

/// Renames a branch on GitHub, which moves its open pull requests to the new name.
#[tauri::command]
pub async fn github_rename_branch(owner: String, repo: String, branch: String, new_name: String) -> Result<(), String> {
    let token = token()?;
    let fields = serde_json::json!({ "new_name": new_name.trim() });
    let path = format!("/repos/{owner}/{repo}/branches/{}/rename", encode_branch(&branch));
    // Renaming is about the repository's contents rather than its pull requests.
    let plain = |e| plain(e).replace("the Pull requests permission", "the Contents permission");
    blocking(move || api::<serde_json::Value>(&token, Method::Post(fields), &path).map(drop).map_err(plain)).await
}

#[derive(Deserialize)]
struct GitRef {
    object: GitObject,
}

#[derive(Deserialize)]
struct GitObject {
    sha: String,
}

/// Deletes a branch on GitHub, as after merging its pull request: only while it's
/// still at `sha`, the commit that was merged, so nothing pushed since is lost.
#[tauri::command]
pub async fn github_delete_branch(owner: String, repo: String, branch: String, sha: String) -> Result<(), String> {
    let token = token()?;
    let path = format!("/repos/{owner}/{repo}/git/refs/heads/{}", encode_branch(&branch));
    let one = format!("/repos/{owner}/{repo}/git/ref/heads/{}", encode_branch(&branch));
    blocking(move || {
        let now: GitRef = api_get(&token, &one).map_err(plain)?;
        if now.object.sha != sha {
            return Err(format!("{branch} has commits pushed since it was merged, so it's been kept on GitHub."));
        }
        api(&token, Method::Delete, &path).map_err(plain)
    })
    .await
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

/// A branch name for a URL path: each part percent-encoded, keeping the slashes
/// between them, so a "#" or "?" in a name can't cut it short.
fn encode_branch(branch: &str) -> String {
    branch.split('/').map(encode).collect::<Vec<_>>().join("/")
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
    } else if error.contains("Head branch was modified") {
        "The branch has changed since this was loaded. Look over the new commits, then merge again.".into()
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

    fn pull(title: &str) -> Pull {
        let branch = |name: &str| PullBranch { name: name.into(), sha: "abc".into(), label: format!("tim:{name}"), repo: None };
        Pull {
            number: 7,
            node_id: "PR_1".into(),
            title: title.into(),
            body: Some("Adds it.".into()),
            draft: false,
            merged: false,
            mergeable: Some(true),
            mergeable_state: "clean".into(),
            head: branch("dark-mode"),
            base: branch("main"),
        }
    }

    #[test]
    fn writing_merge_messages_as_github_does() {
        let defaults = MergeSettings::default();
        let one = ["Add a toggle\n\nIn the toolbar.".to_string()];
        let (merge_title, merge_message, squash_title, squash_message) = commit_texts(&pull("Dark mode"), &defaults, &one);
        assert_eq!(merge_title, "Merge pull request #7 from tim/dark-mode");
        assert_eq!(merge_message, "Dark mode");
        assert_eq!(squash_title, "Add a toggle (#7)");
        assert_eq!(squash_message, "In the toolbar.");

        let two = ["Add colors".to_string(), "Add a toggle\n\nIn the toolbar.".to_string()];
        let (_, _, squash_title, squash_message) = commit_texts(&pull("Dark mode"), &defaults, &two);
        assert_eq!(squash_title, "Dark mode (#7)");
        assert_eq!(squash_message, "* Add colors\n\n* Add a toggle\n\nIn the toolbar.");

        let settings = MergeSettings {
            merge_commit_title: Some("PR_TITLE".into()),
            merge_commit_message: Some("PR_BODY".into()),
            squash_merge_commit_message: Some("BLANK".into()),
            ..Default::default()
        };
        let (merge_title, merge_message, _, squash_message) = commit_texts(&pull("Dark mode"), &settings, &two);
        assert_eq!((merge_title.as_str(), merge_message.as_str(), squash_message.as_str()), ("Dark mode (#7)", "Adds it.", ""));
    }

    #[test]
    fn offering_the_allowed_ways_to_merge() {
        let settings = MergeSettings { allow_merge_commit: Some(false), permissions: Some(Permissions { push: true }), ..Default::default() };
        let state = merge_state(pull("Dark mode"), &settings, &[], None);
        assert_eq!(state.methods, ["squash", "rebase"]);
        assert!(state.can_merge);
        let unknown = Pull { mergeable: None, ..pull("Dark mode") };
        assert_eq!(merge_state(unknown, &settings, &[], None).mergeable_state, "unknown");
    }

    #[test]
    fn encoding_branch_names_for_urls() {
        assert_eq!(encode_branch("feature/fix#12?"), "feature/fix%2312%3F");
    }

    #[test]
    fn github_deletes_only_its_own_branches_after_merging() {
        let settings = MergeSettings { delete_branch_on_merge: true, ..Default::default() };
        let in_repo = |owner: &str| Some(RepoName { full_name: format!("{owner}/lantern") });
        let mut own = pull("Dark mode");
        own.head.repo = in_repo("tim");
        own.base.repo = in_repo("tim");
        assert!(merge_state(own, &settings, &[], None).deletes_branch);
        let mut forked = pull("Dark mode");
        forked.head.repo = in_repo("maya");
        forked.base.repo = in_repo("tim");
        assert!(!merge_state(forked, &settings, &[], None).deletes_branch);
    }

    #[test]
    fn explaining_refusals() {
        assert!(plain("GitHub said: Validation Failed: No commits between main and x.".into()).starts_with("There's nothing"));
        assert!(plain("GitHub said: Resource not accessible by personal access token".into()).starts_with(TOKEN_HELP));
        assert_eq!(plain("GitHub said: Not Found".into()), "GitHub said: Not Found");
    }
}
