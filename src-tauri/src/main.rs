// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Git starts Palace as its credential helper while Palace is signed in to GitHub.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("git-credential") {
        std::process::exit(palace_lib::git_credential(args.get(2).map(String::as_str)));
    }
    palace_lib::run()
}
