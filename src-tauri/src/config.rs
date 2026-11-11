//! Git settings: the name and email git records on commits (for everything, or for
//! one repository), and how git is set up to pull.

use crate::cli;
use serde::Serialize;

#[derive(Serialize)]
pub struct Identity {
    global_name: String,
    global_email: String,
    /// Overrides for this repository only; empty when it uses the global ones.
    local_name: String,
    local_email: String,
}

/// The name and email for every repository, and those the repository at `path` sets for
/// itself. With no repository, as for Settings from the welcome screen, only the first.
#[tauri::command]
pub async fn git_identity(path: Option<String>) -> Result<Identity, String> {
    let folder = path.clone().unwrap_or_else(outside_any);
    // `git config --get` fails when a key isn't set, which just means it's empty.
    let get = |scope: &str, key: &str| cli::git(&folder, &["config", scope, "--get", key], None).unwrap_or_default();
    let local = |key: &str| if path.is_some() { get("--local", key) } else { String::new() };
    Ok(Identity {
        global_name: get("--global", "user.name"),
        global_email: get("--global", "user.email"),
        local_name: local("user.name"),
        local_email: local("user.email"),
    })
}

/// Whether git, in the repository at `path`, can't tell whose commits are made there:
/// no email is set and it can't make one up. Asked of git itself rather than read from
/// its message, which is in the user's language.
pub(crate) fn identity_missing(path: &str) -> bool {
    cli::git(path, &["var", "GIT_COMMITTER_IDENT"], None).is_err()
}

/// A folder to run git in for settings of no repository: git needs to run somewhere.
fn outside_any() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

/// Sets the name and email for every repository (`global`) or just this one. An empty
/// value removes the setting, so this repository goes back to the global one.
#[tauri::command]
pub async fn set_git_identity(path: Option<String>, global: bool, name: String, email: String) -> Result<(), String> {
    if !global && path.is_none() {
        return Err("There's no repository to set them for.".into());
    }
    let path = path.unwrap_or_else(outside_any);
    let scope = if global { "--global" } else { "--local" };
    for (key, value) in [("user.name", name.trim()), ("user.email", email.trim())] {
        if value.is_empty() {
            // Unsetting a key that isn't set fails harmlessly.
            let _ = cli::git(&path, &["config", scope, "--unset", key], None);
        } else {
            cli::git(&path, &["config", scope, key, value], None)?;
        }
    }
    Ok(())
}

/// "rebase" or "merge": what git's pull.rebase setting says to do when both sides
/// have new commits. The Pull dialog starts with this until you've made a choice.
#[tauri::command]
pub async fn pull_mode(path: String) -> Result<&'static str, String> {
    let value = cli::git(&path, &["config", "--get", "pull.rebase"], None).unwrap_or_default();
    // Anything but false (true, merges, interactive) rebases.
    Ok(if value.is_empty() || value == "false" { "merge" } else { "rebase" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    #[test]
    fn a_repository_with_a_name_and_email_has_an_identity() {
        // Without one is left untested: git would find the computer's own, which tests
        // can't hide from it without changing the environment of every test running.
        let t = TempRepo::new("identity-set");
        assert!(!identity_missing(t.path()));
    }

    #[test]
    fn repository_identity_overrides_and_resets() {
        let t = TempRepo::new("identity");
        use tauri::async_runtime::block_on as run;

        run(set_git_identity(Some(t.path().into()), false, "Grace Hopper".into(), "grace@example.com".into())).unwrap();
        let identity = run(git_identity(Some(t.path().into()))).unwrap();
        assert_eq!((identity.local_name.as_str(), identity.local_email.as_str()), ("Grace Hopper", "grace@example.com"));

        run(set_git_identity(Some(t.path().into()), false, "".into(), "".into())).unwrap();
        let identity = run(git_identity(Some(t.path().into()))).unwrap();
        assert_eq!((identity.local_name.as_str(), identity.local_email.as_str()), ("", ""));
    }

    #[test]
    fn with_no_repository_only_the_identity_for_every_one() {
        use tauri::async_runtime::block_on as run;
        let identity = run(git_identity(None)).unwrap();
        assert_eq!((identity.local_name.as_str(), identity.local_email.as_str()), ("", ""));
        assert!(run(set_git_identity(None, false, "Grace Hopper".into(), "grace@example.com".into())).is_err());
    }

    #[test]
    fn reading_the_pull_mode() {
        let t = TempRepo::new("pull-mode");
        use tauri::async_runtime::block_on as run;
        let mut config = t.repo.config().unwrap().open_level(git2::ConfigLevel::Local).unwrap();
        config.set_str("pull.rebase", "merges").unwrap();
        assert_eq!(run(pull_mode(t.path().into())).unwrap(), "rebase");
        config.set_bool("pull.rebase", false).unwrap();
        assert_eq!(run(pull_mode(t.path().into())).unwrap(), "merge");
    }
}
