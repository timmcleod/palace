//! Throwaway repositories for tests.

use git2::{Commit, Oid, Repository, Signature};
use std::fs;
use std::path::{Path, PathBuf};

pub struct TempRepo {
    pub dir: PathBuf,
    pub repo: Repository,
}

impl TempRepo {
    pub fn new(name: &str) -> Self {
        let dir = Self::fresh_dir(name);
        Self::configured(dir.clone(), Repository::init(&dir).unwrap())
    }

    /// A bare repository, standing in for a remote like GitHub.
    pub fn bare(name: &str) -> Self {
        let dir = Self::fresh_dir(name);
        let repo = Repository::init_bare(&dir).unwrap();
        TempRepo { dir, repo }
    }

    pub fn clone_of(name: &str, remote: &TempRepo) -> Self {
        let dir = Self::fresh_dir(name);
        Self::configured(dir.clone(), Repository::clone(remote.path(), &dir).unwrap())
    }

    fn fresh_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("palace-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn configured(dir: PathBuf, repo: Repository) -> Self {
        // The git CLI needs an identity to commit, and shouldn't sign test commits.
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Ada Lovelace").unwrap();
        config.set_str("user.email", "ada@example.com").unwrap();
        config.set_bool("commit.gpgsign", false).unwrap();
        TempRepo { dir, repo }
    }

    pub fn head(&self) -> Oid {
        self.repo.head().unwrap().target().unwrap()
    }

    pub fn branch(&self) -> String {
        self.repo.head().unwrap().shorthand().unwrap().to_string()
    }

    /// Writes (or, for `None`, deletes) files in the working copy without staging them.
    pub fn write(&self, files: &[(&str, Option<&str>)]) {
        for (path, content) in files {
            match content {
                Some(content) => {
                    let file = self.dir.join(path);
                    fs::create_dir_all(file.parent().unwrap()).unwrap();
                    fs::write(file, content).unwrap();
                }
                None => fs::remove_file(self.dir.join(path)).unwrap(),
            }
        }
    }

    /// Writes the files, stages them and commits.
    pub fn commit(&self, files: &[(&str, Option<&str>)], message: &str) -> Oid {
        self.write(files);
        let mut index = self.repo.index().unwrap();
        for (path, content) in files {
            match content {
                Some(_) => index.add_path(Path::new(path)).unwrap(),
                None => index.remove_path(Path::new(path)).unwrap(),
            }
        }
        index.write().unwrap();
        let tree = self.repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Ada Lovelace", "ada@example.com").unwrap();
        let parent = self.repo.head().ok().map(|h| h.peel_to_commit().unwrap());
        let parents: Vec<&Commit> = parent.iter().collect();
        self.repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap()
    }

    pub fn path(&self) -> &str {
        self.dir.to_str().unwrap()
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
