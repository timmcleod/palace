<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/palace-dark.webp">
    <img src=".github/readme/palace-light.webp" width="560" alt="Palace">
  </picture>
</p>

<p align="center">
  Run your agent. Review its work. Ship it.<br>
  Claude Code, your files and a full Git client in one fast window, for Linux and macOS.<br>
  <a href="https://timmcleod.github.io/palace/"><strong>Website</strong></a> ·
  <a href="https://github.com/timmcleod/palace/releases/latest"><strong>Download</strong></a> ·
  <a href="LICENSE">MIT license</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://timmcleod.github.io/palace/assets/hero-dark.webp">
    <img src="https://timmcleod.github.io/palace/assets/hero-light.webp" width="900" alt="Palace showing a repository's Working Copy and the diff of a changed file, with Claude Code running in a Claude tab below">
  </picture>
</p>

## Features

When your agent writes the code, your job is steering it, reading what it changed and deciding what to commit. Palace keeps all of that in one window.

- **Claude Code:** a Claude tab starts Claude Code in the repository you're looking at, with a command you set for each repository, and its changes appear in the Working Copy as it works. Ordinary terminal tabs sit beside it for your dev server or tests, and keep running while you look at another repository.
- **Files:** browse the working copy and edit files in place, with syntax highlighting, marks on lines changed since the last commit, Ctrl+P (⌘P on a Mac) to find a file, and colorful icons by file type. Palace isn't an IDE: no autocomplete, debugger or plugins, on purpose.
- **Windows:** open a window for each repository with Ctrl+N (⌘N), each with its own terminals. Closing a window or quitting with a busy terminal or an unsaved file asks first.
- **History:** every commit on a branch graph, grouped by month, for HEAD or any branch, remote branch, tag or stash. Search files and commits together with Ctrl+F (⌘F on a Mac), browse each commit's files, and blame them line by line.
- **Diffs:** unified or side by side, with the changed words within each line highlighted. Images show old and new versions side by side.
- **Working copy:** stage, unstage or discard whole files, single chunks or individual lines. Discarded changes go to the Trash. Commit, amend, and stash everything or just the files you pick.
- **Branches:** drag a branch onto HEAD to merge it, drag branches into your own order with labeled dividers between groups, and drag commits to reorder or squash them. Rebase, cherry-pick, revert, reset and edit commit messages from a right-click. Compare any two branches or tags, and resolve conflicts one block at a time.
- **Remotes:** fetch, pull and push with live progress and Cancel, and fetch in the background every few minutes. Publish new branches, and manage tags, remote branches and remotes.
- **GitHub:** sign in to see the repository's issues and pull requests in the sidebar: filter, comment, label, create pull requests and merge them. Clone your repositories, create new ones and manage SSH keys.
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

File and folder icons are from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme), also MIT licensed. Its license is included with them, in `file-icons/LICENSE`.
