# Palace

A Tauri desktop Git client: a Vue 3 page in `src/` and a Rust backend in
`src-tauri/src/`. Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing how things are
structured; it says where code belongs and why.

**Palace is meant to keep improving for years without breaking or getting messy, so
maintainability comes before speed.** When there's a choice, prefer the change that's
easier to understand, test and change later: fix the cause rather than work around it,
reuse what's there rather than add a second way, and leave code you touched at least as
clear as you found it. A feature isn't done until it's tested and the checks pass.

- **Before calling a change done,** run what it touched: `npm run lint`, `npm test` and
  `npm run build` for the page; `cargo clippy --all-targets -- -D warnings` and
  `cargo test` in `src-tauri/` for the backend. The build alone misses names used without
  being defined or imported; lint and `src/App.test.js` catch them.
- **Anything that changes a repository runs the `git` CLI** (`cli.rs`), never libgit2, so
  the user's hooks, signing and config apply. libgit2 is for reading.
- **A window action called from the page** (closing it, setting its title…) must be
  allowed in `src-tauri/capabilities/`, or it fails without an error.
- **Logic goes in `src/lib/`, with a test beside it,** not in `App.vue` or a component.
  Moving code keeps its behavior identical; write the tests first where there are none.
- **Errors the page acts on** are matched by the prefixes in `errors.js` / `errors.rs`,
  never by their wording.
- **`npm run tauri dev` reloads the page as it changes,** but needs restarting after
  backend or configuration changes, or when the page seems stuck after many reloads.
- **Comments say why,** and stay true when the code they describe changes.
