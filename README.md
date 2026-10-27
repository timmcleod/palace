# Palace

A desktop Git client for Linux.

- **History** — every commit with a branch graph, grouped by month, for HEAD or any branch, remote branch, tag or stash.
- **Commit details** — author, dates, refs and message, with each changed file's diff.
- **Working copy** — stage and unstage whole files or single hunks, discard changes (the old version goes to the Trash), commit and amend.
- **Remotes** — fetch, pull and push with live progress, using your existing SSH agent and credential helpers.

Palace runs the `git` command for everything that changes a repository, so your hooks, commit signing and `.gitconfig` apply exactly as they do in a terminal.

## Install

Build the packages (see below), then install one:

```sh
# Ubuntu / Debian
sudo apt install ./Palace_0.1.0_amd64.deb

# Any distribution
chmod +x Palace_0.1.0_amd64.AppImage
./Palace_0.1.0_amd64.AppImage
```

The `.deb` installs `git` if it's missing. The AppImage expects `git` to be installed already.

## Build

You need Rust, Node.js 22+, and the system libraries Tauri uses:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Then:

```sh
npm install
npm run package
```

The packages are written to `src-tauri/target/release/bundle/deb/` and `src-tauri/target/release/bundle/appimage/`.

## Develop

```sh
npm run tauri dev
```

This opens the app and reloads it as you edit. The frontend is Vue 3 (`src/`); the backend is Rust (`src-tauri/src/`), reading repositories with [git2](https://crates.io/crates/git2) and running the `git` CLI for changes. Run the backend tests with:

```sh
cd src-tauri && cargo test
```

The app icon's source is `src-tauri/icons/icon.svg`. After editing it, render a 1024×1024 PNG and regenerate the sizes with `npx tauri icon path/to/icon.png`.

## License

MIT
