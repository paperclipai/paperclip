//! Tracks every process a supervised process starts, including processes that
//! leave its process group.
//!
//! A supervised process runs in its own process group, and signalling that
//! group stops it and the children that stay in the group. Provider tools do
//! not stay there. Claude Code, for example, starts each Bash tool command in a
//! new session (`setsid`). A tool command such as `nohup ./job.sh &` then
//! leaves a job in that session whose wrapper has already exited, so the job's
//! parent is init. Neither signalling the owned group nor walking the parent
//! chain at teardown finds it.
//!
//! The tracker records identity while the lineage is still visible. It samples
//! the process table and records each descendant by PID and start time. When a
//! descendant leads a new process group or session, it records that group or
//! session with the leader's start time. Later, a process belongs to the
//! lineage when its parent belongs, or when it is in a recorded group or
//! session and started no earlier than that group's leader. Membership never
//! depends on a command name or path. A process that inherits the supervised
//! process's own session or an ancestor's group is never claimed through that
//! session or group, because only groups and sessions that a recorded
//! descendant leads are recorded.
//!
//! The record also has to survive the runner. When runnerd itself dies (for
//! example SIGKILL in the middle of a tool call), the provider and its tools
//! are re-parented and the in-memory record goes with runnerd. Durable runnerd
//! therefore journals every record to `<state-dir>/process-lineage/` from the
//! moment the provider is spawned. After runnerd's exit is confirmed, a later
//! `paperclip-runnerd reap-lineage` reads those journals, stops every process
//! that still matches a recorded identity, and proves the lineage gone. The
//! same PID-and-start-time rules apply, so a reused PID is never signalled.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// How often the background sampler reads the process table. A tool wrapper
/// must live at least this long for the tracker to record its session. Claude
/// Code's Bash wrapper sources a shell snapshot first and lives far longer.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(50);

pub(crate) use paperclip_process_table::ProcessEntry;

/// One read of the process table. Session IDs are read only on demand.
pub(crate) trait ProcessTable {
    fn entries(&self) -> &[ProcessEntry];
    /// Processes that exist but whose details could not be read. On macOS
    /// these are other users' processes; a provider's tools run as the
    /// runner's user, so only a recorded member here is a concern.
    fn unreadable(&self) -> &[i32] {
        &[]
    }
    fn session_of(&self, pid: i32) -> Option<i32>;
}

struct LiveProcessTable {
    snapshot: paperclip_process_table::Snapshot,
}

impl ProcessTable for LiveProcessTable {
    fn entries(&self) -> &[ProcessEntry] {
        &self.snapshot.entries
    }

    fn unreadable(&self) -> &[i32] {
        &self.snapshot.unreadable
    }

    fn session_of(&self, pid: i32) -> Option<i32> {
        // Not rustix's getsid: it asserts a nonzero session, and a kernel
        // thread or a process whose session leader is outside this PID
        // namespace reports 0. That assertion killed the sampler thread.
        paperclip_process_table::session(pid)
    }
}

/// The lineage as one table read saw it.
#[derive(Debug, Default)]
pub(crate) struct Observation {
    /// Live members, with the identity that read reported.
    pub live: Vec<ProcessEntry>,
    /// Members that still exist but could not be read. Their exit is not
    /// proven, so teardown cannot succeed while any remain.
    pub unresolved: Vec<i32>,
}

impl Observation {
    pub(crate) fn is_empty(&self) -> bool {
        self.live.is_empty() && self.unresolved.is_empty()
    }
}

#[derive(Default)]
pub(crate) struct LineageState {
    root: Option<(i32, u64)>,
    /// Live processes known to belong to the lineage, by PID and start time.
    members: HashMap<i32, u64>,
    /// Groups led by a recorded member, keyed by ID, with the leader's start.
    groups: HashMap<i32, u64>,
    /// Sessions led by a recorded member, keyed by ID, with the leader's start.
    sessions: HashMap<i32, u64>,
}

impl LineageState {
    pub(crate) fn new(root_pid: i32) -> Self {
        Self {
            root: Some((root_pid, 0)),
            ..Self::default()
        }
    }

    /// Starts from a root whose identity is already known, so the record is
    /// complete before the background sampler's first read.
    fn with_known_root(root: ProcessEntry) -> Self {
        let mut state = Self {
            root: Some((root.pid, root.started)),
            ..Self::default()
        };
        state.members.insert(root.pid, root.started);
        if root.pgid == root.pid {
            state.groups.insert(root.pid, root.started);
        }
        state
    }

    fn journal_record(&self, writer: ProcessIdentity) -> JournalRecord {
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

    /// Updates membership from one table read and returns the live members.
    /// Callers must apply reads in the order they were taken; an older read
    /// would forget members that a newer one recorded.
    pub(crate) fn observe(&mut self, table: &dyn ProcessTable) -> Observation {
        let entries = table.entries();
        let by_pid: HashMap<i32, &ProcessEntry> = entries.iter().map(|e| (e.pid, e)).collect();
        let unreadable: HashSet<i32> = table.unreadable().iter().copied().collect();

        // Resolve the root's start time on first sight. A root that is gone
        // contributes nothing further; its recorded lineage still does.
        if let Some((root_pid, root_started)) = self.root {
            match by_pid.get(&root_pid) {
                Some(entry) if root_started == 0 => {
                    self.root = Some((root_pid, entry.started));
                    self.members.insert(root_pid, entry.started);
                }
                Some(entry) if entry.started == root_started && !entry.zombie => {
                    self.members.insert(root_pid, root_started);
                }
                _ => {}
            }
        }

        // Forget members that exited, and groups or sessions whose leader PID
        // now names a different process. A group or session ID cannot be
        // reused while any process is still in it, so a new process with the
        // leader's PID means the recorded one is gone. A member that could
        // not be read is kept: its exit is not established.
        self.members.retain(|pid, started| match by_pid.get(pid) {
            Some(e) => e.started == *started && !e.zombie,
            None => unreadable.contains(pid),
        });
        self.groups
            .retain(|id, started| by_pid.get(id).is_none_or(|e| e.started == *started));
        self.sessions
            .retain(|id, started| by_pid.get(id).is_none_or(|e| e.started == *started));

        // Children are listed under their parents, and a recorded group or
        // session can admit more members, so iterate until nothing changes.
        let mut sessions_cache: HashMap<i32, Option<i32>> = HashMap::new();
        let mut session_of = |pid: i32| -> Option<i32> {
            *sessions_cache
                .entry(pid)
                .or_insert_with(|| table.session_of(pid))
        };
        loop {
            let mut changed = false;
            for entry in entries {
                if entry.zombie || self.members.contains_key(&entry.pid) {
                    continue;
                }
                let parent_is_member = self
                    .members
                    .get(&entry.ppid)
                    .is_some_and(|parent_started| *parent_started <= entry.started);
                let in_group = self
                    .groups
                    .get(&entry.pgid)
                    .is_some_and(|leader_started| *leader_started <= entry.started);
                let in_session = !parent_is_member
                    && !in_group
                    && !self.sessions.is_empty()
                    && session_of(entry.pid).is_some_and(|sid| {
                        self.sessions
                            .get(&sid)
                            .is_some_and(|leader_started| *leader_started <= entry.started)
                    });
                if parent_is_member || in_group || in_session {
                    self.members.insert(entry.pid, entry.started);
                    changed = true;
                }
            }
            // Record groups and sessions that a member leads. A member that
            // was seen before its setsid/setpgid is re-checked on every read.
            for entry in entries {
                let Some(started) = self.members.get(&entry.pid).copied() else {
                    continue;
                };
                if entry.pgid == entry.pid && !self.groups.contains_key(&entry.pid) {
                    self.groups.insert(entry.pid, started);
                    changed = true;
                }
                if !self.sessions.contains_key(&entry.pid)
                    && session_of(entry.pid) == Some(entry.pid)
                {
                    self.sessions.insert(entry.pid, started);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        let mut unresolved: Vec<i32> = self
            .members
            .keys()
            .copied()
            .filter(|pid| !by_pid.contains_key(pid))
            .collect();
        unresolved.sort_unstable();
        Observation {
            live: entries
                .iter()
                .filter(|e| !e.zombie && self.members.get(&e.pid) == Some(&e.started))
                .copied()
                .collect(),
            unresolved,
        }
    }
}

fn read_process_table() -> Option<LiveProcessTable> {
    paperclip_process_table::list().map(|snapshot| LiveProcessTable { snapshot })
}

/// Reads the table while holding the state, so reads are applied in the
/// order they were taken. `None` when the table could not be read. A changed
/// record is journalled under the same lock, so journal writes keep that order.
fn observe_now(state: &Mutex<LineageState>, journal: Option<&Journal>) -> Option<Observation> {
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let table = read_process_table()?;
    let observation = state.observe(&table);
    if let Some(journal) = journal {
        // A failed write keeps the previous record and is retried on the
        // next read: the content differs from what was last written.
        let _ = journal.write(&state);
    }
    Some(observation)
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
}

#[derive(Debug, Serialize, Deserialize)]
struct WriterMarker {
    schema: String,
    writer: ProcessIdentity,
}

/// One supervised process's journal file.
struct Journal {
    path: PathBuf,
    writer: ProcessIdentity,
    last: Mutex<String>,
}

impl Journal {
    fn create(state: &LineageState) -> io::Result<Option<Self>> {
        let Some((directory, writer)) = JOURNAL_DIRECTORY.get() else {
            return Ok(None);
        };
        let sequence = JOURNAL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let journal = Self {
            path: directory.join(format!("lineage-{}-{sequence}.json", writer.pid)),
            writer: *writer,
            last: Mutex::new(String::new()),
        };
        journal.write(state)?;
        Ok(Some(journal))
    }

    fn write(&self, state: &LineageState) -> io::Result<()> {
        let contents =
            serde_json::to_string(&state.journal_record(self.writer)).map_err(io::Error::other)?;
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *last == contents {
            return Ok(());
        }
        write_private_atomically(&self.path, contents.as_bytes())?;
        *last = contents;
        Ok(())
    }

    /// The lineage was proven gone; nothing is left for a reaper to stop.
    fn retire(&self) {
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
pub fn reap_journals(
    state_dir: &Path,
    runner_pid: i32,
    grace: Duration,
    deadline: Duration,
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
        journals.push((path, LineageState::from_journal_record(&record)));
    }
    let count = journals.len();
    let started = Instant::now();
    let mut signalled: HashSet<(i32, u64)> = HashSet::new();
    loop {
        let elapsed = started.elapsed();
        let Some(table) = read_process_table() else {
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

/// Records a supervised process's lineage from spawn until it is reaped.
pub(crate) struct LineageTracker {
    state: Arc<Mutex<LineageState>>,
    journal: Option<Arc<Journal>>,
    stop: Arc<AtomicBool>,
    sampler: Option<JoinHandle<()>>,
}

impl LineageTracker {
    /// Starts recording. Fails when the sampler cannot run, or when a
    /// journalling runnerd cannot journal the root, so a caller never
    /// supervises a process whose tools it could not stop.
    pub(crate) fn start(root_pid: u32) -> Result<Self, String> {
        let root_pid = i32::try_from(root_pid)
            .map_err(|_| format!("process ID {root_pid} is out of range"))?;
        // One read of the new process names the root by start time before
        // any tool can run. It reads one process, not the whole table.
        let initial = match paperclip_process_table::read(root_pid).entry() {
            Some(root) if !root.zombie => LineageState::with_known_root(root),
            _ => LineageState::new(root_pid),
        };
        let journal = Journal::create(&initial)
            .map_err(|error| format!("the process lineage journal could not be written: {error}"))?
            .map(Arc::new);
        let state = Arc::new(Mutex::new(initial));
        let stop = Arc::new(AtomicBool::new(false));
        let sampler_state = Arc::clone(&state);
        let sampler_journal = journal.clone();
        let sampler_stop = Arc::clone(&stop);
        let sampler = thread::Builder::new()
            .name("process-lineage".to_owned())
            .spawn(move || {
                while !sampler_stop.load(Ordering::Acquire) {
                    let _ = observe_now(&sampler_state, sampler_journal.as_deref());
                    thread::park_timeout(SAMPLE_INTERVAL);
                }
            })
            .map_err(|error| {
                if let Some(journal) = journal.as_ref() {
                    journal.retire();
                }
                format!("the process lineage sampler could not start: {error}")
            })?;
        Ok(Self {
            state,
            journal,
            stop,
            sampler: Some(sampler),
        })
    }

    /// Reads the table once now, so lineage visible at this moment is kept.
    pub(crate) fn sample(&self) {
        let _ = observe_now(&self.state, self.journal.as_deref());
    }

    /// Stops every live process in the lineage and proves it is gone.
    ///
    /// Each pass re-reads the table and signals only processes whose PID and
    /// start time still match a recorded member. The first passes send TERM;
    /// after `grace`, they send KILL. Fails with the members still alive at
    /// the deadline, or when the table could not be read to prove that none
    /// remain.
    pub(crate) fn terminate(&mut self, grace: Duration, deadline: Duration) -> Result<(), String> {
        let started = Instant::now();
        let mut terminated: HashSet<(i32, u64)> = HashSet::new();
        loop {
            let elapsed = started.elapsed();
            let Some(observation) = observe_now(&self.state, self.journal.as_deref()) else {
                if elapsed >= deadline {
                    return Err("the process table could not be read".to_owned());
                }
                thread::sleep(Duration::from_millis(10));
                continue;
            };
            if observation.is_empty() {
                // Stop journalling before retiring, so the sampler cannot
                // write the file again after it is removed.
                self.stop_sampler();
                if let Some(journal) = self.journal.as_ref() {
                    journal.retire();
                }
                return Ok(());
            }
            if elapsed >= deadline {
                let alive = observation
                    .live
                    .iter()
                    .map(|entry| entry.pid.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                let unresolved = observation
                    .unresolved
                    .iter()
                    .map(i32::to_string)
                    .collect::<Vec<_>>()
                    .join(",");
                return Err(format!(
                    "still alive: [{alive}]; unreadable: [{unresolved}]"
                ));
            }
            for entry in &observation.live {
                let first_signal = terminated.insert((entry.pid, entry.started));
                if elapsed >= grace {
                    signal_member(entry, rustix::process::Signal::KILL);
                } else if first_signal {
                    signal_member(entry, rustix::process::Signal::TERM);
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn stop_sampler(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(sampler) = self.sampler.take() {
            sampler.thread().unpark();
            let _ = sampler.join();
        }
    }
}

impl Drop for LineageTracker {
    fn drop(&mut self) {
        self.stop_sampler();
    }
}

/// Signals one member after re-checking that its PID still names the same
/// process. The re-check and the signal are not atomic, but a PID is not
/// reused within the few microseconds between them in practice.
fn signal_member(entry: &ProcessEntry, signal: rustix::process::Signal) {
    let Some(current) = paperclip_process_table::read(entry.pid).entry() else {
        return;
    };
    if current.started != entry.started || current.zombie {
        return;
    }
    if let Some(pid) = rustix::process::Pid::from_raw(entry.pid) {
        let _ = rustix::process::kill_process(pid, signal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedTable {
        entries: Vec<ProcessEntry>,
        unreadable: Vec<i32>,
        sessions: HashMap<i32, i32>,
    }

    impl ProcessTable for FixedTable {
        fn entries(&self) -> &[ProcessEntry] {
            &self.entries
        }
        fn unreadable(&self) -> &[i32] {
            &self.unreadable
        }
        fn session_of(&self, pid: i32) -> Option<i32> {
            self.sessions.get(&pid).copied()
        }
    }

    fn entry(pid: i32, ppid: i32, pgid: i32, started: u64) -> ProcessEntry {
        ProcessEntry {
            pid,
            ppid,
            pgid,
            started,
            zombie: false,
        }
    }

    fn table(entries: Vec<(ProcessEntry, i32)>) -> FixedTable {
        FixedTable {
            unreadable: Vec::new(),
            sessions: entries.iter().map(|(e, sid)| (e.pid, *sid)).collect(),
            entries: entries.into_iter().map(|(e, _)| e).collect(),
        }
    }

    impl LineageState {
        fn observe_live(&mut self, table: &FixedTable) -> Vec<ProcessEntry> {
            self.observe(table).live
        }
    }

    fn pids(entries: &[ProcessEntry]) -> Vec<i32> {
        let mut pids: Vec<i32> = entries.iter().map(|e| e.pid).collect();
        pids.sort_unstable();
        pids
    }

    #[test]
    fn keeps_a_reparented_job_from_a_recorded_tool_session() {
        // runnerd 10 (session 1) supervises sidecar 100 (group 100). The
        // sidecar starts a tool wrapper 200 in a new session, which starts
        // job 201 and exits. The job is then a child of init.
        let mut state = LineageState::new(100);
        let before = table(vec![
            (entry(1, 0, 1, 1), 1),
            (entry(10, 1, 10, 5), 1),
            (entry(100, 10, 100, 10), 1),
            (entry(200, 100, 200, 20), 200),
            (entry(201, 200, 200, 21), 200),
        ]);
        assert_eq!(pids(&state.observe_live(&before)), vec![100, 200, 201]);

        let after = table(vec![
            (entry(1, 0, 1, 1), 1),
            (entry(10, 1, 10, 5), 1),
            (entry(100, 10, 100, 10), 1),
            (entry(201, 1, 200, 21), 200),
            (entry(202, 201, 200, 30), 200),
        ]);
        assert_eq!(pids(&state.observe_live(&after)), vec![100, 201, 202]);
    }

    #[test]
    fn finds_a_job_that_left_the_group_through_its_recorded_session() {
        let mut state = LineageState::new(100);
        state.observe(&table(vec![
            (entry(100, 10, 100, 10), 1),
            (entry(200, 100, 200, 20), 200),
        ]));
        // The wrapper has exited and its job made its own group, but the job
        // is still in the wrapper's session.
        let after = table(vec![
            (entry(100, 10, 100, 10), 1),
            (entry(300, 1, 300, 25), 200),
        ]);
        assert_eq!(pids(&state.observe_live(&after)), vec![100, 300]);
    }

    #[test]
    fn never_claims_processes_through_the_supervisors_own_session_or_group() {
        let mut state = LineageState::new(100);
        // 50 shares the supervisor's session and group but is not a descendant.
        let observed = state.observe_live(&table(vec![
            (entry(10, 1, 10, 5), 1),
            (entry(50, 1, 10, 6), 1),
            (entry(100, 10, 100, 10), 1),
            (entry(60, 1, 100, 11), 1),
        ]));
        // 60 joined the sidecar's own group, which the sidecar leads.
        assert_eq!(pids(&observed), vec![60, 100]);
    }

    #[test]
    fn rejects_a_reused_group_or_session_id_and_older_processes() {
        let mut state = LineageState::new(100);
        state.observe(&table(vec![
            (entry(100, 10, 100, 10), 1),
            (entry(200, 100, 200, 20), 200),
        ]));
        // PID 200 now names a different process: the recorded group and
        // session are gone, so its group members are not ours. Process 210
        // reports group 200 but started before the recorded leader.
        let reused = table(vec![
            (entry(100, 10, 100, 10), 1),
            (entry(200, 1, 200, 90), 200),
            (entry(201, 200, 200, 91), 200),
            (entry(210, 1, 200, 15), 200),
        ]);
        assert_eq!(pids(&state.observe_live(&reused)), vec![100]);
    }

    #[test]
    fn records_a_session_created_after_the_member_was_first_seen() {
        let mut state = LineageState::new(100);
        // First read: the fork has not called setsid yet.
        state.observe(&table(vec![
            (entry(100, 10, 100, 10), 1),
            (entry(200, 100, 100, 20), 1),
        ]));
        state.observe(&table(vec![
            (entry(100, 10, 100, 10), 1),
            (entry(200, 100, 200, 20), 200),
        ]));
        let after = table(vec![
            (entry(100, 10, 100, 10), 1),
            (entry(201, 1, 200, 21), 200),
        ]);
        assert_eq!(pids(&state.observe_live(&after)), vec![100, 201]);
    }

    #[test]
    fn keeps_an_unreadable_member_unresolved_until_it_is_gone() {
        let mut state = LineageState::new(100);
        state.observe(&table(vec![
            (entry(100, 10, 100, 10), 1),
            (entry(200, 100, 200, 20), 200),
        ]));
        let mut unreadable = table(vec![(entry(100, 10, 100, 10), 1)]);
        unreadable.unreadable = vec![200];
        let observation = state.observe(&unreadable);
        assert_eq!(pids(&observation.live), vec![100]);
        assert_eq!(observation.unresolved, vec![200]);
        assert!(!observation.is_empty());

        let gone = state.observe(&table(vec![(entry(100, 10, 100, 10), 1)]));
        assert!(gone.unresolved.is_empty());
    }

    #[test]
    fn a_journalled_record_restores_the_same_lineage() {
        let mut state = LineageState::new(100);
        state.observe(&table(vec![
            (entry(100, 10, 100, 10), 1),
            (entry(200, 100, 200, 20), 200),
            (entry(201, 200, 200, 21), 200),
        ]));
        let writer = ProcessIdentity {
            pid: 10,
            started: 5,
        };
        let record = state.journal_record(writer);
        let json = serde_json::to_string(&record).unwrap();
        let restored: JournalRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.writer, writer);
        let mut restored = LineageState::from_journal_record(&restored);
        // runnerd (10) is gone and the wrapper exited: provider 100 and job
        // 201 are re-parented to init, and a later job 202 was started.
        let after = table(vec![
            (entry(1, 0, 1, 1), 1),
            (entry(100, 1, 100, 10), 1),
            (entry(201, 1, 200, 21), 200),
            (entry(202, 201, 200, 30), 200),
            (entry(300, 1, 300, 40), 300),
        ]);
        assert_eq!(pids(&restored.observe_live(&after)), vec![100, 201, 202]);
    }

    #[test]
    fn an_unknown_root_start_is_never_journalled_as_an_identity() {
        let state = LineageState::new(100);
        let record = state.journal_record(ProcessIdentity {
            pid: 10,
            started: 5,
        });
        assert_eq!(record.root, None);
    }

    fn temporary_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-lineage-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(directory.join(JOURNAL_DIRECTORY_NAME)).unwrap();
        directory
    }

    fn write_marker(state_dir: &Path, writer: ProcessIdentity) {
        let marker = WriterMarker {
            schema: WRITER_SCHEMA.to_owned(),
            writer,
        };
        fs::write(
            state_dir
                .join(JOURNAL_DIRECTORY_NAME)
                .join(format!("writer-{}.json", writer.pid)),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
    }

    /// A process that existed and has exited, so its identity is dead.
    fn exited_writer() -> ProcessIdentity {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let pid = i32::try_from(child.id()).unwrap();
        let started = paperclip_process_table::read(pid).entry().unwrap().started;
        child.kill().unwrap();
        child.wait().unwrap();
        ProcessIdentity { pid, started }
    }

    #[test]
    fn reaping_refuses_without_a_marker_or_while_the_writer_lives() {
        let directory = temporary_directory("refuse");
        let report = reap_journals(&directory, 4242, Duration::ZERO, Duration::ZERO);
        assert_eq!(report.reason, Some("journal_unavailable"));
        assert!(!report.verified);

        let alive = ProcessIdentity::current().unwrap();
        write_marker(&directory, alive);
        let report = reap_journals(&directory, alive.pid, Duration::ZERO, Duration::ZERO);
        assert_eq!(report.reason, Some("runner_alive"));
        assert!(!report.verified);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn reaping_refuses_an_unreadable_journal() {
        let directory = temporary_directory("unreadable");
        let writer = exited_writer();
        write_marker(&directory, writer);
        fs::write(
            directory
                .join(JOURNAL_DIRECTORY_NAME)
                .join("lineage-1-0.json"),
            b"{",
        )
        .unwrap();
        let report = reap_journals(&directory, writer.pid, Duration::ZERO, Duration::ZERO);
        assert_eq!(report.reason, Some("journal_unreadable"));
        let _ = fs::remove_dir_all(&directory);
    }

    /// runnerd is SIGKILLed mid-tool: its provider and a tool job that left
    /// the provider's session outlive it. The journal alone finds and stops
    /// both, and proves them gone.
    #[test]
    fn reaping_stops_a_dead_runners_provider_and_its_escaped_tool_job() {
        use std::os::unix::process::CommandExt;
        let directory = temporary_directory("reap");
        let pid_file = directory.join("job.pid");
        // The wrapper lives past several samples, as a real tool wrapper does.
        let tool = r#"sleep 0.3; nohup /bin/sh -c 'while :; do sleep 1; done' >/dev/null 2>&1 & echo $! > "$0.tmp"; mv "$0.tmp" "$0"; exit 0"#;
        let wrapper = format!(
            "use POSIX (); POSIX::setsid() or die; exec '/bin/sh', '-c', q{{{tool}}}, $ARGV[0];"
        );
        let mut provider = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                r#"sleep 0.2; perl -e "$1" "$2"; while :; do sleep 1; done"#,
                "provider",
                &wrapper,
                &pid_file.display().to_string(),
            ])
            .process_group(0)
            .spawn()
            .unwrap();
        let provider_pid = i32::try_from(provider.id()).unwrap();
        let root = paperclip_process_table::read(provider_pid).entry().unwrap();
        let mut state = LineageState::with_known_root(root);
        let deadline = Instant::now() + Duration::from_secs(10);
        let job = loop {
            let live = state.observe(&read_process_table().unwrap()).live;
            if let Some(pid) = fs::read_to_string(&pid_file)
                .ok()
                .and_then(|text| text.trim().parse::<i32>().ok())
            {
                if let Some(job) = live.iter().find(|entry| entry.pid == pid) {
                    break *job;
                }
            }
            assert!(Instant::now() < deadline, "tool job was not recorded");
            thread::sleep(SAMPLE_INTERVAL);
        };
        assert_ne!(job.pgid, provider_pid);

        let writer = exited_writer();
        write_marker(&directory, writer);
        let journal = directory
            .join(JOURNAL_DIRECTORY_NAME)
            .join(format!("lineage-{}-0.json", writer.pid));
        fs::write(
            &journal,
            serde_json::to_vec(&state.journal_record(writer)).unwrap(),
        )
        .unwrap();

        let report = reap_journals(
            &directory,
            writer.pid,
            Duration::from_millis(500),
            Duration::from_secs(10),
        );
        let _ = provider.wait();
        let job_alive = paperclip_process_table::read(job.pid)
            .entry()
            .is_some_and(|current| current.started == job.started && !current.zombie);
        if job_alive {
            if let Some(group) = rustix::process::Pid::from_raw(job.pgid) {
                let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
            }
        }
        assert!(!job_alive, "tool job {} outlived the reap", job.pid);
        assert!(report.verified, "{report:?}");
        assert_eq!(report.journals, 1);
        assert!(report.signalled >= 2, "{report:?}");
        assert!(!journal.exists(), "a proven journal is retired");
        assert!(!directory
            .join(JOURNAL_DIRECTORY_NAME)
            .join(format!("writer-{}.json", writer.pid))
            .exists());
        let _ = fs::remove_dir_all(&directory);
    }
}
