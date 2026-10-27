mod commit;
mod git;
mod history;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(history::HistoryState::default())
        .invoke_handler(tauri::generate_handler![
            git::repo_overview,
            history::load_history,
            history::history_page,
            commit::commit_details,
            commit::file_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
