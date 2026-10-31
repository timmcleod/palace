//! Stashes: setting the working copy's changes aside and bringing them back.

use crate::cli::git;

/// Stashes all staged and unstaged changes, and untracked files too when asked. With
/// `files`, only those files are stashed (untracked ones included) and every other
/// change stays where it is.
#[tauri::command]
pub async fn stash_save(
    path: String,
    message: Option<String>,
    include_untracked: bool,
    files: Option<Vec<String>>,
) -> Result<String, String> {
    let files = files.filter(|f| !f.is_empty());
    let mut args = vec!["stash", "push"];
    if include_untracked || files.is_some() {
        args.push("--include-untracked");
    }
    let message = message.filter(|m| !m.trim().is_empty());
    if let Some(message) = &message {
        args.extend(["--message", message.as_str()]);
    }
    let literal: Vec<String> = files.iter().flatten().map(|f| format!(":(literal){f}")).collect();
    if files.is_some() {
        args.push("--");
        args.extend(literal.iter().map(String::as_str));
    }
    let output = git(&path, &args, None)?;
    if output.contains("No local changes to save") {
        return Err("There are no changes to stash.".into());
    }
    Ok(match files.map(|f| f.len()) {
        Some(1) => "Stashed 1 file.".into(),
        Some(n) => format!("Stashed {n} files."),
        None => "Stashed your changes.".into(),
    })
}

/// Applies stash@{index} to the working copy. `pop` also drops the stash, which git
/// only does when it applied without conflicts.
#[tauri::command]
pub async fn stash_apply(path: String, index: usize, pop: bool) -> Result<String, String> {
    let stash = format!("stash@{{{index}}}");
    git(&path, &["stash", if pop { "pop" } else { "apply" }, &stash], None).map_err(|e| {
        if e.contains("CONFLICT") {
            let kept = if pop { " The stash was kept." } else { "" };
            format!("CONFLICT: The stash conflicted with your changes. Resolve the conflicts in the working copy.{kept}")
        } else {
            e
        }
    })?;
    Ok(if pop { "Popped the stash.".into() } else { "Applied the stash.".into() })
}

#[tauri::command]
pub async fn stash_drop(path: String, index: usize) -> Result<String, String> {
    git(&path, &["stash", "drop", &format!("stash@{{{index}}}")], None)?;
    Ok("Dropped the stash.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn stash_count(t: &TempRepo) -> usize {
        git(t.path(), &["stash", "list"], None).unwrap().lines().count()
    }

    #[test]
    fn stashing_and_popping_restores_changes_including_untracked_files() {
        let t = TempRepo::new("stash");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        t.write(&[("a.txt", Some("changed\n")), ("new.txt", Some("new\n"))]);

        run(stash_save(t.path().into(), Some("Work in progress".into()), true, None)).unwrap();
        assert_eq!(std::fs::read_to_string(t.dir.join("a.txt")).unwrap(), "a\n");
        assert!(!t.dir.join("new.txt").exists());
        assert!(git(t.path(), &["stash", "list"], None).unwrap().contains("Work in progress"));

        run(stash_apply(t.path().into(), 0, true)).unwrap();
        assert_eq!(std::fs::read_to_string(t.dir.join("a.txt")).unwrap(), "changed\n");
        assert!(t.dir.join("new.txt").exists());
        assert_eq!(stash_count(&t), 0);
    }

    #[test]
    fn applying_keeps_the_stash_and_dropping_removes_it() {
        let t = TempRepo::new("stash-apply");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        t.write(&[("a.txt", Some("changed\n"))]);
        run(stash_save(t.path().into(), None, false, None)).unwrap();

        run(stash_apply(t.path().into(), 0, false)).unwrap();
        assert_eq!(stash_count(&t), 1);
        run(stash_drop(t.path().into(), 0)).unwrap();
        assert_eq!(stash_count(&t), 0);
    }

    #[test]
    fn stashing_nothing_says_so() {
        let t = TempRepo::new("stash-nothing");
        t.commit(&[("a.txt", Some("a\n"))], "First");
        let error = run(stash_save(t.path().into(), None, true, None)).unwrap_err();
        assert_eq!(error, "There are no changes to stash.");
    }

    #[test]
    fn stashing_only_chosen_files_leaves_the_rest() {
        let t = TempRepo::new("stash-some");
        t.commit(&[("kept.txt", Some("a\n")), ("stashed.txt", Some("b\n"))], "First");
        t.write(&[
            ("kept.txt", Some("edited\n")),
            ("stashed.txt", Some("edited\n")),
            ("new-one.txt", Some("untracked\n")),
            ("new-two.txt", Some("untracked\n")),
            ("new-*.txt", Some("untracked\n")),
        ]);

        // A name that would match others as a pattern stands only for itself.
        let files = vec!["stashed.txt".into(), "new-one.txt".into(), "new-*.txt".into()];
        let message = run(stash_save(t.path().into(), Some("Some files".into()), false, Some(files))).unwrap();
        assert_eq!(message, "Stashed 3 files.");
        assert_eq!(stash_count(&t), 1);

        let read = |f: &str| std::fs::read_to_string(t.dir.join(f)).ok();
        assert_eq!(read("kept.txt").as_deref(), Some("edited\n"));
        assert_eq!(read("stashed.txt").as_deref(), Some("b\n"));
        assert_eq!((read("new-one.txt"), read("new-*.txt")), (None, None));
        assert_eq!(read("new-two.txt").as_deref(), Some("untracked\n"));

        run(stash_apply(t.path().into(), 0, true)).unwrap();
        assert_eq!(read("new-one.txt").as_deref(), Some("untracked\n"));
        assert_eq!(read("stashed.txt").as_deref(), Some("edited\n"));
    }
}
