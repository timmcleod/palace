# Architecture

How Palace is put together, and the habits that keep it workable. Palace is meant to
keep improving for years without breaking or getting messy, and most of what's here
serves that.

This is the map, not the territory: it says where things belong and why, and leaves the
details to the code and its comments, which are kept current where this can't be.

## The two halves

Palace is a [Tauri](https://tauri.app) app: a Rust backend and a web page shown in the
system's web view (WebKit on macOS and Linux).

- **The backend** (`src-tauri/src/`) does everything that touches the system: reading
  and changing repositories, terminals, files, windows, GitHub, notifications, saved
  data. Each file is one area, and most open with a comment saying what it's for.
- **The page** (`src/`) is a Vue 3 app. It shows what the backend reads and asks it to
  act. It has no access to the system of its own.

They talk in three ways:

- **Commands:** the page calls `invoke("name", args)`, and a `#[tauri::command]`
  function answers, or fails with a message. Every command is registered in `lib.rs`.
- **Events:** the backend tells a window something happened, as when a repository
  changes on disk, a terminal tab needs attention, or the window is asked to close.
- **Channels:** for streams, such as a terminal's output.

Anything the page can do to a window (close it, set its title and so on) must also be
allowed in `src-tauri/capabilities/`. A call that isn't allowed fails without a sound,
so a button that does nothing is worth checking there first.

## Repositories: read with libgit2, changed with git

Palace reads repositories directly with libgit2 (the `git2` crate), which is fast and
needs no process per read: history, status, diffs, branches.

Anything that **changes** a repository runs the user's own `git` (see `cli.rs`), so
their hooks, signing, credential helpers and config apply exactly as in a terminal.
Keep it that way: a change made through libgit2 would quietly skip all of that.

Changes that can be undone are recorded as before and after snapshots, and undo puts
back only what the operation changed, and only if nothing else has changed it since
(see `undo.rs` and `undo.js`).

## Windows

Each window holds repositories in tabs, across its top once there are two, each with
its own terminals, and a repository is open in one tab at a time: opening it again shows
that tab, and its window. The page tells the backend each window's tabs as they change
(`set_window_tabs`), so another window can find one, and Palace reopens them, with the
windows they were in, as it next starts, after quitting or restarting itself
(`reopen.rs`). The backend keeps track of what belongs to which window,
and lets it all go when the window closes. Code that keeps per-window state on the
backend should do the same.

What it keeps for a repository, its file watcher, its history and its network work, is
kept by window and repository (`per_repo.rs`), not by window alone, and the events they
send say which repository they're about. A tab done with a repository lets go of its
part (`release_repo`), and each tab's page hears only its own repository's events.

On a Mac, the File menu's New Tab and Close Tab take ⌘T and ⌘W (`menu.rs`), so Close
Window, on ⇧⌘W, is the one that closes every tab at once, asking first as the window's
close button does.

## The page

- **`App.vue`** is the window: what belongs to it, whatever tab is showing. It checks
  for git at startup, holds the tabs (`windowTabs.js` and `tabs.js`, drawn by
  `TabStrip.vue`), shows the dialogs and menus over everything, asks before the window
  closes or Palace quits, and hears what every window's agents are doing.
- **`components/Workspace.vue`** is a tab: the open repository, the state its views
  share (what's selected, the commit message being written) and the wiring between
  them, or with none open, the welcome screen. It should stay wiring. When a piece of
  it grows logic of its own, that logic moves out. Each is kept running while another
  shows, so what's meant for the whole window (a key, the menu, a notice, the window's
  title) is acted on only by the one showing, its `active` prop: composables take it as
  `active`, and components inside read it with `inActiveWorkspace()`. What's the
  window's to do, opening a tab or closing its own, it asks `App.vue` for, by events.
- **`src/lib/`** holds the logic, in plain modules. Some are composables, named
  `use…`, that own one job and its state for a tab, or the window: loading and
  refreshing the repository, the terminal panel, keyboard shortcuts, undo, navigation,
  the window's tabs and so on.
  Others are plain functions, such as building the sidebar's rows. Code here can be
  tested without the window, and that's the point of putting it here.
- **`src/components/`** holds the views. They show state and turn clicks and keys into
  calls. Logic that a component grows, and that could be tested on its own, belongs in
  `src/lib/` instead.

Refreshing works the same way throughout: the backend watches the repository and sends
an event when it changes, and the tab reloads the repository and tells each view to
read its part again. Views don't poll.

### Saved data

Settings, recent repositories and the like are saved by the backend in a file of its
own (see `store.rs`), not in the web view's storage, which can be lost when two windows
start at once. The page reads them through `storage.js`, which always falls back to a
default, since a saved value may be missing or from an older version.

### Errors

Most errors are shown to the user as they come, so they should read well on their own.
The few the page *acts on*, such as a conflict, a canceled operation or a folder that
isn't a repository, start with a fixed prefix. Those prefixes are defined once on each
side (`errors.rs` and `errors.js`), and a test keeps the two in step. Match on those,
never on an error's wording.

## Conventions

- **Comments say why.** What the code does should be clear from the code; a comment
  explains why it's done this way, especially when the obvious way was tried and didn't
  work. Keep comments true when changing the code they describe.
- **Tests sit beside what they test** (`thing.js` and `thing.test.js`), and test
  behavior, as a user or caller would see it, rather than how it's done.
- **Moving code doesn't change it.** A refactor keeps behavior identical, with tests
  that pass before and after. Write the tests first where the code isn't tested yet.
- **One thing, done once.** When the same logic turns up twice, it becomes a shared
  function or module rather than a second copy.
- **Look before adding.** Palace already has helpers for most common needs: dialogs and
  menus (`overlays.js`), the status card, platform differences (`platform.js`), saved
  data. Use them, so things look and behave the same everywhere. The same goes for
  styles: text sizes, corners and shadows come from the variables at the top of
  `styles.css`, and colors from the theme's.

## Checks

Run these before pushing. GitHub runs them too, on every push that changes the part
they check (`.github/workflows/`), so a push that breaks one shows up right away.

| | Page | Backend |
|---|---|---|
| Lint | `npm run lint` | `cargo clippy --all-targets -- -D warnings` |
| Tests | `npm test` | `cargo test` |
| Build | `npm run build` | `cargo build` |

Lint matters more than it looks: the build doesn't catch a name used without being
imported, or one a template uses that its component doesn't have. ESLint does.

`src/App.test.js` starts the whole window on a stand-in backend, and checks how its
pieces are wired together: opening and switching repositories, the backend's events, a
shortcut. The other page tests each take one piece on its own, so a mistake in how
`App.vue` and `Workspace.vue` wire the pieces together shows up only there.

Run the app with `npm run tauri dev`. Changes to the page reload in place, but changes
to the backend or its configuration need it restarted. If the page ever seems stuck in
a strange state after many reloads, restart it before suspecting the code.

## Releasing

```sh
npm run release -- 1.2.3 notes.md   # sets the version, commits and tags
git push --follow-tags              # GitHub builds, publishes and updates the website
```

The notes file holds only the release's own sections (such as `### Changes` and
`### Fixes`); the release workflow adds the heading and the install instructions. It
runs the backend tests again on each platform before building, but not the page's
checks, so push and let those pass first. Installed copies of Palace find the new
version on their own.
