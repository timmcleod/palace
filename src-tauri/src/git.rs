use git2::{BranchType, ErrorCode, Repository, Sort};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct RepoOverview {
    name: String,
    path: String,
    head: Head,
    commit_count: Option<usize>,
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
    message: String,
}

#[derive(Serialize)]
pub struct Submodule {
    name: String,
    path: String,
}

#[tauri::command]
pub async fn repo_overview(path: String) -> Result<RepoOverview, String> {
    read_overview(Path::new(&path)).map_err(|e| e.message().to_string())
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
        // A freshly initialised repo has a HEAD that names a branch with no commits yet.
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
    tags.sort_by_key(|t| t.to_lowercase());
    Ok(tags)
}

fn read_stashes(repo: &mut Repository) -> Result<Vec<Stash>, git2::Error> {
    let mut stashes = Vec::new();
    repo.stash_foreach(|index, message, _| {
        stashes.push(Stash { index, message: message.to_string() });
        true
    })?;
    Ok(stashes)
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
