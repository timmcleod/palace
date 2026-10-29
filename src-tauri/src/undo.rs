//! Undo and redo. Before and after each operation that moves branches or tags, the UI
//! takes a snapshot of where they all point and which branch HEAD is on; undoing puts
//! the repository back from the second snapshot to the first, and redoing does the
//! opposite. Only what the operation changed is touched, and only if nothing else
//! has changed it since.

use crate::cli::git;
use git2::{BranchType, Repository, RepositoryState};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Refs {
    /// The branch HEAD is on, or None when it's detached.
    head_branch: Option<String>,
    /// The commit HEAD is at; None on a branch with no commits yet.
    head_id: Option<String>,
    /// Every local branch and tag, by full ref name, with the object it points at.
    refs: BTreeMap<String, String>,
    /// Each local branch's upstream as its config has it: (remote, merge).
    upstreams: BTreeMap<String, (String, String)>,
}

#[tauri::command]
pub async fn ref_snapshot(path: String) -> Result<Refs, String> {
    snapshot(&path).map_err(|e| e.message().to_string())
}

/// Moves the repository from the `from` snapshot to the `to` one. `mode` says what
/// happens to the index and files when HEAD's own branch moves: "soft" keeps both
/// (undoing a commit leaves its changes staged), "mixed" keeps the files, and "keep"
/// updates the files as `git reset --keep` does, keeping uncommitted changes.
#[tauri::command]
pub async fn restore_refs(path: String, from: Refs, to: Refs, mode: String) -> Result<String, String> {
    restore(&path, &from, &to, &mode)
}

fn snapshot(path: &str) -> Result<Refs, git2::Error> {
    let repo = Repository::discover(path)?;
    let head = repo.find_reference("HEAD")?;
    let head_branch = head.symbolic_target().ok().flatten().and_then(|t| t.strip_prefix("refs/heads/")).map(str::to_string);
    let head_id = repo.head().ok().and_then(|h| h.target()).map(|id| id.to_string());

    let mut refs = BTreeMap::new();
    for glob in ["refs/heads/*", "refs/tags/*"] {
        for reference in repo.references_glob(glob)?.flatten() {
            if let (Ok(name), Some(id)) = (reference.name(), reference.target()) {
                refs.insert(name.to_string(), id.to_string());
            }
        }
    }

    let config = repo.config()?.snapshot()?;
    let mut upstreams = BTreeMap::new();
    for branch in repo.branches(Some(BranchType::Local))?.flatten() {
        let Some(name) = branch.0.name()?.map(str::to_string) else { continue };
        let remote = config.get_string(&format!("branch.{name}.remote"));
        let merge = config.get_string(&format!("branch.{name}.merge"));
        if let (Ok(remote), Ok(merge)) = (remote, merge) {
            upstreams.insert(name, (remote, merge));
        }
    }

    Ok(Refs { head_branch, head_id, refs, upstreams })
}

fn restore(path: &str, from: &Refs, to: &Refs, mode: &str) -> Result<String, String> {
    if !["soft", "mixed", "keep"].contains(&mode) {
        return Err(format!("Unknown mode “{mode}”."));
    }
    let repo = Repository::discover(path).map_err(|e| e.message().to_string())?;
    if repo.state() != RepositoryState::Clean {
        return Err("Finish or abort the merge, rebase or other operation in progress first.".into());
    }
    let now = snapshot(path).map_err(|e| e.message().to_string())?;

    // Everything the operation changed has to be as it left it.
    let changed: BTreeSet<&String> = from
        .refs
        .keys()
        .chain(to.refs.keys())
        .filter(|name| from.refs.get(*name) != to.refs.get(*name))
        .collect();
    for name in &changed {
        if now.refs.get(*name) != from.refs.get(*name) {
            return Err(format!("{} has changed since, so it can't be put back safely.", describe(name)));
        }
    }
    if now.head_branch != from.head_branch || (now.head_branch.is_none() && now.head_id != from.head_id) {
        return Err("HEAD has moved since, so it can't be put back safely.".into());
    }

    let mut done = Vec::new();
    let mut pending: BTreeSet<&String> = changed;

    // A branch that went away while another appeared at the same commit was renamed,
    // which `git branch -m` undoes along with its upstream and HEAD.
    let gone: Vec<&String> = pending.iter().copied().filter(|n| is_branch(n) && !to.refs.contains_key(*n)).collect();
    let came: Vec<&String> = pending.iter().copied().filter(|n| is_branch(n) && !from.refs.contains_key(*n)).collect();
    let mut current = now.head_branch.clone();
    if let ([old], [new]) = (gone.as_slice(), came.as_slice())
        && from.refs[*old] == to.refs[*new]
    {
        pending.retain(|n| n != old && n != new);
        let (old, new) = (short(old), short(new));
        git(path, &["branch", "-m", old, new], None)?;
        if current.as_deref() == Some(old) {
            current = Some(new.to_string());
        }
        done.push(format!("Renamed {old} to {new}."));
    }

    let head_ref = |branch: &Option<String>| branch.as_ref().map(|b| format!("refs/heads/{b}"));
    if current == to.head_branch {
        // HEAD stays put, so its branch (or a detached HEAD) moves with a reset.
        let target = match &to.head_branch {
            Some(branch) => to.refs.get(&format!("refs/heads/{branch}")).cloned(),
            None => to.head_id.clone(),
        };
        let moved = match &to.head_branch {
            Some(_) => head_ref(&current).is_some_and(|r| pending.remove(&r)),
            None => now.head_id != to.head_id,
        };
        if moved {
            match &target {
                Some(id) => {
                    git(path, &["reset", "--quiet", &format!("--{mode}"), id], None).map_err(|e| explain(&e))?;
                    done.push(format!("Moved {} to {}.", current.as_deref().unwrap_or("HEAD"), &id[..7]));
                }
                // Back before a branch's first commit.
                None => {
                    let name = head_ref(&current).expect("only a branch can have no commits");
                    git(path, &["update-ref", "-d", &name], None)?;
                    done.push(format!("Took {} back to before its first commit.", short(&name)));
                }
            }
        }
    } else {
        // HEAD changes branch. The branch it goes to has to be in place first, and
        // the one it leaves can only change once it's no longer checked out.
        let target_ref = head_ref(&to.head_branch);
        let prepared = match &target_ref {
            Some(name) if pending.remove(name) => {
                set_ref(path, name, now.refs.get(name), to.refs.get(name), to)?;
                true
            }
            _ => false,
        };
        let switched = match &to.head_branch {
            Some(branch) => git(path, &["switch", "--quiet", "--no-guess", branch], None),
            None => match &to.head_id {
                Some(id) => git(path, &["switch", "--quiet", "--detach", id], None),
                None => Err("There's no commit to go back to.".into()),
            },
        };
        if let Err(e) = switched {
            if prepared {
                let name = target_ref.as_ref().unwrap();
                let _ = set_ref(path, name, to.refs.get(name), now.refs.get(name), &now);
            }
            return Err(explain(&e));
        }
        done.push(match &to.head_branch {
            Some(branch) => format!("Switched to {branch}."),
            None => format!("Switched to {} (detached).", &to.head_id.as_ref().unwrap()[..7]),
        });
    }

    for name in pending {
        let message = set_ref(path, name, now.refs.get(name), to.refs.get(name), to)?;
        done.push(message);
    }
    Ok(done.join(" "))
}

/// Creates, moves or deletes one branch or tag, checking it's still at `old`.
fn set_ref(path: &str, name: &str, old: Option<&String>, new: Option<&String>, to: &Refs) -> Result<String, String> {
    match (old, new) {
        (Some(_), None) if is_branch(name) => {
            // Deleting it this way also drops its upstream from the config.
            git(path, &["branch", "--quiet", "-D", short(name)], None)?;
            Ok(format!("Deleted {}.", describe(name)))
        }
        (Some(old), None) => {
            git(path, &["update-ref", "-d", name, old], None)?;
            Ok(format!("Deleted {}.", describe(name)))
        }
        (None, Some(new)) => {
            git(path, &["update-ref", name, new, ""], None)?;
            if let Some((remote, merge)) = to.upstreams.get(short(name)) {
                let branch = short(name);
                git(path, &["config", &format!("branch.{branch}.remote"), remote], None)?;
                git(path, &["config", &format!("branch.{branch}.merge"), merge], None)?;
            }
            Ok(format!("Restored {} at {}.", describe(name), &new[..7]))
        }
        (Some(old), Some(new)) => {
            git(path, &["update-ref", name, new, old], None)?;
            Ok(format!("Moved {} to {}.", describe(name), &new[..7]))
        }
        (None, None) => Ok(String::new()),
    }
}

fn is_branch(name: &str) -> bool {
    name.starts_with("refs/heads/")
}

fn short(name: &str) -> &str {
    name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/tags/")).unwrap_or(name)
}

fn describe(name: &str) -> String {
    if is_branch(name) { format!("“{}”", short(name)) } else { format!("the tag “{}”", short(name)) }
}

/// Switching and `reset --keep` refuse to overwrite uncommitted changes.
fn explain(error: &str) -> String {
    if error.contains("would be overwritten") || error.contains("not uptodate") {
        "It would overwrite your uncommitted changes. Commit or stash them first, then try again.".into()
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;
    use std::fs::read_to_string;
    use tauri::async_runtime::block_on as run;

    /// Snapshots around `action`, returning (before, after).
    fn around(t: &TempRepo, action: impl FnOnce()) -> (Refs, Refs) {
        let before = snapshot(t.path()).unwrap();
        action();
        (before, snapshot(t.path()).unwrap())
    }

    fn undo(t: &TempRepo, (before, after): &(Refs, Refs), mode: &str) -> Result<String, String> {
        restore(t.path(), after, before, mode)
    }

    fn redo(t: &TempRepo, (before, after): &(Refs, Refs), mode: &str) -> Result<String, String> {
        restore(t.path(), before, after, mode)
    }

    /// `git status --porcelain`, trimmed.
    fn status(t: &TempRepo) -> String {
        git(t.path(), &["status", "--porcelain"], None).unwrap()
    }

    #[test]
    fn undoing_a_commit_leaves_its_changes_staged() {
        let t = TempRepo::new("undo-commit");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        t.write(&[("a.txt", Some("2\n"))]);
        let step = around(&t, || {
            git(t.path(), &["commit", "-qam", "Second"], None).unwrap();
        });
        let second = t.head();
        assert_ne!(second, first);

        let message = undo(&t, &step, "soft").unwrap();
        assert_eq!(message, format!("Moved {} to {}.", t.branch(), &first.to_string()[..7]));
        assert_eq!(t.head(), first);
        assert_eq!(status(&t), "M  a.txt");

        redo(&t, &step, "soft").unwrap();
        assert_eq!(t.head(), second);
        assert_eq!(status(&t), "");
    }

    #[test]
    fn undoing_the_first_commit_leaves_an_empty_branch() {
        let t = TempRepo::new("undo-first");
        let step = around(&t, || {
            t.commit(&[("a.txt", Some("1\n"))], "First");
        });
        let branch = step.1.head_branch.clone().unwrap();
        let message = undo(&t, &step, "soft").unwrap();
        assert_eq!(message, format!("Took {branch} back to before its first commit."));
        assert!(t.repo.head().is_err());
        assert_eq!(status(&t), "A  a.txt");
    }

    #[test]
    fn undoing_a_merge_puts_the_files_back() {
        let t = TempRepo::new("undo-merge");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        t.commit(&[("b.txt", Some("feature\n"))], "Feature");
        git(t.path(), &["switch", "-q", &main], None).unwrap();
        // An uncommitted edit the merge doesn't touch is kept throughout.
        t.write(&[("a.txt", Some("edited\n"))]);

        let step = around(&t, || {
            git(t.path(), &["merge", "-q", "--no-ff", "-m", "Merge", "feature"], None).unwrap();
        });
        assert!(t.dir.join("b.txt").exists());

        undo(&t, &step, "keep").unwrap();
        assert_eq!(t.head(), first);
        assert!(!t.dir.join("b.txt").exists());
        assert_eq!(read_to_string(t.dir.join("a.txt")).unwrap(), "edited\n");
    }

    #[test]
    fn undoing_a_mixed_reset_commits_the_changes_again() {
        let t = TempRepo::new("undo-reset");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let second = t.commit(&[("a.txt", Some("2\n"))], "Second");
        let step = around(&t, || {
            run(crate::reset::reset(t.path().into(), first.to_string(), true)).unwrap();
        });
        assert_eq!(status(&t), "M a.txt");

        undo(&t, &step, "mixed").unwrap();
        assert_eq!(t.head(), second);
        assert_eq!(status(&t), "");
    }

    #[test]
    fn undoing_a_checkout_switches_back() {
        let t = TempRepo::new("undo-checkout");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        // Checking out a new branch creates it too; undoing removes it again.
        let step = around(&t, || {
            run(crate::branch::create_branch(t.path().into(), "feature".into(), None, true)).unwrap();
        });
        assert_eq!(t.branch(), "feature");

        assert_eq!(undo(&t, &step, "keep").unwrap(), format!("Switched to {main}. Deleted “feature”."));
        assert_eq!(t.branch(), main);
        assert!(t.repo.find_branch("feature", BranchType::Local).is_err());

        redo(&t, &step, "keep").unwrap();
        assert_eq!(t.branch(), "feature");
    }

    #[test]
    fn undoing_a_branch_deletion_restores_it_with_its_upstream() {
        let server = TempRepo::bare("undo-delete-server");
        let t = TempRepo::clone_of("undo-delete", &server);
        t.commit(&[("a.txt", Some("1\n"))], "First");
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        let tip = t.commit(&[("b.txt", Some("2\n"))], "Feature");
        git(t.path(), &["push", "-qu", "origin", "feature"], None).unwrap();
        git(t.path(), &["switch", "-q", "-"], None).unwrap();

        let step = around(&t, || {
            run(crate::branch::delete_branch(t.path().into(), "feature".into(), true)).unwrap();
        });
        undo(&t, &step, "keep").unwrap();
        let branch = t.repo.find_branch("feature", BranchType::Local).unwrap();
        assert_eq!(branch.get().target(), Some(tip));
        assert_eq!(branch.upstream().unwrap().name().unwrap(), Some("origin/feature"));
    }

    #[test]
    fn undoing_a_rename_of_the_current_branch() {
        let t = TempRepo::new("undo-rename");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        let step = around(&t, || {
            run(crate::branch::rename_branch(t.path().into(), main.clone(), "trunk".into())).unwrap();
            // A tag with the same name, made in the same step, is undone separately.
            git(t.path(), &["tag", "trunk"], None).unwrap();
        });
        assert_eq!(undo(&t, &step, "keep").unwrap(), format!("Renamed trunk to {main}. Deleted the tag “trunk”."));
        assert_eq!(t.branch(), main);
        assert!(t.repo.find_reference("refs/tags/trunk").is_err());
    }

    #[test]
    fn undoing_tags() {
        let t = TempRepo::new("undo-tags");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let create = around(&t, || {
            run(crate::tag::create_tag(t.path().into(), "v1".into(), None, Some("Version 1".into()))).unwrap();
        });
        let delete = around(&t, || {
            run(crate::tag::delete_tag(t.path().into(), "v1".into())).unwrap();
        });
        undo(&t, &delete, "keep").unwrap();
        let tag = t.repo.find_reference("refs/tags/v1").unwrap();
        assert_eq!(tag.peel_to_commit().unwrap().id(), first);
        assert_eq!(undo(&t, &create, "keep").unwrap(), "Deleted the tag “v1”.");
        assert!(t.repo.find_reference("refs/tags/v1").is_err());
    }

    #[test]
    fn nothing_changes_if_the_branch_has_moved_since() {
        let t = TempRepo::new("undo-stale");
        let first = t.commit(&[("a.txt", Some("1\n"))], "First");
        let step = around(&t, || {
            t.commit(&[("a.txt", Some("2\n"))], "Second");
        });
        let third = t.commit(&[("a.txt", Some("3\n"))], "Third");

        let error = undo(&t, &step, "soft").unwrap_err();
        assert_eq!(error, format!("“{}” has changed since, so it can't be put back safely.", t.branch()));
        assert_eq!(t.head(), third);
        assert_ne!(t.head(), first);
    }

    #[test]
    fn local_changes_in_the_way_stop_the_undo() {
        let t = TempRepo::new("undo-blocked");
        t.commit(&[("a.txt", Some("1\n"))], "First");
        let main = t.branch();
        git(t.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        t.commit(&[("a.txt", Some("feature\n"))], "Feature");
        let step = around(&t, || {
            run(crate::branch::checkout(t.path().into(), "branch".into(), main.clone())).unwrap();
        });
        t.write(&[("a.txt", Some("mine\n"))]);

        let error = undo(&t, &step, "keep").unwrap_err();
        assert!(error.starts_with("It would overwrite your uncommitted changes."), "{error}");
        assert_eq!(t.branch(), main);
        assert_eq!(read_to_string(t.dir.join("a.txt")).unwrap(), "mine\n");
    }
}
