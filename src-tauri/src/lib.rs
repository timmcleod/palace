mod cli;
mod commit;
mod git;
mod history;
mod remote;
#[cfg(test)]
mod test_support;
mod working;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(history::HistoryState::default())
        .manage(cli::Running::default())
        .invoke_handler(tauri::generate_handler![
            git::repo_overview,
            history::load_history,
            history::history_page,
            commit::commit_details,
            commit::file_diff,
            working::working_status,
            working::working_diff,
            working::stage_files,
            working::unstage_files,
            working::stage_hunk,
            working::commit_changes,
            remote::fetch,
            remote::pull,
            remote::push,
            remote::cancel_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
