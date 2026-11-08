//! What the About page (the top and foot of Settings) says of Palace that only its
//! configuration knows, so it's said in one place, tauri.conf.json, as the system's
//! About panel had it. Read from the file itself, built in: the configuration Tauri
//! builds in leaves the copyright out.

use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct About {
    /// "Copyright © 2026 Tim McLeod".
    copyright: Option<String>,
    /// The license's name: "MIT".
    license: Option<String>,
}

#[tauri::command]
pub fn about_palace() -> About {
    read(include_str!("../tauri.conf.json"))
}

fn read(config: &str) -> About {
    let config: serde_json::Value = serde_json::from_str(config).unwrap_or_default();
    let bundle = |key: &str| config["bundle"][key].as_str().map(str::to_string);
    About { copyright: bundle("copyright"), license: bundle("license") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_the_copyright_and_license() {
        let about = about_palace();
        assert!(about.copyright.as_deref().is_some_and(|c| c.starts_with("Copyright © ")), "{about:?}");
        assert_eq!(about.license.as_deref(), Some("MIT"));
        assert_eq!(read("not json"), About { copyright: None, license: None });
    }
}
