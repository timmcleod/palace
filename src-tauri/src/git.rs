use git2::{BranchType, ErrorClass, ErrorCode, Repository, Sort};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct RepoOverview {
    name: String,
    path: String,
    head: Head,
    commit_count: Option<usize>,
    /// Number of files with staged or unstaged changes.
    changes: usize,
    /// "merge", "rebase", "cherry-pick" or "revert" while one is in progress.
    operation: Option<&'static str>,
    conflicts: usize,
    branches: Vec<LocalBranch>,
    remotes: Vec<Remote>,
    tags: Vec<String>,
    stashes: Vec<Stash>,
    submodules: Vec<Submodule>,
}

#[derive(Serialize)]
pub struct Head {
    /// Branch name, or None when HEAD is detached.
    branch: Option<String>,
    /// Short hash of the commit HEAD points to, or None for a repo with no commits yet.
    short_id: Option<String>,
}

#[derive(Serialize)]
pub struct LocalBranch {
    name: String,
    is_head: bool,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
}

#[derive(Serialize)]
pub struct Remote {
    name: String,
    url: Option<String>,
    /// Branch names with the remote prefix removed, e.g. "main" rather than "origin/main".
    branches: Vec<String>,
}

#[derive(Serialize)]
pub struct Stash {
    index: usize,
    /// Git's full description, e.g. "On main: Try a new layout".
    message: String,
    /// The stash's commit, which holds the stashed changes.
    id: String,
    short_id: String,
    time: i64,
    /// The branch it was made on, and what it says without that prefix.
    branch: Option<String>,
    summary: String,
}

#[derive(Serialize)]
pub struct Submodule {
    name: String,
    path: String,
}

/// Starts the refusal for a folder that isn't in a repository, so Palace can offer to
/// create one there.
const NOT_A_REPOSITORY: &str = "NOT_A_REPOSITORY: ";

#[tauri::command]
pub async fn repo_overview(path: String) -> Result<RepoOverview, String> {
    let path = Path::new(&path);
    read_overview(path).map_err(|e| {
        let outside = e.class() == ErrorClass::Repository && e.code() == ErrorCode::NotFound && path.is_dir();
        format!("{}{}", if outside { NOT_A_REPOSITORY } else { "" }, e.message())
    })
}

/// Creates a repository in a folder. With git, so the user's settings for new ones
/// apply, such as what the first branch is called.
#[tauri::command]
pub async fn init_repo(path: String) -> Result<(), String> {
    crate::cli::git_in(Path::new(&path), &["init"]).map(drop)
}

fn read_overview(path: &Path) -> Result<RepoOverview, git2::Error> {
    let mut repo = Repository::discover(path)?;

    let root = repo.workdir().unwrap_or_else(|| repo.path()).to_path_buf();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());

    let head = read_head(&repo)?;
    let commit_count = count_commits(&repo);
    // A bare repository has no working copy to report on.
    let status = crate::working::read_status(&repo).unwrap_or_default();
    let changes = status.len();
    let conflicts = status.iter().filter(|f| f.is_conflicted()).count();
    let operation = crate::branch::operation(&repo);
    let branches = read_local_branches(&repo)?;
    let remotes = read_remotes(&repo)?;
    let tags = read_tags(&repo)?;
    let submodules = read_submodules(&repo);
    let stashes = read_stashes(&mut repo)?;

    Ok(RepoOverview {
        name,
        // workdir() ends in a separator; drop it so the same repo always has one path.
        path: root.components().collect::<std::path::PathBuf>().to_string_lossy().into_owned(),
        head,
        commit_count,
        changes,
        operation,
        conflicts,
        branches,
        remotes,
        tags,
        stashes,
        submodules,
    })
}

fn read_head(repo: &Repository) -> Result<Head, git2::Error> {
    match repo.head() {
        Ok(head) => Ok(Head {
            branch: head.is_branch().then(|| head.shorthand().unwrap_or("").to_string()),
            short_id: head.target().map(|oid| oid.to_string()[..7].to_string()),
        }),
        // A freshly initialized repo has a HEAD that names a branch with no commits yet.
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            let branch = repo
                .find_reference("HEAD")?
                .symbolic_target()?
                .and_then(|t| t.strip_prefix("refs/heads/"))
                .map(str::to_string);
            Ok(Head { branch, short_id: None })
        }
        Err(e) => Err(e),
    }
}

fn count_commits(repo: &Repository) -> Option<usize> {
    let mut walk = repo.revwalk().ok()?;
    walk.set_sorting(Sort::NONE).ok()?;
    walk.push_head().ok()?;
    Some(walk.count())
}

fn read_local_branches(repo: &Repository) -> Result<Vec<LocalBranch>, git2::Error> {
    let mut branches = Vec::new();

    for entry in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = entry?;
        let Some(name) = branch.name()?.map(str::to_string) else {
            continue;
        };

        let mut upstream_name = None;
        let (mut ahead, mut behind) = (0, 0);
        if let Ok(upstream) = branch.upstream() {
            upstream_name = upstream.name()?.map(str::to_string);
            if let (Some(local), Some(remote)) = (branch.get().target(), upstream.get().target()) {
                (ahead, behind) = repo.graph_ahead_behind(local, remote)?;
            }
        }

        branches.push(LocalBranch {
            name,
            is_head: branch.is_head(),
            upstream: upstream_name,
            ahead,
            behind,
        });
    }

    branches.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(branches)
}

fn read_remotes(repo: &Repository) -> Result<Vec<Remote>, git2::Error> {
    let mut remotes: Vec<Remote> = Vec::new();

    for name in repo.remotes()?.iter() {
        let Some(name) = name? else { continue };
        let url = repo.find_remote(name)?.url().ok().map(str::to_string);
        remotes.push(Remote { name: name.to_string(), url, branches: Vec::new() });
    }

    for entry in repo.branches(Some(BranchType::Remote))? {
        let (branch, _) = entry?;
        // Skip the symbolic origin/HEAD pointer; it isn't a real branch.
        if branch.get().symbolic_target()?.is_some() {
            continue;
        }
        let Some(full) = branch.name()? else { continue };

        // Match the longest remote name, since remote names may themselves contain slashes.
        let owner = remotes
            .iter_mut()
            .filter(|r| full.starts_with(&format!("{}/", r.name)))
            .max_by_key(|r| r.name.len());
        if let Some(remote) = owner {
            let short = full[remote.name.len() + 1..].to_string();
            remote.branches.push(short);
        }
    }

    for remote in &mut remotes {
        remote.branches.sort_by_key(|b| b.to_lowercase());
    }
    Ok(remotes)
}

fn read_tags(repo: &Repository) -> Result<Vec<String>, git2::Error> {
    let mut tags = Vec::new();
    for tag in repo.tag_names(None)?.iter() {
        if let Some(tag) = tag? {
            tags.push(tag.to_string());
        }
    }
    // Newest version first: v0.10.0 before v0.2.0, and v1.0.0 before both.
    tags.sort_by(|a, b| natural_order(b, a));
    Ok(tags)
}

/// Compares names with the numbers in them as numbers ("v0.2" before "v0.10"), and the
/// rest regardless of case.
fn natural_order(a: &str, b: &str) -> std::cmp::Ordering {
    // Runs of digits, and runs of everything else.
    fn chunks(s: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let mut start = 0;
        let bytes = s.as_bytes();
        for i in 1..=bytes.len() {
            if i == bytes.len() || bytes[i].is_ascii_digit() != bytes[start].is_ascii_digit() {
                out.push(&s[start..i]);
                start = i;
            }
        }
        out
    }
    let (left, right) = (chunks(a), chunks(b));
    for (x, y) in left.iter().zip(&right) {
        let order = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(m), Ok(n)) => m.cmp(&n),
            _ => x.to_lowercase().cmp(&y.to_lowercase()),
        };
        if order.is_ne() {
            return order;
        }
    }
    left.len().cmp(&right.len()).then_with(|| a.cmp(b))
}

fn read_stashes(repo: &mut Repository) -> Result<Vec<Stash>, git2::Error> {
    let mut found = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        found.push((index, message.to_string(), *oid));
        true
    })?;

    let mut stashes = Vec::new();
    for (index, message, oid) in found {
        let time = repo.find_commit(oid).map(|c| c.time().seconds()).unwrap_or(0);
        let (branch, summary) = split_stash_message(&message);
        stashes.push(Stash {
            index,
            id: oid.to_string(),
            short_id: oid.to_string()[..7].to_string(),
            time,
            branch,
            summary,
            message,
        });
    }
    Ok(stashes)
}

/// Git describes stashes as "On <branch>: <message>" when named, or
/// "WIP on <branch>: <commit> <summary>" when not.
fn split_stash_message(message: &str) -> (Option<String>, String) {
    let Some((prefix, rest)) = message.split_once(": ") else { return (None, message.to_string()) };
    match prefix.strip_prefix("WIP on ").or_else(|| prefix.strip_prefix("On ")) {
        Some("(no branch)") => (None, rest.to_string()),
        Some(branch) => (Some(branch.to_string()), rest.to_string()),
        None => (None, message.to_string()),
    }
}

fn read_submodules(repo: &Repository) -> Vec<Submodule> {
    // A broken .gitmodules shouldn't stop the rest of the sidebar from loading.
    repo.submodules()
        .map(|subs| {
            subs.iter()
                .map(|s| Submodule {
                    name: s.name().unwrap_or("").to_string(),
                    path: s.path().to_string_lossy().into_owned(),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offering_to_create_a_repository() {
        let dir = std::env::temp_dir().join(format!("palace-test-not-a-repository-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().into_owned();

        let refused = tauri::async_runtime::block_on(repo_overview(path.clone())).err().unwrap();
        assert!(refused.starts_with(NOT_A_REPOSITORY), "{refused}");
        // A folder that's gone isn't one to create a repository in.
        let gone = tauri::async_runtime::block_on(repo_overview(format!("{path}/gone"))).err().unwrap();
        assert!(!gone.starts_with(NOT_A_REPOSITORY), "{gone}");

        tauri::async_runtime::block_on(init_repo(path.clone())).unwrap();
        let overview = tauri::async_runtime::block_on(repo_overview(path)).unwrap();
        assert_eq!(overview.commit_count, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ordering_versions_naturally() {
        let mut tags = vec!["v0.1.5", "v0.10.0", "v0.2.0", "v1.3.0", "v0.10.2", "release-2", "release-10"];
        tags.sort_by(|a, b| natural_order(b, a));
        assert_eq!(tags, ["v1.3.0", "v0.10.2", "v0.10.0", "v0.2.0", "v0.1.5", "release-10", "release-2"]);
    }

    #[test]
    fn reading_stash_messages() {
        assert_eq!(split_stash_message("On main: Try a layout"), (Some("main".into()), "Try a layout".into()));
        assert_eq!(
            split_stash_message("WIP on feature/x: abc1234 Fix it"),
            (Some("feature/x".into()), "abc1234 Fix it".into())
        );
        assert_eq!(split_stash_message("WIP on (no branch): abc1234 Fix"), (None, "abc1234 Fix".into()));
        assert_eq!(split_stash_message("Custom: thing"), (None, "Custom: thing".into()));
    }
}
