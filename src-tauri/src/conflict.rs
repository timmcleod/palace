//! A conflicted file's two sides, named as the user knows them, rather than as git's
//! "ours" and "theirs", which a rebase turns around: the branch checked out, or being
//! rebased onto, and the branch merged in or the commit picked, reverted or replayed.
//! And whether a side doesn't have the file, which leaves nothing in it to mark.

use crate::branch::operation;
use git2::{BranchType, Oid, Repository};
use serde::Serialize;
use std::path::Path;

/// One side of a conflict.
#[derive(Serialize, Debug, PartialEq)]
pub struct Side {
    /// A branch at it, as "main", or its short hash.
    name: String,
    /// Its commit's subject, where it's a commit rather than a branch.
    subject: Option<String>,
    /// How many commits are on top of it: in a rebase, the user's own, replayed onto it
    /// so far, which its side of the file has too.
    ahead: usize,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Sides {
    /// "merge", "rebase", "cherry-pick" or "revert", as the overview has it.
    operation: Option<&'static str>,
    /// What the file's "current" side is: HEAD, or for a rebase, what's rebased onto.
    current: Option<Side>,
    /// What its "incoming" side is: the change being merged, picked, reverted or replayed.
    incoming: Option<Side>,
    /// For a rebase, the branch whose commits are replayed, one of which is incoming.
    rebasing: Option<String>,
    /// "current", "incoming" or "both", when that side doesn't have the file.
    deleted_in: Option<&'static str>,
    /// Whether the file wasn't there before either side changed things: the side without
    /// it didn't delete it, but the other added it, as by moving a file there.
    added: bool,
}

#[tauri::command]
pub async fn conflict_sides(path: String, file: String) -> Result<Sides, String> {
    let repo = Repository::discover(&path).map_err(|e| e.message().to_string())?;
    Ok(sides(&repo, &file))
}

fn sides(repo: &Repository, file: &str) -> Sides {
    let operation = operation(repo);
    let gitdir = repo.path();
    let rebase_file = |name: &str| rebase_file(gitdir, name);
    let current = if operation == Some("rebase") {
        rebase_file("onto").and_then(|onto| resolve(repo, &onto)).map(|onto| {
            let mut side = named(repo, onto, rebased_onto(repo));
            side.ahead = head_oid(repo).and_then(|head| repo.graph_ahead_behind(head, onto).ok()).map_or(0, |(ahead, _)| ahead);
            side
        })
    } else {
        head_side(repo)
    };
    // The branch merged in, by name; a commit replayed, picked or reverted, by itself,
    // though a branch may be at it too.
    let incoming = stopped_at(repo).map(|oid| if operation == Some("merge") { named(repo, oid, merged(gitdir)) } else { commit_side(repo, oid) });
    let rebasing = (operation == Some("rebase"))
        .then(|| rebase_file("head-name"))
        .flatten()
        .and_then(|name| name.strip_prefix("refs/heads/").map(String::from));
    let (deleted_in, added) = missing_from(repo, file);
    Sides { operation, current, incoming, rebasing, deleted_in, added }
}

/// The commit the merge, rebase, cherry-pick or revert under way has stopped at: its
/// incoming side. A rebase or cherry-pick of several commits moves on to the next one
/// on Skip, or on Continue, which may drop one left empty without moving HEAD, so undo
/// keeps this too, to put a conflict back only at the commit it was resolved at.
pub(crate) fn stopped_at(repo: &Repository) -> Option<Oid> {
    // Kept in the repository's own .git, which for a worktree is its own, not the one
    // shared.
    let gitdir = repo.path();
    let id = match operation(repo)? {
        // Merging several branches at once, git stops at the first that conflicts, the
        // last listed: those before it are merged already, into the current side.
        "merge" => last_line(&gitdir.join("MERGE_HEAD")),
        // REBASE_HEAD, as git has written since 2.17; stopped-sha before that.
        "rebase" => first_line(&gitdir.join("REBASE_HEAD")).or_else(|| rebase_file(gitdir, "stopped-sha")),
        "cherry-pick" => first_line(&gitdir.join("CHERRY_PICK_HEAD")),
        "revert" => first_line(&gitdir.join("REVERT_HEAD")),
        _ => None,
    }?;
    resolve(repo, &id)
}

/// A file a rebase keeps of what it's doing, by either of git's ways of rebasing.
fn rebase_file(gitdir: &Path, name: &str) -> Option<String> {
    ["rebase-merge", "rebase-apply"].iter().find_map(|dir| first_line(&gitdir.join(dir).join(name)))
}

/// Which side doesn't have `file`, and whether it was added rather than deleted: in the
/// index, a conflict keeps an entry for each side that has the file, and for the base
/// both started from, so one missing is the side without it.
fn missing_from(repo: &Repository, file: &str) -> (Option<&'static str>, bool) {
    let Ok(mut index) = repo.index() else { return (None, false) };
    // As it is now, the conflict made since it was read, if it was.
    if index.read(false).is_err() {
        return (None, false);
    }
    let Some(conflict) = index.conflicts().ok().and_then(|mut conflicts| {
        conflicts.find_map(|c| c.ok().filter(|c| [&c.ancestor, &c.our, &c.their].iter().any(|e| e.as_ref().is_some_and(|e| e.path == file.as_bytes()))))
    }) else {
        return (None, false);
    };
    let missing = match (conflict.our.is_some(), conflict.their.is_some()) {
        (true, true) => None,
        (false, true) => Some("current"),
        (true, false) => Some("incoming"),
        (false, false) => Some("both"),
    };
    (missing, missing.is_some() && conflict.ancestor.is_none())
}

fn head_oid(repo: &Repository) -> Option<Oid> {
    repo.head().ok()?.target()
}

fn head_side(repo: &Repository) -> Option<Side> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        return Some(Side { name: head.shorthand().ok()?.to_string(), subject: None, ahead: 0 });
    }
    head.target().map(|oid| named(repo, oid, None))
}

/// A commit by the name it was given, as `typed`, while that's still it; or else by a
/// branch at it, local first; or else by its short hash and subject. Of several branches
/// at one commit, the one typed is what the user had in mind.
fn named(repo: &Repository, oid: Oid, typed: Option<String>) -> Side {
    // A commit's id, as a pull rebasing writes, names nothing; a full ref, as a rebase
    // onto the upstream writes, is named as the sidebar names it: "main", not
    // "refs/heads/main".
    let typed = typed.filter(|name| Oid::from_str(name).map_or(true, |id| id.to_string() != *name)).map(|name| short_ref(&name));
    if let Some(name) = typed.filter(|name| resolve(repo, name) == Some(oid)) {
        return Side { name, subject: None, ahead: 0 };
    }
    let branch_at = |kind| {
        repo.branches(Some(kind)).ok()?.flatten().find_map(|(branch, _)| {
            let name = branch.name().ok()??.to_string();
            (branch.get().target() == Some(oid) && !name.ends_with("/HEAD")).then_some(name)
        })
    };
    match branch_at(BranchType::Local).or_else(|| branch_at(BranchType::Remote)) {
        Some(name) => Side { name, subject: None, ahead: 0 },
        None => commit_side(repo, oid),
    }
}

fn short_ref(name: &str) -> String {
    ["refs/heads/", "refs/remotes/", "refs/tags/"].iter().find_map(|prefix| name.strip_prefix(prefix)).unwrap_or(name).to_string()
}

/// What the rebase was started onto, as typed: HEAD's reflog says, as "rebase (start):
/// checkout main", or "pull --rebase (start): checkout …" for one a pull started. Only
/// the latest start is this rebase's, so the search stops there, rather than going on
/// through the whole reflog on each look, as the view looks on every refresh.
fn rebased_onto(repo: &Repository) -> Option<String> {
    let reflog = repo.reflog("HEAD").ok()?;
    let start = reflog.iter().find_map(|entry| entry.message().ok().flatten().filter(|m| m.contains("(start): checkout ")).map(String::from))?;
    start.split_once("(start): checkout ").map(|(_, name)| name.to_string())
}

/// The branch being merged, last of those named, as MERGE_MSG names them: "Merge
/// branch 'feature'", or "Merge branches 'a' and 'b'". A message of the user's own names
/// none, or none that's still the commit, which `named` sees to.
fn merged(gitdir: &Path) -> Option<String> {
    let subject = first_line(&gitdir.join("MERGE_MSG"))?;
    let quoted: Vec<&str> = subject.split('\'').collect();
    // Between quotes, the names: every other piece, from the second.
    quoted.iter().skip(1).step_by(2).rfind(|name| !name.is_empty()).map(|name| name.to_string())
}

fn commit_side(repo: &Repository, oid: Oid) -> Side {
    let subject = repo.find_commit(oid).ok().and_then(|c| c.summary().ok().flatten().map(String::from));
    Side { name: oid.to_string()[..7].to_string(), subject, ahead: 0 }
}

fn resolve(repo: &Repository, id: &str) -> Option<Oid> {
    repo.revparse_single(id).ok().map(|o| o.id())
}

/// The lines of a file git keeps in .git, trimmed, leaving out blank ones.
fn lines(path: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines().map(str::trim).filter(|line| !line.is_empty()).map(String::from).collect()
}

fn first_line(path: &Path) -> Option<String> {
    lines(path).into_iter().next()
}

fn last_line(path: &Path) -> Option<String> {
    lines(path).pop()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::git;
    use crate::test_support::TempRepo;

    fn side(name: &str, subject: Option<&str>) -> Option<Side> {
        Some(Side { name: name.into(), subject: subject.map(String::from), ahead: 0 })
    }

    fn short(t: &TempRepo, rev: &str) -> String {
        t.repo.revparse_single(rev).unwrap().id().to_string()[..7].to_string()
    }

    // main and feature each change a.txt, and feature deletes gone.txt, which main
    // changes; main deletes kept.txt, which feature changes.
    fn diverged(name: &str) -> (TempRepo, String) {
        let t = TempRepo::new(name);
        t.commit(&[("a.txt", Some("base\n")), ("gone.txt", Some("x\n")), ("kept.txt", Some("y\n"))], "Base");
        let main = t.branch();
        git(t.path(), &["switch", "-qc", "feature"], None).unwrap();
        t.commit(&[("a.txt", Some("feature\n")), ("gone.txt", None), ("kept.txt", Some("y, changed\n"))], "Change on feature");
        git(t.path(), &["switch", "-q", &main], None).unwrap();
        t.commit(&[("a.txt", Some("main\n")), ("gone.txt", Some("x, changed\n")), ("kept.txt", None)], "Change on main");
        (t, main)
    }

    #[test]
    fn a_merge_names_the_branch_checked_out_and_the_one_merged_in() {
        let (t, main) = diverged("conflict-merge");
        assert!(git(t.path(), &["merge", "feature"], None).is_err());
        let s = sides(&t.repo, "a.txt");
        assert_eq!(s.operation, Some("merge"));
        assert_eq!(s.current, side(&main, None));
        assert_eq!(s.incoming, side("feature", None));
        assert_eq!(s.rebasing, None);
        assert_eq!(s.deleted_in, None);
        // feature deleted gone.txt; main deleted kept.txt.
        assert_eq!(sides(&t.repo, "gone.txt").deleted_in, Some("incoming"));
        assert_eq!(sides(&t.repo, "kept.txt").deleted_in, Some("current"));
    }

    #[test]
    fn a_rebase_names_what_its_onto_and_the_commit_being_replayed() {
        let (t, main) = diverged("conflict-rebase");
        git(t.path(), &["switch", "-q", "feature"], None).unwrap();
        let replayed = short(&t, "feature");
        assert!(git(t.path(), &["rebase", &main], None).is_err());
        let s = sides(&t.repo, "a.txt");
        assert_eq!(s.operation, Some("rebase"));
        assert_eq!(s.current, side(&main, None));
        assert_eq!(s.incoming, side(&replayed, Some("Change on feature")));
        assert_eq!(s.rebasing.as_deref(), Some("feature"));
        // As a rebase turns the sides around: feature's commit is incoming.
        assert_eq!(sides(&t.repo, "gone.txt").deleted_in, Some("incoming"));
    }

    #[test]
    fn a_cherry_pick_or_revert_names_the_commit() {
        let (t, main) = diverged("conflict-pick");
        let picked = short(&t, "feature");
        assert!(git(t.path(), &["cherry-pick", "feature"], None).is_err());
        let s = sides(&t.repo, "a.txt");
        assert_eq!((s.operation, s.current, s.incoming), (Some("cherry-pick"), side(&main, None), side(&picked, Some("Change on feature"))));
        git(t.path(), &["cherry-pick", "--abort"], None).unwrap();

        // Reverting the base's change to a.txt, which main has changed since.
        t.commit(&[("a.txt", Some("main, again\n"))], "Again on main");
        let reverted = short(&t, "HEAD~1");
        assert!(git(t.path(), &["revert", "--no-edit", "HEAD~1"], None).is_err());
        let s = sides(&t.repo, "a.txt");
        assert_eq!((s.operation, s.incoming), (Some("revert"), side(&reverted, Some("Change on main"))));
    }

    // As git writes it rebasing onto the upstream, or pulling: a full ref, named as the
    // sidebar names it, or a commit's id, which names nothing.
    #[test]
    fn a_full_ref_is_named_short_and_a_commit_id_not_at_all() {
        let (t, main) = diverged("conflict-typed");
        let at = t.repo.revparse_single(&main).unwrap().id();
        assert_eq!(named(&t.repo, at, Some(format!("refs/heads/{main}"))).name, main);
        // Some other name for it, a branch at it, rather than its 40 characters.
        assert_eq!(named(&t.repo, at, Some(at.to_string())).name, main);
    }

    #[test]
    fn no_operation_names_nothing() {
        let (t, _) = diverged("conflict-none");
        let s = sides(&t.repo, "a.txt");
        assert_eq!((s.operation, s.incoming, s.deleted_in), (None, None, None));
    }

    // feature's first commit replays cleanly onto main and its second conflicts: the
    // current side is main with that first one on it. A branch at main sorting before
    // it isn't what the rebase is onto, as typed.
    #[test]
    fn a_rebase_counts_the_commits_replayed_onto_it_so_far_by_the_name_typed() {
        let t = TempRepo::new("conflict-rebase-more");
        t.commit(&[("a.txt", Some("base\n"))], "Base");
        let main = t.branch();
        git(t.path(), &["switch", "-qc", "feature"], None).unwrap();
        t.commit(&[("b.txt", Some("new\n"))], "Add b");
        t.commit(&[("a.txt", Some("feature\n"))], "Change a");
        git(t.path(), &["switch", "-q", &main], None).unwrap();
        t.commit(&[("a.txt", Some("main\n"))], "Change a on main");
        git(t.path(), &["branch", "archive"], None).unwrap();
        git(t.path(), &["switch", "-q", "feature"], None).unwrap();
        assert!(git(t.path(), &["rebase", &main], None).is_err());
        let s = sides(&t.repo, "a.txt");
        assert_eq!(s.current, Some(Side { name: main.clone(), subject: None, ahead: 1 }));
        assert_eq!(s.incoming.map(|i| i.subject), Some(Some("Change a".into())));
    }

    // Merging x, which merges cleanly, and y, which conflicts: y is what's conflicting.
    #[test]
    fn merging_several_branches_names_the_one_that_conflicts() {
        let t = TempRepo::new("conflict-octopus");
        t.commit(&[("a.txt", Some("base\n"))], "Base");
        let main = t.branch();
        git(t.path(), &["switch", "-qc", "x"], None).unwrap();
        t.commit(&[("x.txt", Some("x\n"))], "Add x");
        git(t.path(), &["switch", "-qc", "y", &main], None).unwrap();
        t.commit(&[("a.txt", Some("y\n"))], "Change a on y");
        git(t.path(), &["switch", "-q", &main], None).unwrap();
        t.commit(&[("a.txt", Some("main\n"))], "Change a on main");
        assert!(git(t.path(), &["merge", "x", "y"], None).is_err());
        let s = sides(&t.repo, "a.txt");
        assert_eq!((s.operation, s.incoming), (Some("merge"), side("y", None)));
    }

    // main moves r.txt to b.txt, and feature to c.txt: feature didn't delete b.txt, it
    // never had it.
    #[test]
    fn a_file_one_side_added_isnt_said_to_be_deleted_by_the_other() {
        let t = TempRepo::new("conflict-renamed");
        t.commit(&[("r.txt", Some("one\ntwo\nthree\n"))], "Base");
        let main = t.branch();
        git(t.path(), &["switch", "-qc", "feature"], None).unwrap();
        git(t.path(), &["mv", "r.txt", "c.txt"], None).unwrap();
        git(t.path(), &["commit", "-qm", "Move to c"], None).unwrap();
        git(t.path(), &["switch", "-q", &main], None).unwrap();
        git(t.path(), &["mv", "r.txt", "b.txt"], None).unwrap();
        git(t.path(), &["commit", "-qm", "Move to b"], None).unwrap();
        assert!(git(t.path(), &["merge", "feature"], None).is_err());
        let s = sides(&t.repo, "b.txt");
        assert_eq!((s.deleted_in, s.added), (Some("incoming"), true));
        // Both moved it away: it's gone, deleted, from both.
        let s = sides(&t.repo, "r.txt");
        assert_eq!((s.deleted_in, s.added), (Some("both"), false));
    }
}
