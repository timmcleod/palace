use crate::cli;
use git2::{BranchType, ErrorCode, Oid, Repository, Sort};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

/// The most recently loaded history. Walking and laying out the graph happens once per
/// load; the list then fetches commit details page by page as it scrolls.
#[derive(Default)]
pub struct HistoryState(Mutex<Option<History>>);

struct History {
    generation: u64,
    path: String,
    rev: String,
    /// Set when the commits reachable from this revision are left out, to list only
    /// what `rev` has that it doesn't.
    hide: Option<String>,
    /// Set when only the commits that changed this file are listed.
    file: Option<String>,
    /// Set when only the commits matching this search are listed.
    search: Option<String>,
    fingerprint: String,
    rows: Vec<GraphRow>,
    times: Vec<i64>,
    lanes: u16,
    refs: HashMap<Oid, Vec<RefLabel>>,
    /// Commits on the branch's upstream that the branch doesn't have yet: fetched,
    /// but not pulled.
    incoming: HashSet<Oid>,
}

struct GraphRow {
    oid: Oid,
    graph: Graph,
}

/// How one commit's row of the graph is drawn. Lanes are columns; every line in a row
/// either passes straight through, runs from the top into the commit's dot, or runs
/// from the dot to the bottom towards a parent.
#[derive(Serialize, Clone)]
pub struct Graph {
    lane: u16,
    pass: Vec<u16>,
    merge_in: Vec<u16>,
    out: Vec<u16>,
}

#[derive(Serialize, Clone)]
pub struct RefLabel {
    name: String,
    /// "head", "local", "remote" or "tag".
    kind: &'static str,
}

#[derive(Serialize)]
pub struct HistorySummary {
    generation: u64,
    total: usize,
    lanes: u16,
    /// Author time of every commit, in list order, so the list can place month headers
    /// before it has loaded the commits themselves.
    times: Vec<i64>,
}

#[derive(Serialize)]
pub struct CommitRow {
    id: String,
    short_id: String,
    summary: String,
    author_name: String,
    author_email: String,
    time: i64,
    refs: Vec<RefLabel>,
    graph: Graph,
    incoming: bool,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Loads the history reachable from `rev` (HEAD when omitted), or with `file`, only
/// the commits that changed that file, and with `search`, only the commits matching
/// it. With `hide`, the commits reachable from that revision are left out, as in
/// `git log hide..rev`. If nothing has changed since the last load of the same
/// history, the cached walk is reused.
#[tauri::command]
pub async fn load_history(
    path: String,
    rev: Option<String>,
    hide: Option<String>,
    file: Option<String>,
    search: Option<String>,
    state: State<'_, HistoryState>,
) -> Result<HistorySummary, String> {
    let rev = rev.unwrap_or_else(|| "HEAD".to_string());
    let search = search.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    let repo = Repository::discover(&path).map_err(message)?;
    let fingerprint = fingerprint(&repo).map_err(message)?;

    let mut cache = state.0.lock().unwrap();
    if let Some(h) = cache.as_ref() {
        if h.path == path
            && h.rev == rev
            && h.hide == hide
            && h.file == file
            && h.search == search
            && h.fingerprint == fingerprint
        {
            return Ok(summary(h));
        }
    }

    let mut history = walk(&repo, path, rev, hide, file, fingerprint).map_err(message)?;
    if let Some(search) = search {
        keep_matches(&repo, &mut history, &search).map_err(message)?;
        history.search = Some(search);
    }
    let result = summary(&history);
    *cache = Some(history);
    Ok(result)
}

#[tauri::command]
pub async fn history_page(
    generation: u64,
    offset: usize,
    limit: usize,
    state: State<'_, HistoryState>,
) -> Result<Vec<CommitRow>, String> {
    let cache = state.0.lock().unwrap();
    let history = cache
        .as_ref()
        .filter(|h| h.generation == generation)
        .ok_or("The history changed while loading; reload it.")?;
    page(history, offset, limit).map_err(message)
}

/// Where commit `id` is in the loaded history, so the list can scroll to it; None if
/// it isn't there (or the history has since been reloaded).
#[tauri::command]
pub async fn history_position(generation: u64, id: String, state: State<'_, HistoryState>) -> Result<Option<usize>, String> {
    let cache = state.0.lock().unwrap();
    let Some(history) = cache.as_ref().filter(|h| h.generation == generation) else { return Ok(None) };
    let oid = Oid::from_str(&id).map_err(message)?;
    Ok(history.rows.iter().position(|row| row.oid == oid))
}

#[derive(Serialize)]
pub struct CommitSearch {
    /// How many commits match in all.
    total: usize,
    /// The newest of them, up to the limit asked for.
    commits: Vec<FoundCommit>,
}

#[derive(Serialize)]
pub struct FoundCommit {
    id: String,
    short_id: String,
    summary: String,
    author_name: String,
    time: i64,
}

/// Finds the commits reachable from `rev` (HEAD when omitted), and from its upstream,
/// that match `query`, for the toolbar's search.
#[tauri::command]
pub async fn search_commits(path: String, rev: Option<String>, query: String, limit: usize) -> Result<CommitSearch, String> {
    let rev = rev.unwrap_or_else(|| "HEAD".to_string());
    let repo = Repository::discover(&path).map_err(message)?;
    let query = query.trim().to_lowercase();
    let words: Vec<&str> = query.split_whitespace().collect();
    let mut found = CommitSearch { total: 0, commits: Vec::new() };
    if words.is_empty() {
        return Ok(found);
    }
    let Ok(start) = repo.revparse_single(&rev).and_then(|o| o.peel_to_commit()) else { return Ok(found) };

    let mut revwalk = repo.revwalk().map_err(message)?;
    revwalk.set_sorting(Sort::TIME).map_err(message)?;
    revwalk.push(start.id()).map_err(message)?;
    if let Some(upstream) = upstream_of(&repo, &rev) {
        revwalk.push(upstream).map_err(message)?;
    }
    for oid in revwalk {
        let commit = repo.find_commit(oid.map_err(message)?).map_err(message)?;
        if !matches(&commit, &words) {
            continue;
        }
        found.total += 1;
        if found.commits.len() < limit {
            let author = commit.author();
            found.commits.push(FoundCommit {
                id: commit.id().to_string(),
                short_id: commit.id().to_string()[..7].to_string(),
                summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
                author_name: author.name().unwrap_or("").to_string(),
                time: author.when().seconds(),
            });
        }
    }
    Ok(found)
}

/// The commits on any branch, local or remote, whose messages mention issue `number`
/// ("#42"), newest first, for that issue's view.
#[tauri::command]
pub async fn commits_mentioning(path: String, number: u64, limit: usize) -> Result<Vec<FoundCommit>, String> {
    let repo = Repository::discover(&path).map_err(message)?;
    let mut revwalk = repo.revwalk().map_err(message)?;
    revwalk.set_sorting(Sort::TIME).map_err(message)?;
    for glob in ["refs/heads", "refs/remotes"] {
        revwalk.push_glob(glob).map_err(message)?;
    }
    let mut found = Vec::new();
    for oid in revwalk {
        let commit = repo.find_commit(oid.map_err(message)?).map_err(message)?;
        if !mentions(commit.message().unwrap_or(""), number) {
            continue;
        }
        let author = commit.author();
        found.push(FoundCommit {
            id: commit.id().to_string(),
            short_id: commit.id().to_string()[..7].to_string(),
            summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
            author_name: author.name().unwrap_or("").to_string(),
            time: author.when().seconds(),
        });
        if found.len() == limit {
            break;
        }
    }
    Ok(found)
}

/// Whether `text` mentions issue `number` as "#42": not "#420", "abc#42" or "&#42;".
fn mentions(text: &str, number: u64) -> bool {
    let reference = format!("#{number}");
    text.match_indices(&reference).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + reference.len()..].chars().next();
        !before.is_some_and(|c| c.is_alphanumeric() || "_&/#".contains(c)) && !after.is_some_and(|c| c.is_ascii_digit())
    })
}

fn page(history: &History, offset: usize, limit: usize) -> Result<Vec<CommitRow>, git2::Error> {
    let repo = Repository::discover(&history.path)?;

    let end = (offset + limit).min(history.rows.len());
    let start = offset.min(end);
    history.rows[start..end]
        .iter()
        .map(|row| {
            let commit = repo.find_commit(row.oid)?;
            let author = commit.author();
            Ok(CommitRow {
                id: row.oid.to_string(),
                short_id: row.oid.to_string()[..7].to_string(),
                summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
                author_name: author.name().unwrap_or("").to_string(),
                author_email: author.email().unwrap_or("").to_string(),
                time: author.when().seconds(),
                refs: history.refs.get(&row.oid).cloned().unwrap_or_default(),
                graph: row.graph.clone(),
                incoming: history.incoming.contains(&row.oid),
            })
        })
        .collect()
}

fn summary(h: &History) -> HistorySummary {
    HistorySummary {
        generation: h.generation,
        total: h.rows.len(),
        lanes: h.lanes,
        times: h.times.clone(),
    }
}

fn message(e: git2::Error) -> String {
    e.message().to_string()
}

/// A cheap identity for the repository's current refs. If no ref has moved, the
/// history hasn't changed and the walk can be skipped.
fn fingerprint(repo: &Repository) -> Result<String, git2::Error> {
    let mut parts = Vec::new();
    for reference in repo.references()? {
        let reference = reference?;
        let target = reference.target().map(|o| o.to_string()).unwrap_or_default();
        parts.push(format!("{}={}", reference.name().unwrap_or(""), target));
    }
    parts.sort();
    let head = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
    parts.push(format!("HEAD={}", head.unwrap_or_default()));
    Ok(parts.join("\n"))
}

fn walk(
    repo: &Repository,
    path: String,
    rev: String,
    hide: Option<String>,
    file: Option<String>,
    fingerprint: String,
) -> Result<History, git2::Error> {
    let mut history = History {
        generation: GENERATION.fetch_add(1, Ordering::Relaxed) + 1,
        path,
        rev,
        hide,
        file,
        search: None,
        fingerprint,
        rows: Vec::new(),
        times: Vec::new(),
        lanes: 0,
        refs: ref_labels(repo)?,
        incoming: HashSet::new(),
    };

    let start = match repo.revparse_single(&history.rev).and_then(|o| o.peel_to_commit()) {
        Ok(commit) => commit.id(),
        // A repository without commits simply has an empty history.
        Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => {
            return Ok(history);
        }
        Err(e) => return Err(e),
    };

    // A branch's history includes what's been fetched for it but not pulled yet, so new
    // commits on the remote show up as soon as they're fetched. Not when comparing,
    // which is about exactly the two revisions.
    let mut starts = vec![start];
    let upstream = if history.hide.is_some() { None } else { upstream_of(repo, &history.rev) };
    if let Some(upstream) = upstream.filter(|u| *u != start) {
        let mut ahead = repo.revwalk()?;
        ahead.push(upstream)?;
        ahead.hide(start)?;
        history.incoming = ahead.collect::<Result<_, _>>()?;
        starts.push(upstream);
    }

    if let Some(file) = &history.file {
        let ids = file_commits(&history.path, &starts, file).map_err(|e| git2::Error::from_str(&e))?;
        for oid in &ids {
            history.times.push(repo.find_commit(*oid)?.author().when().seconds());
        }
        history.rows = straight_line(ids);
        history.lanes = history.rows.len().min(1) as u16;
        return Ok(history);
    }

    let mut revwalk = repo.revwalk()?;
    revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    for oid in &starts {
        revwalk.push(*oid)?;
    }
    if let Some(hide) = &history.hide {
        revwalk.hide(repo.revparse_single(hide)?.peel_to_commit()?.id())?;
    }

    let mut lanes = Vec::new();
    for oid in revwalk {
        let commit = repo.find_commit(oid?)?;
        let parents: Vec<Oid> = commit.parent_ids().collect();
        let graph = place(&mut lanes, commit.id(), &parents);

        let widest = graph.pass.iter().chain(&graph.merge_in).chain(&graph.out).max().copied();
        history.lanes = history.lanes.max(widest.unwrap_or(0).max(graph.lane) + 1);
        history.times.push(commit.author().when().seconds());
        history.rows.push(GraphRow { oid: commit.id(), graph });
    }

    Ok(history)
}

/// Rows for commits listed one after another, without their real ancestry: a single
/// straight line.
fn straight_line(ids: Vec<Oid>) -> Vec<GraphRow> {
    let last = ids.len().saturating_sub(1);
    ids.into_iter()
        .enumerate()
        .map(|(i, oid)| GraphRow {
            oid,
            graph: Graph {
                lane: 0,
                pass: Vec::new(),
                merge_in: if i > 0 { vec![0] } else { Vec::new() },
                out: if i < last { vec![0] } else { Vec::new() },
            },
        })
        .collect()
}

/// Narrows the history to the commits matching `search` (already lowercase). Every
/// word must appear in the message or the author's name or email, or start the hash.
fn keep_matches(repo: &Repository, history: &mut History, search: &str) -> Result<(), git2::Error> {
    let words: Vec<&str> = search.split_whitespace().collect();
    let mut ids = Vec::new();
    let mut times = Vec::new();
    for (row, time) in history.rows.iter().zip(&history.times) {
        if matches(&repo.find_commit(row.oid)?, &words) {
            ids.push(row.oid);
            times.push(*time);
        }
    }
    history.rows = straight_line(ids);
    history.times = times;
    history.lanes = history.rows.len().min(1) as u16;
    Ok(())
}

/// Whether every word (lowercase) appears in the commit's message or its author's name
/// or email, or starts its hash.
fn matches(commit: &git2::Commit, words: &[&str]) -> bool {
    let author = commit.author();
    let text = format!(
        "{}\n{}\n{}",
        commit.message().ok().unwrap_or(""),
        author.name().unwrap_or(""),
        author.email().unwrap_or("")
    )
    .to_lowercase();
    let hash = commit.id().to_string();
    words.iter().all(|w| text.contains(w) || hash.starts_with(w))
}

/// Where the upstream of the branch shown by `rev` ("HEAD" or "refs/heads/…") is.
fn upstream_of(repo: &Repository, rev: &str) -> Option<Oid> {
    let name = match rev.strip_prefix("refs/heads/") {
        Some(name) => name.to_string(),
        None if rev == "HEAD" => repo.head().ok().filter(|h| h.is_branch())?.shorthand().ok()?.to_string(),
        None => return None,
    };
    repo.find_branch(&name, BranchType::Local).ok()?.upstream().ok()?.get().target()
}

/// The commits from `starts` back that changed `file`, newest first. Git follows the
/// file through renames, which a plain revwalk can't do cheaply.
fn file_commits(path: &str, starts: &[Oid], file: &str) -> Result<Vec<Oid>, String> {
    let starts: Vec<String> = starts.iter().map(Oid::to_string).collect();
    let mut args = vec!["log", "--format=%H", "--follow"];
    args.extend(starts.iter().map(String::as_str));
    args.extend(["--", file]);
    let output = cli::git(path, &args, None)?;
    Ok(output.lines().filter_map(|line| Oid::from_str(line.trim()).ok()).collect())
}

/// Places one commit in the graph. `lanes` holds, for each column, the commit that the
/// line in that column is heading towards; it is updated for the next row.
fn place(lanes: &mut Vec<Option<Oid>>, oid: Oid, parents: &[Oid]) -> Graph {
    let mut pass = Vec::new();
    let mut merge_in = Vec::new();
    for (i, expected) in lanes.iter().enumerate() {
        match expected {
            Some(e) if *e == oid => merge_in.push(i as u16),
            Some(_) => pass.push(i as u16),
            None => {}
        }
    }

    // A commit nothing points to yet (a branch tip) starts in the first free column.
    let lane = match merge_in.first() {
        Some(&l) => l as usize,
        None => free_lane(lanes),
    };
    for &i in &merge_in {
        lanes[i as usize] = None;
    }

    let mut out = Vec::new();
    for (n, parent) in parents.iter().enumerate() {
        // A parent another line is already heading towards joins that line.
        if let Some(existing) = lanes.iter().position(|l| *l == Some(*parent)) {
            out.push(existing as u16);
            continue;
        }
        // The first parent continues straight down; the others branch off to the side.
        let target = if n == 0 && lanes[lane].is_none() { lane } else { free_lane(lanes) };
        lanes[target] = Some(*parent);
        out.push(target as u16);
    }

    while lanes.last() == Some(&None) {
        lanes.pop();
    }

    Graph { lane: lane as u16, pass, merge_in, out }
}

fn free_lane(lanes: &mut Vec<Option<Oid>>) -> usize {
    match lanes.iter().position(Option::is_none) {
        Some(i) => i,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}

/// Labels for every commit that a ref points at, ordered HEAD, local branches,
/// remote branches, then tags.
fn ref_labels(repo: &Repository) -> Result<HashMap<Oid, Vec<RefLabel>>, git2::Error> {
    let mut labels: HashMap<Oid, Vec<RefLabel>> = HashMap::new();

    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            labels.entry(oid).or_default().push(RefLabel { name: "HEAD".into(), kind: "head" });
        }
    }

    let mut others = Vec::new();
    for reference in repo.references()? {
        let reference = reference?;
        // Skip symbolic refs like origin/HEAD; they only point at another ref.
        if reference.symbolic_target()?.is_some() {
            continue;
        }
        let kind = if reference.is_branch() {
            "local"
        } else if reference.is_remote() {
            "remote"
        } else if reference.is_tag() {
            "tag"
        } else {
            continue;
        };
        // Annotated tags point at a tag object; peel through to the commit.
        let Ok(commit) = reference.peel_to_commit() else { continue };
        let name = reference.shorthand().unwrap_or("").to_string();
        others.push((commit.id(), RefLabel { name, kind }));
    }

    let rank = |kind: &str| ["local", "remote", "tag"].iter().position(|k| *k == kind);
    others.sort_by(|(_, a), (_, b)| rank(a.kind).cmp(&rank(b.kind)).then(a.name.cmp(&b.name)));
    for (oid, label) in others {
        labels.entry(oid).or_default().push(label);
    }

    Ok(labels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentioning_issues() {
        assert!(mentions("Fix scrolling (#42)", 42));
        assert!(mentions("#42 at the start", 42));
        assert!(mentions("Fixes #42.\n\nAlso #7", 7));
        assert!(!mentions("Fixes #420", 42));
        assert!(!mentions("abc#42 and &#42; and https://x.com/a#42", 42));
        assert!(!mentions("No issue here", 42));
    }

    fn oid(n: u8) -> Oid {
        Oid::from_bytes(&[n; 20]).unwrap()
    }

    #[test]
    fn file_history_follows_renames() {
        let t = crate::test_support::TempRepo::new("file-history");
        let first = t.commit(&[("old.txt", Some("one\ntwo\nthree\nfour\n"))], "Add");
        t.commit(&[("other.txt", Some("x"))], "Unrelated");
        let moved = t.commit(&[("old.txt", None), ("new.txt", Some("one\ntwo\nthree\nfour\n"))], "Rename");
        let edited = t.commit(&[("new.txt", Some("one\ntwo\nthree\nfour\nfive\n"))], "Edit");

        let repo = Repository::open(t.path()).unwrap();
        let history = walk(&repo, t.path().into(), "HEAD".into(), None, Some("new.txt".into()), String::new()).unwrap();
        let ids: Vec<Oid> = history.rows.iter().map(|r| r.oid).collect();
        assert_eq!(ids, [edited, moved, first]);
        assert_eq!(history.rows[0].graph.out, [0]);
        assert!(history.rows[2].graph.out.is_empty());
    }

    #[test]
    fn search_keeps_commits_matching_every_word() {
        let t = crate::test_support::TempRepo::new("history-search");
        let login = t.commit(&[("a.txt", Some("a"))], "Fix the login form\n\nThe button was hidden.");
        t.commit(&[("b.txt", Some("b"))], "Add a settings page");
        let hidden = t.commit(&[("c.txt", Some("c"))], "Show hidden files");

        let repo = Repository::open(t.path()).unwrap();
        let search = |query: &str| {
            let mut history = walk(&repo, t.path().into(), "HEAD".into(), None, None, String::new()).unwrap();
            keep_matches(&repo, &mut history, query).unwrap();
            history.rows.iter().map(|r| r.oid).collect::<Vec<_>>()
        };

        // The body counts, not just the summary.
        assert_eq!(search("hidden"), [hidden, login]);
        assert_eq!(search("button hidden"), [login]);
        assert_eq!(search(&hidden.to_string()[..7]), [hidden]);
        assert_eq!(search("ada@example.com lovelace").len(), 3);
        assert!(search("nothing like this").is_empty());

        let mut history = walk(&repo, t.path().into(), "HEAD".into(), None, None, String::new()).unwrap();
        keep_matches(&repo, &mut history, "hidden").unwrap();
        assert_eq!(history.times.len(), 2);
        assert_eq!(history.rows[0].graph.out, [0]);
        assert!(history.rows[1].graph.out.is_empty());

        let found = tauri::async_runtime::block_on(search_commits(t.path().into(), None, " Hidden ".into(), 1)).unwrap();
        assert_eq!(found.total, 2);
        assert_eq!(found.commits.len(), 1);
        assert_eq!(found.commits[0].summary, "Show hidden files");
        assert_eq!(found.commits[0].id, hidden.to_string());
    }

    #[test]
    fn fetched_commits_show_in_the_branch_history() {
        use crate::test_support::TempRepo;
        let remote = TempRepo::bare("incoming-remote");
        let mine = TempRepo::clone_of("incoming-mine", &remote);
        mine.commit(&[("a.txt", Some("1"))], "First");
        crate::cli::git(mine.path(), &["push", "-u", "origin", "HEAD"], None).unwrap();

        let theirs = TempRepo::clone_of("incoming-theirs", &remote);
        let pushed = theirs.commit(&[("b.txt", Some("2"))], "Theirs");
        crate::cli::git(theirs.path(), &["push"], None).unwrap();
        let local = mine.commit(&[("c.txt", Some("3"))], "Mine");
        crate::cli::git(mine.path(), &["fetch"], None).unwrap();

        let history = walk(&mine.repo, mine.path().into(), "HEAD".into(), None, None, String::new()).unwrap();
        let ids: HashSet<Oid> = history.rows.iter().map(|r| r.oid).collect();
        assert!(ids.contains(&pushed) && ids.contains(&local));
        assert_eq!(history.incoming, HashSet::from([pushed]));

        // A remote branch's own history has nothing "incoming".
        let remote_history = walk(&mine.repo, mine.path().into(), "refs/remotes/origin/main".into(), None, None, String::new());
        assert!(remote_history.map(|h| h.incoming.is_empty()).unwrap_or(true));
    }

    #[test]
    fn hiding_a_revision_lists_only_what_rev_adds() {
        let mine = crate::test_support::TempRepo::new("hide-mine");
        let remote = crate::test_support::TempRepo::bare("hide-remote");
        mine.commit(&[("a.txt", Some("1"))], "First");
        crate::cli::git(mine.path(), &["remote", "add", "origin", remote.path()], None).unwrap();
        crate::cli::git(mine.path(), &["push", "-u", "origin", "HEAD"], None).unwrap();
        let main = mine.branch();
        crate::cli::git(mine.path(), &["switch", "-q", "-c", "feature"], None).unwrap();
        let added = mine.commit(&[("b.txt", Some("2"))], "Feature");

        let history = walk(&mine.repo, mine.path().into(), "feature".into(), Some(main), None, String::new()).unwrap();
        assert_eq!(history.rows.iter().map(|r| r.oid).collect::<Vec<_>>(), [added]);
        assert!(history.incoming.is_empty());
    }

    #[test]
    fn linear_history_stays_in_one_lane() {
        let mut lanes = Vec::new();
        let a = place(&mut lanes, oid(3), &[oid(2)]);
        let b = place(&mut lanes, oid(2), &[oid(1)]);
        let c = place(&mut lanes, oid(1), &[]);

        assert_eq!((a.lane, a.merge_in.clone(), a.out.clone()), (0, vec![], vec![0]));
        assert_eq!((b.lane, b.merge_in.clone(), b.out.clone()), (0, vec![0], vec![0]));
        assert_eq!((c.lane, c.merge_in.clone(), c.out.clone()), (0, vec![0], vec![]));
        assert!(lanes.is_empty());
    }

    #[test]
    fn merge_opens_a_second_lane_that_rejoins_at_the_fork_point() {
        // 4 merges 3 (its first parent) and 2; both descend from 1.
        let mut lanes = Vec::new();
        let merge = place(&mut lanes, oid(4), &[oid(3), oid(2)]);
        let first = place(&mut lanes, oid(3), &[oid(1)]);
        let second = place(&mut lanes, oid(2), &[oid(1)]);
        let base = place(&mut lanes, oid(1), &[]);

        assert_eq!((merge.lane, merge.out.clone()), (0, vec![0, 1]));
        assert_eq!((first.lane, first.pass.clone(), first.out.clone()), (0, vec![1], vec![0]));
        // Commit 2 sits in lane 1 and its line joins lane 0, which already leads to 1.
        assert_eq!((second.lane, second.pass.clone(), second.out.clone()), (1, vec![0], vec![0]));
        assert_eq!((base.lane, base.merge_in.clone()), (0, vec![0]));
    }
}
