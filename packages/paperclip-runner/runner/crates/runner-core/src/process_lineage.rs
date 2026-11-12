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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

mod journal;

use journal::Journal;
pub use journal::{enable_journal, reap_journals, ReapReport, REAP_REPORT_SCHEMA};

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
        // Every process this read listed started no later than its newest
        // start time. A process born after it was not seen by this read.
        let sampled_through = table
            .entries()
            .iter()
            .map(|entry| entry.started)
            .max()
            .unwrap_or(0);
        // A failed write withdraws the writer marker (see Journal::write), so
        // no reaper can claim proof from the stale record on disk.
        let _ = journal.write(&state, sampled_through);
    }
    Some(observation)
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

/// Keeps lib tests that leave orphans apart from a reap that must verify.
///
/// `journal::reap_journals` refuses its proof while any live orphan (parent
/// PID 1) of this user started after the dead runnerd's last sample, whoever
/// started it. Lib tests run in parallel in one process, so an orphan that one
/// test leaves on purpose (a tool job whose wrapper exited, a child that
/// outlives its killed leader) makes a reap in another test refuse.
///
/// A test that can leave such an orphan holds [`may_orphan`] until the orphan
/// is gone or a zombie. A test whose reap must verify holds
/// [`no_foreign_orphans`]. Holders of [`may_orphan`] never wait for each
/// other, so one test can hold several.
#[cfg(test)]
pub(crate) mod host_orphans {
    use std::sync::{Condvar, Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    struct Holders {
        producers: usize,
        exclusive: bool,
    }

    static HOLDERS: Mutex<Holders> = Mutex::new(Holders {
        producers: 0,
        exclusive: false,
    });
    static CHANGED: Condvar = Condvar::new();

    fn holders() -> MutexGuard<'static, Holders> {
        HOLDERS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) struct MayOrphan(());

    /// Waits only while a reap that must verify runs.
    pub(crate) fn may_orphan() -> MayOrphan {
        let mut holders = CHANGED
            .wait_while(holders(), |holders| holders.exclusive)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        holders.producers += 1;
        MayOrphan(())
    }

    impl Drop for MayOrphan {
        fn drop(&mut self) {
            holders().producers -= 1;
            CHANGED.notify_all();
        }
    }

    pub(crate) struct NoForeignOrphans(());

    /// Waits until no test can have an orphan alive, and keeps new ones out
    /// until dropped.
    pub(crate) fn no_foreign_orphans() -> NoForeignOrphans {
        let mut holders = CHANGED
            .wait_while(holders(), |holders| {
                holders.exclusive || holders.producers > 0
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        holders.exclusive = true;
        NoForeignOrphans(())
    }

    impl Drop for NoForeignOrphans {
        fn drop(&mut self) {
            holders().exclusive = false;
            CHANGED.notify_all();
        }
    }

    /// Waits until every process in a killed group is gone or a zombie, so a
    /// guard is not released while one still counts as a live orphan. A
    /// signal takes effect after `kill` returns, not before.
    pub(crate) fn wait_until_group_gone(pgid: i32) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while paperclip_process_table::list().is_none_or(|table| {
            table
                .entries
                .iter()
                .any(|entry| entry.pgid == pgid && !entry.zombie)
        }) {
            assert!(
                Instant::now() < deadline,
                "process group {pgid} did not exit"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_verifying_reap_waits_for_held_orphans_and_holds_new_ones_back() {
        use std::sync::mpsc;
        let first = may_orphan();
        // A test can hold several guards; they never wait for each other.
        let second = may_orphan();

        let (acquired, reap) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let reaper = std::thread::spawn(move || {
            let guard = no_foreign_orphans();
            acquired.send(()).unwrap();
            released.recv().unwrap();
            drop(guard);
        });
        let quiet = Duration::from_millis(200);
        assert!(
            reap.recv_timeout(quiet).is_err(),
            "reap ran beside two orphans"
        );
        drop(first);
        assert!(
            reap.recv_timeout(quiet).is_err(),
            "reap ran beside an orphan"
        );
        drop(second);
        reap.recv_timeout(Duration::from_secs(30))
            .expect("reap waited after every orphan guard was released");

        let (orphaned, orphan) = mpsc::channel();
        let producer = std::thread::spawn(move || {
            let guard = may_orphan();
            orphaned.send(()).unwrap();
            drop(guard);
        });
        assert!(
            orphan.recv_timeout(quiet).is_err(),
            "orphan started during a reap"
        );
        release.send(()).unwrap();
        orphan
            .recv_timeout(Duration::from_secs(30))
            .expect("orphan waited after the reap finished");
        reaper.join().unwrap();
        producer.join().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) struct FixedTable {
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

    pub(super) fn entry(pid: i32, ppid: i32, pgid: i32, started: u64) -> ProcessEntry {
        ProcessEntry {
            pid,
            ppid,
            pgid,
            started,
            zombie: false,
        }
    }

    pub(super) fn table(entries: Vec<(ProcessEntry, i32)>) -> FixedTable {
        FixedTable {
            unreadable: Vec::new(),
            sessions: entries.iter().map(|(e, sid)| (e.pid, *sid)).collect(),
            entries: entries.into_iter().map(|(e, _)| e).collect(),
        }
    }

    impl LineageState {
        pub(super) fn observe_live(&mut self, table: &FixedTable) -> Vec<ProcessEntry> {
            self.observe(table).live
        }
    }

    pub(super) fn pids(entries: &[ProcessEntry]) -> Vec<i32> {
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
}
