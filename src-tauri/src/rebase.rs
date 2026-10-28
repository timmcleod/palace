//! Interactive rebase: rewriting the current branch's recent commits by reordering,
//! rewording, squashing or dropping them.
//!
//! Palace writes git's to-do list itself and hands it over through
//! GIT_SEQUENCE_EDITOR, so no editor opens. New messages are applied by `exec` steps
//! that amend the commit just made, which keeps the whole rebase non-interactive.

use crate::branch::stopped_or;
use crate::cli::git;
use git2::{BranchType, Oid, Repository, Sort};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Debug)]
pub struct PlanCommit {
    id: String,
    short_id: String,
    message: String,
    author: String,
    email: String,
    time: i64,
}

#[derive(Serialize, Debug)]
pub struct RebasePlan {
    /// The commits from the chosen one up to HEAD, oldest first.
    commits: Vec<PlanCommit>,
    /// The commit they're replayed onto; None when the chosen commit is the first.
    base: Option<String>,
    branch: String,
    /// How many of them are already on the branch's upstream (so it'll need force
    /// pushing afterwards).
    pushed: usize,
    upstream: Option<String>,
}

/// One step of the new history: a commit to keep ("pick"), fold into the one before
/// it ("fixup") or leave out ("drop"). A `message` replaces the message of the commit
/// a pick (and the fixups after it) produce.
#[derive(Deserialize, Debug)]
pub struct Step {
    id: String,
    action: String,
    message: Option<String>,
}

/// The commits an interactive rebase from `from` would rewrite.
#[tauri::command]
pub async fn rebase_plan(path: String, from: String) -> Result<RebasePlan, String> {
    let repo = Repository::discover(&path).map_err(message)?;
    let head = repo.head().map_err(|_| "This repository has no commits yet.".to_string())?;
    if !head.is_branch() {
        return Err("HEAD is detached. Check out a branch to rebase it.".into());
    }
    let branch = head.shorthand().ok().unwrap_or("").to_string();
    let head_id = head.target().ok_or("HEAD doesn't point at a commit.")?;
    let from = repo.revparse_single(&from).and_then(|o| o.peel_to_commit()).map_err(message)?;

    if from.id() != head_id && !repo.graph_descendant_of(head_id, from.id()).map_err(message)? {
        return Err(format!("{} isn't on {branch}, so it can't be rebased here.", short(&from.id())));
    }

    let base = from.parent_ids().next();
    let mut walk = repo.revwalk().map_err(message)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE).map_err(message)?;
    walk.push(head_id).map_err(message)?;
    if let Some(base) = base {
        walk.hide(base).map_err(message)?;
    }

    let mut commits = Vec::new();
    for oid in walk {
        let commit = repo.find_commit(oid.map_err(message)?).map_err(message)?;
        if commit.parent_count() > 1 {
            return Err(format!(
                "There's a merge commit ({}) in this range. Interactive rebase can only rewrite a straight line of commits; start from a commit after the merge.",
                short(&commit.id())
            ));
        }
        let author = commit.author();
        commits.push(PlanCommit {
            id: commit.id().to_string(),
            short_id: short(&commit.id()),
            message: commit.message().ok().unwrap_or("").trim_end().to_string(),
            author: author.name().unwrap_or("").to_string(),
            email: author.email().unwrap_or("").to_string(),
            time: author.when().seconds(),
        });
    }

    let upstream = repo
        .find_branch(&branch, BranchType::Local)
        .ok()
        .and_then(|b| b.upstream().ok())
        .and_then(|u| Some((u.name().ok().flatten()?.to_string(), u.get().target()?)));
    let pushed = match &upstream {
        Some((_, tip)) => commits
            .iter()
            .filter(|c| {
                let id = Oid::from_str(&c.id).unwrap();
                id == *tip || repo.graph_descendant_of(*tip, id).unwrap_or(false)
            })
            .count(),
        None => 0,
    };

    Ok(RebasePlan {
        commits,
        base: base.map(|b| b.to_string()),
        branch,
        pushed,
        upstream: upstream.map(|(name, _)| name),
    })
}

/// Rewrites the current branch from `base` (the plan's base; None for its first
/// commit) by the given steps, oldest first.
#[tauri::command]
pub async fn rebase_interactive(path: String, base: Option<String>, steps: Vec<Step>) -> Result<String, String> {
    let repo = Repository::discover(&path).map_err(message)?;
    let work = repo.path().join("palace-rebase");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;

    let todo = todo_list(&steps, &work)?;
    let todo_file = work.join("todo");
    std::fs::write(&todo_file, todo).map_err(|e| e.to_string())?;

    // Git runs the sequence editor with its to-do file's path; copying ours over it
    // replaces the list git wrote.
    let editor = format!("cp {}", quote(&todo_file));
    let mut args = vec!["-c", "core.editor=true", "-c"];
    let sequence = format!("sequence.editor={editor}");
    args.push(&sequence);
    args.extend(["rebase", "--interactive", "--autostash"]);
    match &base {
        Some(base) => args.push(base),
        None => args.push("--root"),
    }

    let kept = steps.iter().filter(|s| s.action != "drop" && s.action != "fixup").count();
    git(&path, &args, None).map_err(|e| stopped_or(&path, e))?;
    let _ = std::fs::remove_dir_all(&work);
    Ok(match kept {
        1 => "Rewrote the branch; it now has 1 commit from there.".into(),
        n => format!("Rewrote the branch; it now has {n} commits from there."),
    })
}

/// Git's to-do list for the steps. A group is a pick and the fixups after it; when
/// the group has a new message, an exec step amends the commit with it.
fn todo_list(steps: &[Step], work: &Path) -> Result<String, String> {
    let mut lines = Vec::new();
    let mut pending: Option<String> = None;
    let flush = |lines: &mut Vec<String>, pending: &mut Option<String>| {
        if let Some(file) = pending.take() {
            // Only the message changes, so commit hooks (lint-staged and the like)
            // are skipped, as they are when git rewords a commit itself.
            lines.push(format!("exec git commit --amend --allow-empty --no-verify --quiet --cleanup=strip --file {file}"));
        }
    };

    for (i, step) in steps.iter().enumerate() {
        if Oid::from_str(&step.id).is_err() {
            return Err(format!("“{}” isn't a commit.", step.id));
        }
        match step.action.as_str() {
            "pick" => {
                flush(&mut lines, &mut pending);
                lines.push(format!("pick {}", step.id));
                if let Some(text) = &step.message {
                    let file = work.join(format!("message-{i}"));
                    std::fs::write(&file, text).map_err(|e| e.to_string())?;
                    pending = Some(quote(&file));
                }
            }
            "fixup" => {
                if !lines.iter().any(|l| l.starts_with("pick ")) {
                    return Err("The oldest commit kept can't be squashed into another.".into());
                }
                lines.push(format!("fixup {}", step.id));
            }
            "drop" => {
                flush(&mut lines, &mut pending);
                lines.push(format!("drop {}", step.id));
            }
            other => return Err(format!("Unknown rebase step “{other}”.")),
        }
    }
    flush(&mut lines, &mut pending);
    if lines.is_empty() {
        lines.push("noop".into());
    }
    Ok(lines.join("\n") + "\n")
}

/// Single-quotes a path for the shell git runs the editor and exec steps with.
fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

fn short(id: &Oid) -> String {
    id.to_string()[..7].to_string()
}

fn message(e: git2::Error) -> String {
    e.message().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::branch::control_operation;
    use crate::test_support::TempRepo;
    use tauri::async_runtime::block_on as run;

    /// A repository with commits A (base) then B, C, D, each adding a file.
    fn four(name: &str) -> (TempRepo, [Oid; 4]) {
        let t = TempRepo::new(name);
        let a = t.commit(&[("a.txt", Some("a\n"))], "A");
        let b = t.commit(&[("b.txt", Some("b\n"))], "B");
        let c = t.commit(&[("c.txt", Some("c\n"))], "C");
        let d = t.commit(&[("d.txt", Some("d\n"))], "D");
        (t, [a, b, c, d])
    }

    fn step(id: Oid, action: &str, message: Option<&str>) -> Step {
        Step { id: id.to_string(), action: action.into(), message: message.map(str::to_string) }
    }

    /// The branch's commit messages, newest first, down to (not including) `base`.
    fn log(t: &TempRepo, base: Oid) -> Vec<String> {
        let mut walk = t.repo.revwalk().unwrap();
        walk.push_head().unwrap();
        walk.hide(base).unwrap();
        walk.map(|id| t.repo.find_commit(id.unwrap()).unwrap().message().ok().unwrap().trim_end().to_string())
            .collect()
    }

    #[test]
    fn planning_lists_the_commits_from_the_one_chosen() {
        let (t, [a, b, _, d]) = four("plan");
        let plan = run(rebase_plan(t.path().into(), b.to_string())).unwrap();
        let messages: Vec<_> = plan.commits.iter().map(|c| c.message.as_str()).collect();
        assert_eq!(messages, ["B", "C", "D"]);
        assert_eq!(plan.base, Some(a.to_string()));
        assert_eq!(plan.pushed, 0);

        let root = run(rebase_plan(t.path().into(), a.to_string())).unwrap();
        assert_eq!((root.commits.len(), root.base), (4, None));

        let only_head = run(rebase_plan(t.path().into(), d.to_string())).unwrap();
        assert_eq!(only_head.commits.len(), 1);
    }

    #[test]
    fn reordering_rewording_and_dropping() {
        let (t, [a, b, c, d]) = four("rewrite");
        let steps = vec![step(d, "pick", None), step(b, "pick", Some("B, reworded\n\nWith a body.")), step(c, "drop", None)];
        let message = run(rebase_interactive(t.path().into(), Some(a.to_string()), steps)).unwrap();
        assert_eq!(message, "Rewrote the branch; it now has 2 commits from there.");
        assert_eq!(log(&t, a), ["B, reworded\n\nWith a body.", "D"]);
        assert!(!t.dir.join("c.txt").exists());
        assert!(t.dir.join("b.txt").exists() && t.dir.join("d.txt").exists());
        assert!(!t.repo.path().join("palace-rebase").exists());
    }

    #[test]
    fn squashing_with_a_new_message_and_fixing_up() {
        let (t, [a, b, c, d]) = four("squash");
        let steps = vec![
            step(b, "pick", Some("B and C together")),
            step(c, "fixup", None),
            step(d, "pick", None),
        ];
        run(rebase_interactive(t.path().into(), Some(a.to_string()), steps)).unwrap();
        assert_eq!(log(&t, a), ["D", "B and C together"]);

        // A fixup with no new message keeps the message of the commit it joins.
        let (t, [a, b, c, d]) = four("fixup");
        run(rebase_interactive(t.path().into(), Some(a.to_string()), vec![step(b, "pick", None), step(c, "fixup", None), step(d, "fixup", None)])).unwrap();
        assert_eq!(log(&t, a), ["B"]);
        assert!(t.dir.join("d.txt").exists());
    }

    #[test]
    fn rewriting_from_the_first_commit() {
        let (t, [a, b, _, _]) = four("root");
        run(rebase_interactive(t.path().into(), None, vec![step(a, "pick", Some("Start")), step(b, "fixup", None)])).unwrap();
        let mut walk = t.repo.revwalk().unwrap();
        walk.push_head().unwrap();
        let all: Vec<_> = walk.map(|id| t.repo.find_commit(id.unwrap()).unwrap().summary().ok().flatten().unwrap().to_string()).collect();
        assert_eq!(all, ["Start"]);
    }

    #[test]
    fn a_conflict_stops_and_continuing_finishes_with_the_new_message() {
        let t = TempRepo::new("interactive-rebase-conflict");
        let a = t.commit(&[("f.txt", Some("1\n"))], "A");
        let b = t.commit(&[("f.txt", Some("2\n"))], "B");
        let c = t.commit(&[("f.txt", Some("3\n"))], "C");
        // C before B: C's change no longer applies cleanly.
        let steps = vec![step(c, "pick", Some("C first")), step(b, "pick", None)];
        let stopped = run(rebase_interactive(t.path().into(), Some(a.to_string()), steps)).unwrap_err();
        assert!(stopped.starts_with("CONFLICT: The rebase stopped"), "{stopped}");

        t.write(&[("f.txt", Some("3\n"))]);
        git(t.path(), &["add", "f.txt"], None).unwrap();
        // Continuing stops again, now on B, which conflicts the other way.
        let next = run(control_operation(t.path().into(), "continue".into()));
        if next.is_err() {
            t.write(&[("f.txt", Some("2\n"))]);
            git(t.path(), &["add", "f.txt"], None).unwrap();
            run(control_operation(t.path().into(), "continue".into())).unwrap();
        }
        assert_eq!(log(&t, a), ["B", "C first"]);
    }

    #[test]
    fn merges_in_the_range_are_refused() {
        let t = TempRepo::new("rebase-merge");
        let a = t.commit(&[("a.txt", Some("a\n"))], "A");
        let main = t.branch();
        git(t.path(), &["switch", "-c", "side"], None).unwrap();
        t.write(&[("s.txt", Some("s\n"))]);
        git(t.path(), &["add", "s.txt"], None).unwrap();
        git(t.path(), &["commit", "-m", "Side"], None).unwrap();
        git(t.path(), &["switch", &main], None).unwrap();
        t.write(&[("m.txt", Some("m\n"))]);
        git(t.path(), &["add", "m.txt"], None).unwrap();
        git(t.path(), &["commit", "-m", "Main"], None).unwrap();
        git(t.path(), &["merge", "--no-edit", "side"], None).unwrap();

        let refused = run(rebase_plan(t.path().into(), a.to_string())).unwrap_err();
        assert!(refused.starts_with("There's a merge commit"), "{refused}");
    }
}
