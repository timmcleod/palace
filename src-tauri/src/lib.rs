mod avatars;
mod branch;
mod cli;
mod commit;
mod compare;
mod config;
mod git;
mod github;
mod history;
mod issues;
mod open;
mod pulls;
mod rebase;
mod remote;
mod reset;
#[cfg(any(target_os = "macos", test))]
mod shell_path;
mod stash;
mod store;
mod tag;
mod tree;
mod undo;
mod updates;
mod watch;
#[cfg(test)]
mod test_support;
mod working;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    shell_path::adopt_login_path();
    github::load();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(history::HistoryState::default())
        .manage(cli::Running::default())
        .manage(store::Store::default())
        .manage(watch::RepoWatcher::default())
        .manage(avatars::AvatarCache::default())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            no_pinch_zoom(app);
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            git::repo_overview,
            git::init_repo,
            history::load_history,
            history::history_page,
            history::history_position,
            history::search_commits,
            history::commits_mentioning,
            commit::commit_details,
            commit::file_diff,
            compare::compare,
            compare::compare_file_diff,
            working::working_status,
            working::working_diff,
            working::stage_files,
            working::unstage_files,
            working::stage_hunk,
            working::commit_changes,
            working::discard_files,
            working::discard_hunk,
            working::head_commit,
            working::conflict_file,
            working::resolve_conflict,
            working::resolve_conflict_block,
            working::open_in_editor,
            branch::checkout,
            branch::commits_only_at_head,
            branch::branch_within,
            branch::delete_merged_branch,
            branch::create_branch,
            branch::rename_branch,
            branch::delete_branch,
            branch::merge,
            branch::rebase,
            branch::control_operation,
            rebase::rebase_plan,
            rebase::rebase_interactive,
            branch::cherry_pick,
            branch::revert,
            reset::reset,
            reset::reset_preview,
            reset::reset_branch,
            stash::stash_save,
            stash::stash_apply,
            stash::stash_drop,
            watch::watch_repo,
            avatars::github_avatars,
            tag::create_tag,
            tag::delete_tag,
            tag::describe_revision,
            undo::take_snapshot,
            undo::restore_snapshot,
            open::open_folder,
            open::show_in_folder,
            open::open_terminal,
            cli::install_git_tools,
            tree::tracked_files,
            tree::tree_entries,
            tree::file_contents,
            tree::blame_file,
            config::git_identity,
            config::set_git_identity,
            config::pull_mode,
            cli::git_check,
            github::github_account,
            github::github_sign_in,
            github::github_sign_out,
            github::github_owners,
            github::github_repos,
            github::github_scopes,
            github::github_starred_palace,
            github::github_star_palace,
            issues::github_issues,
            issues::github_issue,
            issues::github_issue_filters,
            issues::github_fork_parent,
            issues::github_create_issue,
            issues::github_update_issue,
            issues::github_toggle_issue,
            store::load_store,
            store::save_store,
            store::set_store_aside,
            issues::github_edit_issue_body,
            issues::github_add_comment,
            issues::github_edit_comment,
            issues::github_delete_comment,
            issues::github_render_markdown,
            pulls::github_branch_pull,
            pulls::github_branches,
            pulls::github_create_pull,
            pulls::branch_commit_messages,
            pulls::pull_request_template,
            pulls::github_merge_state,
            pulls::github_merge_pull,
            pulls::github_ready_for_review,
            pulls::github_delete_branch,
            pulls::github_rename_branch,
            remote::rename_remote_branch,
            remote::finish_remote_rename,
            updates::restart_after_update,
            github::github_create_repo,
            github::github_keys,
            github::github_add_key,
            github::github_delete_key,
            github::local_ssh_keys,
            remote::fetch,
            remote::fetch_in_background,
            remote::pull,
            remote::push,
            remote::publish_branch,
            remote::cancel_remote,
            remote::delete_remote_branch,
            remote::push_tag,
            remote::delete_remote_tag,
            remote::clone_repo,
            remote::add_remote,
            remote::rename_remote,
            remote::remove_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Runs Palace as git's credential helper instead of as the app; see `github`.
pub fn git_credential(action: Option<&str>) -> i32 {
    github::credential_helper(action)
}

/// Pinching on a touchpad would zoom the whole window in WebKitGTK, which handles it
/// in the web view's own event handler. Stopping the event first leaves it unzoomed,
/// as Ctrl and +/- already do.
#[cfg(target_os = "linux")]
fn no_pinch_zoom(app: &tauri::App) {
    use gtk::prelude::WidgetExt;
    use tauri::Manager;
    for window in app.webview_windows().values() {
        let _ = window.with_webview(|webview| {
            webview.inner().connect_event(|_, event| {
                if event.event_type() == gtk::gdk::EventType::TouchpadPinch {
                    gtk::glib::Propagation::Stop
                } else {
                    gtk::glib::Propagation::Proceed
                }
            });
        });
    }
}
