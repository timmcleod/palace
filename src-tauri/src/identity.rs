//! The name and email git records on commits, for everything (global) or for one
//! repository.

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

#[tauri::command]
pub async fn git_identity(path: String) -> Result<Identity, String> {
    // `git config --get` fails when a key isn't set, which just means it's empty.
    let get = |scope: &str, key: &str| cli::git(&path, &["config", scope, "--get", key], None).unwrap_or_default();
    Ok(Identity {
        global_name: get("--global", "user.name"),
        global_email: get("--global", "user.email"),
        local_name: get("--local", "user.name"),
        local_email: get("--local", "user.email"),
    })
}

/// Sets the name and email for every repository (`global`) or just this one. An empty
/// value removes the setting, so this repository goes back to the global one.
#[tauri::command]
pub async fn set_git_identity(path: String, global: bool, name: String, email: String) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    #[test]
    fn repository_identity_overrides_and_resets() {
        let t = TempRepo::new("identity");
        use tauri::async_runtime::block_on as run;

        run(set_git_identity(t.path().into(), false, "Grace Hopper".into(), "grace@example.com".into())).unwrap();
        let identity = run(git_identity(t.path().into())).unwrap();
        assert_eq!((identity.local_name.as_str(), identity.local_email.as_str()), ("Grace Hopper", "grace@example.com"));

        run(set_git_identity(t.path().into(), false, "".into(), "".into())).unwrap();
        let identity = run(git_identity(t.path().into())).unwrap();
        assert_eq!((identity.local_name.as_str(), identity.local_email.as_str()), ("", ""));
    }
}
