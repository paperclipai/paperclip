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

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// How often the background sampler reads the process table. A tool wrapper
/// must live at least this long for the tracker to record its session. Claude
/// Code's Bash wrapper sources a shell snapshot first and lives far longer.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(50);

pub(crate) use paperclip_process_table::ProcessEntry;

/// One read of the process table. Session IDs are read only on demand.
pub(crate) trait ProcessTable {
    fn entries(&self) -> &[ProcessEntry];
    fn session_of(&self, pid: i32) -> Option<i32>;
}

struct LiveProcessTable {
    entries: Vec<ProcessEntry>,
}

impl ProcessTable for LiveProcessTable {
    fn entries(&self) -> &[ProcessEntry] {
        &self.entries
    }

    fn session_of(&self, pid: i32) -> Option<i32> {
        let pid = rustix::process::Pid::from_raw(pid)?;
        rustix::process::getsid(Some(pid))
            .ok()
            .map(|sid| sid.as_raw_nonzero().get())
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

    /// Updates membership from one table read and returns the live members.
    pub(crate) fn observe(&mut self, table: &dyn ProcessTable) -> Vec<ProcessEntry> {
        let entries = table.entries();
        let by_pid: HashMap<i32, &ProcessEntry> = entries.iter().map(|e| (e.pid, e)).collect();

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
        // leader's PID means the recorded one is gone.
        self.members.retain(|pid, started| {
            by_pid
                .get(pid)
                .is_some_and(|e| e.started == *started && !e.zombie)
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

        entries
            .iter()
            .filter(|e| !e.zombie && self.members.get(&e.pid) == Some(&e.started))
            .copied()
            .collect()
    }
}

pub(crate) fn read_process_table() -> Option<Box<dyn ProcessTable>> {
    paperclip_process_table::list()
        .map(|entries| Box::new(LiveProcessTable { entries }) as Box<dyn ProcessTable>)
}

/// Records a supervised process's lineage from spawn until it is reaped.
pub(crate) struct LineageTracker {
    state: Arc<Mutex<LineageState>>,
    stop: Arc<AtomicBool>,
    sampler: Option<JoinHandle<()>>,
}

impl LineageTracker {
    pub(crate) fn start(root_pid: u32) -> Option<Self> {
        let root_pid = i32::try_from(root_pid).ok()?;
        let state = Arc::new(Mutex::new(LineageState::new(root_pid)));
        let stop = Arc::new(AtomicBool::new(false));
        let sampler_state = Arc::clone(&state);
        let sampler_stop = Arc::clone(&stop);
        let sampler = thread::Builder::new()
            .name("process-lineage".to_owned())
            .spawn(move || {
                while !sampler_stop.load(Ordering::Acquire) {
                    if let Some(table) = read_process_table() {
                        sampler_state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .observe(table.as_ref());
                    }
                    thread::park_timeout(SAMPLE_INTERVAL);
                }
            })
            .ok()?;
        Some(Self {
            state,
            stop,
            sampler: Some(sampler),
        })
    }

    /// Reads the table once now, so lineage visible at this moment is kept.
    pub(crate) fn sample(&self) {
        if let Some(table) = read_process_table() {
            self.state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .observe(table.as_ref());
        }
    }

    /// Stops every live process in the lineage and proves it is gone.
    ///
    /// Each pass re-reads the table and signals only processes whose PID and
    /// start time still match a recorded member. The first passes send TERM;
    /// after `grace`, they send KILL. Fails with the members still alive at
    /// the deadline, or when the table could not be read to prove that none
    /// remain.
    pub(crate) fn terminate(&self, grace: Duration, deadline: Duration) -> Result<(), String> {
        let started = Instant::now();
        let mut terminated: HashSet<(i32, u64)> = HashSet::new();
        loop {
            let elapsed = started.elapsed();
            let Some(table) = read_process_table() else {
                if elapsed >= deadline {
                    return Err("the process table could not be read".to_owned());
                }
                thread::sleep(Duration::from_millis(10));
                continue;
            };
            let live = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .observe(table.as_ref());
            if live.is_empty() {
                return Ok(());
            }
            if elapsed >= deadline {
                let pids = live
                    .iter()
                    .map(|entry| entry.pid.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                return Err(format!("still alive: {pids}"));
            }
            for entry in &live {
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
    let Some(current) = paperclip_process_table::read(entry.pid) else {
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
        sessions: HashMap<i32, i32>,
    }

    impl ProcessTable for FixedTable {
        fn entries(&self) -> &[ProcessEntry] {
            &self.entries
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
            sessions: entries.iter().map(|(e, sid)| (e.pid, *sid)).collect(),
            entries: entries.into_iter().map(|(e, _)| e).collect(),
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
        assert_eq!(pids(&state.observe(&before)), vec![100, 200, 201]);

        let after = table(vec![
            (entry(1, 0, 1, 1), 1),
            (entry(10, 1, 10, 5), 1),
            (entry(100, 10, 100, 10), 1),
            (entry(201, 1, 200, 21), 200),
            (entry(202, 201, 200, 30), 200),
        ]);
        assert_eq!(pids(&state.observe(&after)), vec![100, 201, 202]);
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
        assert_eq!(pids(&state.observe(&after)), vec![100, 300]);
    }

    #[test]
    fn never_claims_processes_through_the_supervisors_own_session_or_group() {
        let mut state = LineageState::new(100);
        // 50 shares the supervisor's session and group but is not a descendant.
        let observed = state.observe(&table(vec![
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
        assert_eq!(pids(&state.observe(&reused)), vec![100]);
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
        assert_eq!(pids(&state.observe(&after)), vec![100, 201]);
    }
}
