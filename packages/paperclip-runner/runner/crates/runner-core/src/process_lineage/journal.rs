//! The durable lineage journal and the reaper that reads it.
//!
//! When runnerd itself dies (for example SIGKILL in the middle of a tool call),
//! the provider and its tools are re-parented and the in-memory record goes
//! with runnerd. Durable runnerd therefore journals every record to
//! `<state-dir>/process-lineage/` from the moment the provider is spawned.
//! After runnerd's exit is confirmed, `paperclip-runnerd reap-lineage` reads
//! those journals, stops every process that still matches a recorded
//! identity, and proves the lineage gone. It applies the same PID-and-start
//! rules as the in-process tracker, so a reused PID is never signalled.
//!
//! This is its own module because it is a separate durability boundary: the
//! on-disk format, the write and withdrawal rules, and the cross-process
//! reaper change independently of the in-process sampling rules in the
//! parent module, which it reuses through `LineageState`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{read_process_table, signal_member, LineageState, ProcessEntry, ProcessTable};

impl LineageState {
    fn journal_record(&self, writer: ProcessIdentity, sampled_through: u64) -> JournalRecord {
        let sorted = |map: &HashMap<i32, u64>| {
            let mut entries: Vec<(i32, u64)> = map.iter().map(|(k, v)| (*k, *v)).collect();
            entries.sort_unstable();
            entries
        };
        JournalRecord {
            schema: JOURNAL_SCHEMA.to_owned(),
            writer,
            // A root whose start time is unknown cannot be told apart from a
            // reused PID, so it is never journalled as an identity.
            root: self.root.filter(|(_, started)| *started != 0),
            members: sorted(&self.members),
            groups: sorted(&self.groups),
            sessions: sorted(&self.sessions),
            sampled_through,
        }
    }

    fn from_journal_record(record: &JournalRecord) -> Self {
        Self {
            root: record.root,
            members: record.members.iter().copied().collect(),
            groups: record.groups.iter().copied().collect(),
            sessions: record.sessions.iter().copied().collect(),
        }
    }
}

/// Schema of one journalled lineage record.
const JOURNAL_SCHEMA: &str = "paperclip.runner.process-lineage.v1";
/// Schema of the marker a journalling runnerd writes before any provider.
const WRITER_SCHEMA: &str = "paperclip.runner.process-lineage-writer.v1";
/// Schema of the reaper's report.
pub const REAP_REPORT_SCHEMA: &str = "paperclip.runner.process-lineage-reap.v1";
const JOURNAL_DIRECTORY_NAME: &str = "process-lineage";

static JOURNAL_DIRECTORY: OnceLock<(PathBuf, ProcessIdentity)> = OnceLock::new();
static JOURNAL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A process named by PID and start time, which together cannot be reused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProcessIdentity {
    pid: i32,
    started: u64,
}

impl ProcessIdentity {
    fn current() -> Option<Self> {
        let pid = i32::try_from(std::process::id()).ok()?;
        let entry = paperclip_process_table::read(pid).entry()?;
        Some(Self {
            pid,
            started: entry.started,
        })
    }

    /// True while the exact process still exists. An unreadable process is
    /// treated as alive: its exit is not established.
    fn is_alive(self) -> bool {
        match paperclip_process_table::read(self.pid) {
            paperclip_process_table::Read::Present(entry) => {
                entry.started == self.started && !entry.zombie
            }
            paperclip_process_table::Read::Gone => false,
            paperclip_process_table::Read::Unreadable => true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct JournalRecord {
    schema: String,
    writer: ProcessIdentity,
    root: Option<(i32, u64)>,
    members: Vec<(i32, u64)>,
    groups: Vec<(i32, u64)>,
    sessions: Vec<(i32, u64)>,
    /// The newest process start time the recording read had listed. A
    /// process that started later was never seen, so the record cannot
    /// account for it.
    #[serde(default)]
    sampled_through: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct WriterMarker {
    schema: String,
    writer: ProcessIdentity,
}

/// One supervised process's journal file.
pub(super) struct Journal {
    path: PathBuf,
    marker: PathBuf,
    writer: ProcessIdentity,
    last: Mutex<JournalWrite>,
}

#[derive(Default)]
struct JournalWrite {
    /// The membership last written, without `sampled_through`.
    membership: String,
    sampled_through: u64,
    at: Option<Instant>,
}

/// How often an unchanged record is rewritten only to advance
/// `sampled_through`. A shorter interval narrows the window a reaper must
/// treat as unsampled, at one small write per interval.
const SAMPLED_THROUGH_REFRESH: Duration = Duration::from_secs(1);

impl Journal {
    pub(super) fn create(state: &LineageState) -> io::Result<Option<Self>> {
        let Some((directory, writer)) = JOURNAL_DIRECTORY.get() else {
            return Ok(None);
        };
        let sequence = JOURNAL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let journal = Self {
            path: directory.join(format!("lineage-{}-{sequence}.json", writer.pid)),
            marker: directory.join(format!("writer-{}.json", writer.pid)),
            writer: *writer,
            last: Mutex::new(JournalWrite::default()),
        };
        // Nothing the root starts can predate the root itself.
        let sampled_through = state.root.map_or(0, |(_, started)| started);
        journal.write(state, sampled_through)?;
        Ok(Some(journal))
    }

    /// Writes the record when membership changed, or when only
    /// `sampled_through` advanced and the last write is older than the
    /// refresh interval. A failed write removes the writer marker: removal
    /// needs no free space, and without the marker no reaper can verify this
    /// runnerd's lineage from a record that may be missing a member.
    pub(super) fn write(&self, state: &LineageState, sampled_through: u64) -> io::Result<()> {
        let membership = serde_json::to_string(&state.journal_record(self.writer, 0))
            .map_err(io::Error::other)?;
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let advanced = sampled_through > last.sampled_through
            && last
                .at
                .is_none_or(|at| at.elapsed() >= SAMPLED_THROUGH_REFRESH);
        if last.membership == membership && !advanced {
            return Ok(());
        }
        let sampled_through = sampled_through.max(last.sampled_through);
        let written = serde_json::to_string(&state.journal_record(self.writer, sampled_through))
            .map_err(io::Error::other)
            .and_then(|contents| write_private_atomically(&self.path, contents.as_bytes()));
        if let Err(error) = written {
            let _ = fs::remove_file(&self.marker);
            return Err(error);
        }
        *last = JournalWrite {
            membership,
            sampled_through,
            at: Some(Instant::now()),
        };
        Ok(())
    }

    /// The lineage was proven gone; nothing is left for a reaper to stop.
    pub(super) fn retire(&self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn write_private_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(contents)?;
    // No fsync: the journal must survive runnerd, not the host. A host
    // restart ends every process the journal could name.
    drop(file);
    fs::rename(&temporary, path)
}

/// Journals every lineage this runnerd records under `state_dir`, so the
/// processes can still be found and stopped after runnerd itself is gone.
/// Call once, before any supervised process starts. The writer marker tells
/// a reaper that this runnerd journals; without it, absence of journals
/// proves nothing.
pub fn enable_journal(state_dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let directory = std::path::absolute(state_dir)?.join(JOURNAL_DIRECTORY_NAME);
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let writer = ProcessIdentity::current()
        .ok_or_else(|| io::Error::other("runnerd could not read its own process identity"))?;
    let marker = serde_json::to_vec(&WriterMarker {
        schema: WRITER_SCHEMA.to_owned(),
        writer,
    })
    .map_err(io::Error::other)?;
    write_private_atomically(
        &directory.join(format!("writer-{}.json", writer.pid)),
        &marker,
    )?;
    JOURNAL_DIRECTORY
        .set((directory, writer))
        .map_err(|_| io::Error::other("the process lineage journal is already enabled"))
}

/// What one reap of a dead runnerd's journals proved.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReapReport {
    pub schema: &'static str,
    /// Every journalled process of the dead runnerd is proven gone.
    pub verified: bool,
    /// Why `verified` is false, or `None`.
    pub reason: Option<&'static str>,
    pub journals: usize,
    pub signalled: usize,
    /// PIDs still alive (or unreadable) at the deadline.
    pub remaining: Vec<i32>,
}

impl ReapReport {
    fn refused(reason: &'static str) -> Self {
        Self {
            schema: REAP_REPORT_SCHEMA,
            verified: false,
            reason: Some(reason),
            journals: 0,
            signalled: 0,
            remaining: Vec::new(),
        }
    }
}

/// Stops and proves gone every process journalled by the runnerd that ran
/// with `state_dir` as PID `runner_pid`, after that runnerd has exited.
///
/// Refuses (never signals) unless that runnerd journalled (its writer marker
/// exists) and is itself gone. Journals of other dead writers in the same
/// directory are reaped too; a live writer's journals are never touched. Each
/// process is signalled only while its PID and start time still match a
/// recorded identity: TERM first, KILL after `grace`.
///
/// A live orphan of this user that started after the dead runnerd's last
/// sample cannot be attributed and is never signalled. A process whose parent
/// is not alive in the same table read counts as an orphan too, because a
/// table read is not atomic and its parent may have exited during the read.
/// The reap waits for such orphans to exit and refuses with
/// `unattributed_orphan` only if one still lives at `deadline`.
pub fn reap_journals(
    state_dir: &Path,
    runner_pid: i32,
    grace: Duration,
    deadline: Duration,
) -> ReapReport {
    reap_journals_from(
        state_dir,
        runner_pid,
        grace,
        deadline,
        read_process_table,
        owned_by_this_user,
    )
}

fn reap_journals_from<T: ProcessTable>(
    state_dir: &Path,
    runner_pid: i32,
    grace: Duration,
    deadline: Duration,
    mut read_table: impl FnMut() -> Option<T>,
    owned: impl Fn(i32) -> bool,
) -> ReapReport {
    let directory = state_dir.join(JOURNAL_DIRECTORY_NAME);
    let marker_path = directory.join(format!("writer-{runner_pid}.json"));
    let Some(marker) = fs::read(&marker_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<WriterMarker>(&bytes).ok())
        .filter(|marker| marker.schema == WRITER_SCHEMA && marker.writer.pid == runner_pid)
    else {
        return ReapReport::refused("journal_unavailable");
    };
    if marker.writer.is_alive() {
        return ReapReport::refused("runner_alive");
    }
    let Ok(listing) = fs::read_dir(&directory) else {
        return ReapReport::refused("journal_unreadable");
    };
    let mut journals: Vec<(PathBuf, LineageState)> = Vec::new();
    // The oldest point after which the dead runnerd's sampler saw nothing.
    let mut unsampled_since: Option<u64> = None;
    for entry in listing {
        let Ok(entry) = entry else {
            return ReapReport::refused("journal_unreadable");
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !(name.starts_with("lineage-") && name.ends_with(".json")) {
            continue;
        }
        let path = entry.path();
        let Some(record) = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<JournalRecord>(&bytes).ok())
            .filter(|record| record.schema == JOURNAL_SCHEMA)
        else {
            // A journal that cannot be read may name live processes.
            return ReapReport::refused("journal_unreadable");
        };
        if record.writer != marker.writer && record.writer.is_alive() {
            continue;
        }
        if record.writer == marker.writer {
            unsampled_since = Some(
                unsampled_since.map_or(record.sampled_through, |since: u64| {
                    since.min(record.sampled_through)
                }),
            );
        }
        journals.push((path, LineageState::from_journal_record(&record)));
    }
    let count = journals.len();
    let started = Instant::now();
    let mut signalled: HashSet<(i32, u64)> = HashSet::new();
    let mut unattributed_tree = LineageState::default();
    let mut consecutive_clean_reads = 0;
    loop {
        let elapsed = started.elapsed();
        let Some(table) = read_table() else {
            consecutive_clean_reads = 0;
            if elapsed >= deadline {
                return ReapReport {
                    journals: count,
                    signalled: signalled.len(),
                    ..ReapReport::refused("process_table_unreadable")
                };
            }
            thread::sleep(Duration::from_millis(10));
            continue;
        };
        let mut live: Vec<ProcessEntry> = Vec::new();
        let mut unresolved: Vec<i32> = Vec::new();
        for (_, state) in journals.iter_mut() {
            let observation = state.observe(&table);
            live.extend(observation.live);
            unresolved.extend(observation.unresolved);
        }
        if live.is_empty() && unresolved.is_empty() {
            // A tool that started after the last read, and whose parents have
            // exited, matches no recorded parent, group or session: it is an
            // orphan the record cannot account for. Its children stay under
            // it, so the orphan names the whole unrecorded tree. Ownership
            // cannot be proven either way, so it is never signalled, and the
            // proof is refused.
            if let Some(since) = unsampled_since {
                let escaped = unattributed_orphans(&table, since, &journals, &owned);
                let roots: Vec<ProcessEntry> = table
                    .entries()
                    .iter()
                    .filter(|entry| escaped.contains(&entry.pid))
                    .copied()
                    .collect();
                unattributed_tree.track_roots(&roots);
                let observation = unattributed_tree.observe(&table);
                let mut remaining: Vec<i32> = observation
                    .live
                    .iter()
                    .map(|entry| entry.pid)
                    .chain(observation.unresolved)
                    .collect();
                remaining.sort_unstable();
                remaining.dedup();
                if !remaining.is_empty() {
                    consecutive_clean_reads = 0;
                    if elapsed >= deadline {
                        return ReapReport {
                            journals: count,
                            signalled: signalled.len(),
                            remaining,
                            ..ReapReport::refused("unattributed_orphan")
                        };
                    }
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                consecutive_clean_reads += 1;
                if consecutive_clean_reads < CLEAN_READS_REQUIRED_FOR_A_PROOF {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
            }
            for (path, _) in &journals {
                let _ = fs::remove_file(path);
            }
            let _ = fs::remove_file(&marker_path);
            return ReapReport {
                schema: REAP_REPORT_SCHEMA,
                verified: true,
                reason: None,
                journals: count,
                signalled: signalled.len(),
                remaining: Vec::new(),
            };
        }
        consecutive_clean_reads = 0;
        if elapsed >= deadline {
            let mut remaining: Vec<i32> = live
                .iter()
                .map(|entry| entry.pid)
                .chain(unresolved)
                .collect();
            remaining.sort_unstable();
            remaining.dedup();
            return ReapReport {
                journals: count,
                signalled: signalled.len(),
                remaining,
                ..ReapReport::refused("processes_remain")
            };
        }
        for entry in &live {
            let first_signal = signalled.insert((entry.pid, entry.started));
            if elapsed >= grace {
                signal_member(entry, rustix::process::Signal::KILL);
            } else if first_signal {
                signal_member(entry, rustix::process::Signal::TERM);
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
}

const CLEAN_READS_REQUIRED_FOR_A_PROOF: usize = 2;

/// Live orphans (parent PID 1, or a parent not alive in this read) of this
/// user that started no earlier than `since` and belong to no journal. An
/// orphan of a subreaper other than init is not seen here; such a host keeps
/// the in-process teardown only.
fn unattributed_orphans(
    table: &dyn ProcessTable,
    since: u64,
    journals: &[(PathBuf, LineageState)],
    owned: &dyn Fn(i32) -> bool,
) -> Vec<i32> {
    let alive: HashMap<i32, u64> = table
        .entries()
        .iter()
        .filter(|entry| !entry.zombie)
        .map(|entry| (entry.pid, entry.started))
        .collect();
    let unreadable: HashSet<i32> = table.unreadable().iter().copied().collect();
    let parent_alive = |entry: &ProcessEntry| {
        unreadable.contains(&entry.ppid)
            || alive
                .get(&entry.ppid)
                .is_some_and(|started| *started <= entry.started)
    };
    let mut pids: Vec<i32> = table
        .entries()
        .iter()
        .filter(|entry| {
            !entry.zombie
                && (entry.ppid == 1 || !parent_alive(entry))
                && entry.started >= since
                && !journals
                    .iter()
                    .any(|(_, state)| state.members.get(&entry.pid) == Some(&entry.started))
                && owned(entry.pid)
        })
        .map(|entry| entry.pid)
        .collect();
    pids.sort_unstable();
    pids
}

#[cfg(target_os = "linux")]
fn owned_by_this_user(pid: i32) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(format!("/proc/{pid}"))
        .is_ok_and(|metadata| metadata.uid() == rustix::process::geteuid().as_raw())
}

/// macOS lists only processes whose details this user can read.
#[cfg(not(target_os = "linux"))]
fn owned_by_this_user(_pid: i32) -> bool {
    true
}

#[cfg(test)]
mod tests;
