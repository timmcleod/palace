//! Images shown in the page: which files are, and each as a data URL, as the page can't
//! read files itself. Used for the Files view, a commit's files, image diffs and the
//! images in a Markdown preview.

use base64::Engine;
use std::path::Path;

/// The image types shown, by extension, with the type each is sent as.
const TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("svg", "image/svg+xml"),
];

/// Larger images are described but not shown, so a stray huge one doesn't stall the page.
pub(crate) const MAX_IMAGE: usize = 10 * 1024 * 1024;

/// The type of image the file at `path` is, by its extension, or None if it isn't one.
pub(crate) fn image_type(path: impl AsRef<Path>) -> Option<&'static str> {
    let extension = path.as_ref().extension()?.to_str()?.to_ascii_lowercase();
    TYPES.iter().find(|(ext, _)| *ext == extension).map(|(_, mime)| *mime)
}

/// `bytes`, an image of type `mime`, as a URL the page can show.
pub(crate) fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telling_images_by_extension() {
        assert_eq!(image_type("docs/Logo.PNG"), Some("image/png"));
        assert_eq!(image_type("icon.svg"), Some("image/svg+xml"));
        assert_eq!(image_type("notes.txt"), None);
        assert_eq!(image_type("Makefile"), None);
        assert_eq!(data_url("image/png", b"png!"), "data:image/png;base64,cG5nIQ==");
    }
}
