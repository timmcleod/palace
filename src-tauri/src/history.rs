use git2::{ErrorCode, Oid, Repository, Sort};
use serde::Serialize;
use std::collections::HashMap;
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
    fingerprint: String,
    rows: Vec<GraphRow>,
    times: Vec<i64>,
    lanes: u16,
    refs: HashMap<Oid, Vec<RefLabel>>,
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
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Loads the history reachable from `rev` (HEAD when omitted). If nothing has changed
/// since the last load of the same history, the cached walk is reused.
#[tauri::command]
pub async fn load_history(
    path: String,
    rev: Option<String>,
    state: State<'_, HistoryState>,
) -> Result<HistorySummary, String> {
    let rev = rev.unwrap_or_else(|| "HEAD".to_string());
    let repo = Repository::discover(&path).map_err(message)?;
    let fingerprint = fingerprint(&repo).map_err(message)?;

    let mut cache = state.0.lock().unwrap();
    if let Some(h) = cache.as_ref() {
        if h.path == path && h.rev == rev && h.fingerprint == fingerprint {
            return Ok(summary(h));
        }
    }

    let history = walk(&repo, path, rev, fingerprint).map_err(message)?;
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

fn walk(repo: &Repository, path: String, rev: String, fingerprint: String) -> Result<History, git2::Error> {
    let mut history = History {
        generation: GENERATION.fetch_add(1, Ordering::Relaxed) + 1,
        path,
        rev,
        fingerprint,
        rows: Vec::new(),
        times: Vec::new(),
        lanes: 0,
        refs: ref_labels(repo)?,
    };

    let start = match repo.revparse_single(&history.rev).and_then(|o| o.peel_to_commit()) {
        Ok(commit) => commit.id(),
        // A repository without commits simply has an empty history.
        Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => {
            return Ok(history);
        }
        Err(e) => return Err(e),
    };

    let mut revwalk = repo.revwalk()?;
    revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    revwalk.push(start)?;

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

    fn oid(n: u8) -> Oid {
        Oid::from_bytes(&[n; 20]).unwrap()
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
