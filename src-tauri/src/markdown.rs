//! Markdown files previewed in the Files view, rendered here rather than by GitHub, so it
//! works signed out and offline: CommonMark with GitHub's tables, task lists,
//! strikethrough and footnotes (its alerts show as plain quotes). What a file says can
//! include HTML, as READMEs
//! often do, so the result is cleaned of anything that could run or reach out, keeping
//! what's there for layout (pictures for light and dark, aligned paragraphs, details).
//!
//! Images the file shows by a path in the repository are read and put in the page, as
//! the web view can't load the repository's files itself. Those outside the repository,
//! not images or too large are left out.

use base64::Engine;
use pulldown_cmark::{html, Options, Parser};
use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

/// The largest image put in the page, so a stray huge one doesn't stall the preview.
const MAX_IMAGE: u64 = 10 * 1024 * 1024;

/// The Markdown `text` of `file`, in the repository at `path`, as HTML to show. `text`
/// is what's in the editor, with any edits not saved yet.
#[tauri::command]
pub async fn render_markdown(path: String, file: String, text: String) -> String {
    tauri::async_runtime::spawn_blocking(move || render(Path::new(&path), &file, &text)).await.unwrap_or_default()
}

fn render(repository: &Path, file: &str, text: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_GFM;
    let mut unsafe_html = String::new();
    html::push_html(&mut unsafe_html, Parser::new_ext(text, options));

    // Paths are relative to the file's own folder, as on GitHub.
    let repository = repository.to_path_buf();
    let folder = Path::new(file).parent().map(Path::to_path_buf).unwrap_or_default();
    ammonia::Builder::default()
        .add_tags(&["picture", "source", "input", "details", "summary"])
        .add_generic_attributes(&["align"])
        .add_tag_attributes("img", &["width", "height"])
        .add_tag_attributes("source", &["srcset", "media", "type"])
        // A task list's boxes, which can't be ticked here.
        .add_tag_attributes("input", &["type", "checked", "disabled"])
        .add_tag_attributes("details", &["open"])
        // Runs after links have been checked, so only images Palace reads become data.
        .attribute_filter(move |element, attribute, value| match (element, attribute) {
            ("img", "src") | ("source", "srcset") => Some(Cow::Owned(image_source(&repository, &folder, value).unwrap_or_default())),
            ("input", "type") => (value == "checkbox").then(|| value.into()),
            _ => Some(value.into()),
        })
        .clean(&unsafe_html)
        .to_string()
}

/// What an image's `src` (or a `srcset` of one) shows: a web address as it is, or an
/// image in the repository, relative to the file's `folder` or its root, as data. None
/// for one that can't be shown.
fn image_source(repository: &Path, folder: &Path, value: &str) -> Option<String> {
    let value = value.trim();
    if value.starts_with("https://") || value.starts_with("http://") {
        return Some(value.to_string());
    }
    // A srcset of several, with sizes, isn't one path.
    if value.contains(',') || value.contains(' ') || value.contains(':') {
        return None;
    }
    let path = value.split(['?', '#']).next()?;
    let relative = match path.strip_prefix('/') {
        Some(from_root) => PathBuf::from(from_root),
        None => folder.join(path),
    };
    let inside = normalize(&relative)?;
    let mime = image_type(&inside)?;
    let full = repository.join(&inside);
    let size = std::fs::metadata(&full).ok()?.len();
    if size > MAX_IMAGE {
        return None;
    }
    let bytes = std::fs::read(&full).ok()?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// `path` with its "." and ".." worked out, or None if it leads out of the repository.
fn normalize(path: &Path) -> Option<PathBuf> {
    let mut parts = Vec::new();
    for part in path.components() {
        match part {
            Component::Normal(name) => parts.push(name),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(parts.iter().collect())
}

fn image_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(text: &str) -> String {
        render(Path::new("/nowhere"), "README.md", text)
    }

    #[test]
    fn rendering_githubs_markdown() {
        let html = rendered("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] not\n\n~~gone~~");
        assert!(html.contains("<h1>Title</h1>"));
        assert!(html.contains("<table>"));
        // Ticked as the file says, and not to be ticked here.
        assert!(html.contains("<li><input disabled=\"\" type=\"checkbox\" checked=\"\">\ndone</li>"), "{html}");
        assert!(html.contains("<li><input disabled=\"\" type=\"checkbox\">\nnot</li>"), "{html}");
        assert!(html.contains("<del>gone</del>"));
    }

    #[test]
    fn leaving_out_anything_that_could_run_or_reach_out() {
        let html = rendered(
            "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[link](javascript:alert(1))\n\n<iframe src=https://example.com></iframe>\n\n<input type=text value=x>",
        );
        assert!(!html.contains("<script"));
        assert!(!html.contains("onerror"));
        assert!(!html.contains("javascript:"));
        assert!(!html.contains("<iframe"));
        assert!(!html.contains(r#"type="text""#));
    }

    #[test]
    fn keeping_what_readmes_use_for_layout() {
        let html = rendered(
            "<p align=\"center\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://example.com/dark.png\"><img src=\"https://example.com/light.png\" width=\"560\"></picture></p>\n\n<details><summary>More</summary>Hidden</details>",
        );
        assert!(html.contains(r#"<p align="center">"#));
        assert!(html.contains(r#"srcset="https://example.com/dark.png""#));
        assert!(html.contains(r#"media="(prefers-color-scheme: dark)""#));
        assert!(html.contains(r#"width="560""#));
        assert!(html.contains("<details><summary>More</summary>"));
    }

    #[test]
    fn showing_images_from_the_repository() {
        let dir = std::env::temp_dir().join(format!("palace-test-markdown-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs/images")).unwrap();
        std::fs::write(dir.join("docs/images/shot.png"), b"png!").unwrap();
        std::fs::write(dir.join("logo.svg"), b"<svg/>").unwrap();
        std::fs::write(dir.join("notes.txt"), b"not an image").unwrap();
        let render_doc = |text: &str| render(&dir, "docs/guide.md", text);

        // Relative to the file's folder, or the repository's root.
        assert!(render_doc("![shot](images/shot.png)").contains("data:image/png;base64,cG5nIQ=="));
        assert!(render_doc("![logo](../logo.svg)").contains("data:image/svg+xml;base64,"));
        assert!(render_doc("<img src=\"/logo.svg\">").contains("data:image/svg+xml;base64,"));
        // Not outside it, not what isn't an image, and not a link made into data.
        assert!(!render_doc("![x](../../etc/hosts.png)").contains("data:"));
        assert!(!render_doc("![x](../notes.txt)").contains("data:"));
        assert!(!render_doc("[shot](images/shot.png)").contains("data:"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn working_out_paths_inside_the_repository() {
        assert_eq!(normalize(Path::new("docs/../a.png")), Some(PathBuf::from("a.png")));
        assert_eq!(normalize(Path::new("./a/./b.png")), Some(PathBuf::from("a/b.png")));
        assert_eq!(normalize(Path::new("../a.png")), None);
        assert_eq!(normalize(Path::new("/etc/a.png")), None);
    }
}
