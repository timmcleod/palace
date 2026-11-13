//! What the backend keeps for each repository a window has open, by window and
//! repository: its file watcher, its history and its network work. Each repository's is
//! its own, so one loading or running doesn't wait for or replace another's, in the same
//! window or another; a window that's done with a repository lets go of its part, and one
//! that closes lets go of all of it.

use std::collections::HashMap;
use std::sync::Mutex;

/// A `T` for each repository, at its path, in each window, by label.
pub struct PerRepo<T>(Mutex<HashMap<(String, String), T>>);

impl<T> Default for PerRepo<T> {
    fn default() -> Self {
        Self(Mutex::default())
    }
}

impl<T: Clone + Default> PerRepo<T> {
    /// The repository's in the window, made as it's first asked for.
    pub fn of(&self, window: &str, path: &str) -> T {
        self.0.lock().unwrap().entry((window.to_string(), path.to_string())).or_default().clone()
    }
}

impl<T> PerRepo<T> {
    /// Puts `value` in place of whatever the repository had in the window.
    pub fn set(&self, window: &str, path: &str, value: T) {
        self.0.lock().unwrap().insert((window.to_string(), path.to_string()), value);
    }

    /// Takes away what the repository had in the window, as it's done with it.
    pub fn release(&self, window: &str, path: &str) -> Option<T> {
        self.0.lock().unwrap().remove(&(window.to_string(), path.to_string()))
    }

    /// Takes away everything the window had, as it closes.
    pub fn forget(&self, window: &str) -> Vec<T> {
        let mut all = self.0.lock().unwrap();
        let theirs: Vec<_> = all.keys().filter(|(w, _)| w == window).cloned().collect();
        theirs.into_iter().filter_map(|key| all.remove(&key)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn each_repository_in_each_window_has_its_own() {
        let kept: PerRepo<Arc<AtomicU32>> = PerRepo::default();
        kept.of("main", "/a").store(1, Ordering::SeqCst);
        kept.of("main", "/b").store(2, Ordering::SeqCst);
        kept.of("window-2", "/c").store(3, Ordering::SeqCst);
        assert_eq!(kept.of("main", "/a").load(Ordering::SeqCst), 1);
        assert_eq!(kept.of("main", "/b").load(Ordering::SeqCst), 2);
        assert_eq!(kept.of("window-2", "/c").load(Ordering::SeqCst), 3);
        // Asked for again, it's the same one, not a new one.
        assert!(Arc::ptr_eq(&kept.of("main", "/a"), &kept.of("main", "/a")));
    }

    #[test]
    fn letting_go_of_a_repository_leaves_the_windows_others() {
        let kept: PerRepo<u32> = PerRepo::default();
        kept.set("main", "/a", 1);
        kept.set("main", "/b", 2);
        kept.set("main", "/a", 3);
        assert_eq!(kept.release("main", "/a"), Some(3));
        assert_eq!(kept.release("main", "/a"), None);
        assert_eq!(kept.of("main", "/b"), 2);
    }

    #[test]
    fn a_window_closing_lets_go_of_all_its_repositories_and_no_others() {
        let kept: PerRepo<u32> = PerRepo::default();
        kept.set("main", "/a", 1);
        kept.set("main", "/b", 2);
        kept.set("window-2", "/c", 3);
        let mut gone = kept.forget("main");
        gone.sort();
        assert_eq!(gone, [1, 2]);
        assert!(kept.forget("main").is_empty());
        assert_eq!(kept.of("window-2", "/c"), 3);
    }
}
