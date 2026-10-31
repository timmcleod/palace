//! Creating and deleting tags. Pushing one is a network operation, in remote.rs.

use crate::cli::git;
use git2::Repository;
use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct RevisionInfo {
    short_id: String,
    summary: String,
}

/// The commit a revision (a branch, tag, hash, HEAD~2, …) points at, so the tag dialog
/// can show what a new tag would mark.
#[tauri::command]
pub async fn describe_revision(path: String, revision: String) -> Result<RevisionInfo, String> {
    let repo = Repository::discover(&path).map_err(|e| e.message().to_string())?;
    let commit = repo
        .revparse_single(revision.trim())
        .and_then(|object| object.peel_to_commit())
        .map_err(|_| format!("“{}” isn't a branch, tag or commit in this repository.", revision.trim()))?;
    Ok(RevisionInfo {
        short_id: commit.id().to_string()[..7].to_string(),
        summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
    })
}

/// Tags `target` (HEAD when omitted). With a message, the tag is annotated, recording
/// who made it and when; without one it's a lightweight tag.
#[tauri::command]
pub async fn create_tag(path: String, name: String, target: Option<String>, message: Option<String>) -> Result<String, String> {
    git(&path, &["check-ref-format", &format!("refs/tags/{name}")], None)
        .map_err(|_| format!("“{name}” isn't a valid tag name."))?;

    let message = message.filter(|m| !m.trim().is_empty());
    let mut args = vec!["tag"];
    if let Some(message) = &message {
        // Git otherwise drops lines starting with "#" as comments, such as "#12 fixed"
        // or Markdown headings in release notes.
        args.extend(["--annotate", "--cleanup=whitespace", "--message", message.as_str()]);
    }
    args.push(&name);
    if let Some(target) = &target {
        args.push(target);
    }
    git(&path, &args, None)?;
    Ok(format!("Created the tag {name}."))
}

/// Deletes a tag from this repository only; a pushed copy stays on the remote.
#[tauri::command]
pub async fn delete_tag(path: String, name: String) -> Result<String, String> {
    crate::undo::keep(&path, &format!("refs/tags/{name}"));
    git(&path, &["tag", "--delete", &name], None)?;
    Ok(format!("Deleted the tag {name}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn describing_revisions() {
        let t = TempRepo::new("describe");
        let first = t.commit(&[("a.txt", Some("a\n"))], "First");
        t.commit(&[("b.txt", Some("b\n"))], "Second\n\nWith a body.");

        let head = run(describe_revision(t.path().into(), t.branch())).unwrap();
        assert_eq!(head.summary, "Second");
        let parent = run(describe_revision(t.path().into(), "HEAD~1".into())).unwrap();
        assert_eq!(parent.short_id, first.to_string()[..7]);

        let missing = run(describe_revision(t.path().into(), "no-such-branch".into())).unwrap_err();
        assert!(missing.contains("isn't a branch, tag or commit"), "{missing}");
    }

    #[test]
    fn creating_lightweight_and_annotated_tags_then_deleting_one() {
        let t = TempRepo::new("tags");
        let first = t.commit(&[("a.txt", Some("a\n"))], "First");
        t.commit(&[("b.txt", Some("b\n"))], "Second");

        run(create_tag(t.path().into(), "v1".into(), Some(first.to_string()), None)).unwrap();
        run(create_tag(t.path().into(), "v2".into(), None, Some("Second release\n\n#12 fixed".into()))).unwrap();

        let v1 = t.repo.find_reference("refs/tags/v1").unwrap();
        assert_eq!(v1.peel_to_commit().unwrap().id(), first);
        let v2 = t.repo.find_reference("refs/tags/v2").unwrap().peel_to_tag().unwrap();
        assert_eq!(v2.message(), Ok(Some("Second release\n\n#12 fixed\n")));

        run(delete_tag(t.path().into(), "v1".into())).unwrap();
        assert!(t.repo.find_reference("refs/tags/v1").is_err());

        let invalid = run(create_tag(t.path().into(), "bad tag".into(), None, None)).unwrap_err();
        assert!(invalid.contains("isn't a valid tag name"), "{invalid}");
    }
}
