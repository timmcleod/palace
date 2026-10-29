<p align="center">
  <img src="src-tauri/icons/icon.svg" width="96" height="96" alt="">
</p>

<h1 align="center">Palace</h1>

<p align="center">
  A fast, beautifully simple Git client for Linux and macOS.<br>
  <a href="https://timmcleod.github.io/palace/"><strong>Website</strong></a> ·
  <a href="https://github.com/timmcleod/palace/releases/latest"><strong>Download</strong></a> ·
  <a href="LICENSE">MIT license</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://timmcleod.github.io/palace/assets/hero-dark.webp">
    <img src="https://timmcleod.github.io/palace/assets/hero-light.webp" width="900" alt="Palace showing a repository's commit history with its branch graph, and the selected commit's details and diff">
  </picture>
</p>

## Features

- **History:** every commit on a branch graph, grouped by month, for HEAD or any branch, remote branch, tag or stash. Search files and commits together with Ctrl+F (⌘F on a Mac), browse each commit's files, and blame them line by line.
- **Diffs:** unified or side by side, with the changed words within each line highlighted. Images show old and new versions side by side.
- **Working copy:** stage, unstage or discard whole files, single chunks or individual lines. Discarded changes go to the Trash. Commit, amend, and stash everything or just the files you pick.
- **Branches:** drag a branch onto HEAD to merge it, drag branches into your own order with labeled dividers between groups, and drag commits to reorder or squash them. Rebase, cherry-pick, revert, reset and edit commit messages from a right-click. Compare any two branches or tags, and resolve conflicts one block at a time.
- **Remotes:** fetch, pull and push with live progress and Cancel, and fetch in the background every few minutes. Publish new branches, and manage tags, remote branches and remotes.
- **GitHub:** sign in to clone your repositories, create new ones and manage SSH keys.
- **Real Git underneath:** Palace runs your own `git` for every change, so your hooks, commit signing, SSH agent, credential helpers and `.gitconfig` work exactly as they do in a terminal.

Palace updates itself when a new release comes out. See the [website](https://timmcleod.github.io/palace/) for a tour.

## Install

Download the latest package from [Releases](https://github.com/timmcleod/palace/releases/latest).

### Linux

```sh
# Ubuntu, Debian and derivatives (installs Git too if it's missing)
sudo apt install ./Palace_*.deb

# Any distribution
chmod +x Palace_*.AppImage
./Palace_*.AppImage
```

Palace needs Git 2.27 or newer and checks for it at startup. The AppImage also needs `libfuse2` on Ubuntu 22.04 and later (`libfuse2t64` on 24.04 and later).

### macOS

macOS 11 or later, on Apple Silicon or Intel. Open the `.dmg` and drag Palace to Applications.

Palace isn't signed by Apple yet, so the first time you open it, macOS refuses. Go to System Settings › Privacy & Security and click **Open Anyway**. If macOS says Palace is damaged, run `xattr -cr /Applications/Palace.app` in Terminal and open it again.

If Git isn't installed, Palace offers to install Apple's Command Line Tools, which include it.

## Development

Palace is built with [Tauri](https://tauri.app): a Vue 3 frontend in `src/` and a Rust backend in `src-tauri/src/`. The backend reads repositories with [git2](https://crates.io/crates/git2) and runs the `git` CLI for anything that changes them.

You need Rust and Node.js 22 or newer. On macOS, the Xcode Command Line Tools (`xcode-select --install`) are the only other thing you need. On Linux, you also need the system libraries Tauri uses:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Then:

```sh
npm install
npm run tauri dev               # run the app, reloading as you edit
cd src-tauri && cargo test      # run the backend tests
npm run package                 # build the packages into src-tauri/target/release/bundle/
```

## License

[MIT](LICENSE)
