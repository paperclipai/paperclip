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

use super::{
    read_process_table, signal_member, LineageState, LiveProcessTable, ProcessEntry, ProcessTable,
};

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
            // A tool that started after the last read, and whose parents have
            // exited, matches no recorded parent, group or session: it is an
            // orphan the record cannot account for. Its children stay under
            // it, so the orphan names the whole unrecorded tree. Ownership
            // cannot be proven either way, so it is never signalled, and the
            // proof is refused.
            if let Some(since) = unsampled_since {
                let escaped = unattributed_orphans(&table, since, &journals);
                if !escaped.is_empty() {
                    return ReapReport {
                        journals: count,
                        signalled: signalled.len(),
                        remaining: escaped,
                        ..ReapReport::refused("unattributed_orphan")
                    };
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

/// Live orphans (parent PID 1) of this user that started no earlier than
/// `since` and belong to no journal. An orphan of a subreaper other than init
/// is not seen here; such a host keeps the in-process teardown only.
fn unattributed_orphans(
    table: &LiveProcessTable,
    since: u64,
    journals: &[(PathBuf, LineageState)],
) -> Vec<i32> {
    let mut pids: Vec<i32> = table
        .entries()
        .iter()
        .filter(|entry| {
            !entry.zombie
                && entry.ppid == 1
                && entry.started >= since
                && !journals
                    .iter()
                    .any(|(_, state)| state.members.get(&entry.pid) == Some(&entry.started))
                && owned_by_this_user(entry.pid)
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
mod tests {
    use super::super::tests::{entry, pids, table};
    use super::super::SAMPLE_INTERVAL;
    use super::*;

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
        let record = state.journal_record(writer, 0);
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
        let record = state.journal_record(
            ProcessIdentity {
                pid: 10,
                started: 5,
            },
            0,
        );
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
        // The proof refuses while any orphan of this user started after the
        // journal was written, including one that another test left.
        let _no_foreign_orphans = super::super::host_orphans::no_foreign_orphans();
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
            serde_json::to_vec(&state.journal_record(writer, newest_start())).unwrap(),
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

    /// The newest start time a table read lists now, as the sampler records.
    fn newest_start() -> u64 {
        read_process_table()
            .unwrap()
            .entries()
            .iter()
            .map(|entry| entry.started)
            .max()
            .unwrap()
    }

    /// A tool forked and left its session after the dead runnerd's last
    /// read, and its parents are gone: nothing recorded leads to it. The reap
    /// must not claim proof, and must not signal a process it cannot
    /// attribute.
    #[test]
    fn reaping_refuses_an_orphan_born_after_the_last_sample() {
        let orphans = super::super::host_orphans::may_orphan();
        let directory = temporary_directory("escape");
        let writer = exited_writer();
        write_marker(&directory, writer);
        let provider = exited_writer();
        let mut state = LineageState::default();
        state.root = Some((provider.pid, provider.started));
        let journal = directory
            .join(JOURNAL_DIRECTORY_NAME)
            .join(format!("lineage-{}-0.json", writer.pid));
        fs::write(
            &journal,
            serde_json::to_vec(&state.journal_record(writer, newest_start())).unwrap(),
        )
        .unwrap();
        // runnerd died right after the tool started, before any read saw it.
        // The tool starts a new session, starts a job and exits, so the job
        // is re-parented to init and leads neither its group nor its session.
        let pid_file = directory.join("orphan.pid");
        let status = std::process::Command::new("perl")
            .args([
                "-e",
                "use POSIX (); exit 0 if fork(); POSIX::setsid() or die; exit 0 if fork(); sleep 1 while getppid() != 1; open(my $f, '>', \"$ARGV[0].tmp\") or die; print $f $$; close $f; rename(\"$ARGV[0].tmp\", $ARGV[0]) or die; open(STDIN, '<', '/dev/null'); open(STDOUT, '>', '/dev/null'); open(STDERR, '>', '/dev/null'); exec '/bin/sh', '-c', 'while :; do sleep 1; done'",
                &pid_file.display().to_string(),
            ])
            .status()
            .unwrap();
        assert!(status.success());
        let deadline = Instant::now() + Duration::from_secs(10);
        let orphan = loop {
            if let Some(entry) = fs::read_to_string(&pid_file)
                .ok()
                .and_then(|text| text.trim().parse::<i32>().ok())
                .and_then(|pid| paperclip_process_table::read(pid).entry())
                .filter(|entry| entry.ppid == 1 && entry.pgid != entry.pid)
            {
                break entry;
            }
            assert!(Instant::now() < deadline, "orphan job did not start");
            thread::sleep(Duration::from_millis(20));
        };
        let report = reap_journals(
            &directory,
            writer.pid,
            Duration::ZERO,
            Duration::from_secs(5),
        );
        let alive = ProcessIdentity {
            pid: orphan.pid,
            started: orphan.started,
        }
        .is_alive();
        if let Some(group) = rustix::process::Pid::from_raw(orphan.pgid) {
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
        }
        super::super::host_orphans::wait_until_group_gone(orphan.pgid);
        drop(orphans);
        let _ = fs::remove_dir_all(&directory);
        assert_eq!(report.reason, Some("unattributed_orphan"), "{report:?}");
        assert!(!report.verified);
        assert!(report.remaining.contains(&orphan.pid), "{report:?}");
        assert!(alive, "an unattributed process is never signalled");
    }

    /// A record that could not be written may be missing a member. The
    /// failure withdraws the writer marker, so no reap can verify.
    #[test]
    fn a_failed_journal_write_withdraws_the_writer_marker() {
        let directory = temporary_directory("write-failure");
        let writer = exited_writer();
        write_marker(&directory, writer);
        let marker = directory
            .join(JOURNAL_DIRECTORY_NAME)
            .join(format!("writer-{}.json", writer.pid));
        let journal = Journal {
            path: directory.join("missing").join("lineage.json"),
            marker: marker.clone(),
            writer,
            last: Mutex::new(JournalWrite::default()),
        };
        assert!(journal.write(&LineageState::new(100), 1).is_err());
        assert!(!marker.exists());
        let report = reap_journals(&directory, writer.pid, Duration::ZERO, Duration::ZERO);
        assert_eq!(report.reason, Some("journal_unavailable"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn an_unchanged_record_is_rewritten_only_to_advance_sampled_through() {
        let directory = temporary_directory("refresh");
        let path = directory.join(JOURNAL_DIRECTORY_NAME).join("lineage.json");
        let journal = Journal {
            path: path.clone(),
            marker: directory.join("marker"),
            writer: ProcessIdentity {
                pid: 10,
                started: 5,
            },
            last: Mutex::new(JournalWrite::default()),
        };
        let state = LineageState::new(100);
        let read = || {
            serde_json::from_slice::<JournalRecord>(&fs::read(&path).unwrap())
                .unwrap()
                .sampled_through
        };
        journal.write(&state, 7).unwrap();
        assert_eq!(read(), 7);
        // Within the refresh interval an advance alone is not written.
        journal.write(&state, 9).unwrap();
        assert_eq!(read(), 7);
        journal.last.lock().unwrap().at = Some(Instant::now() - SAMPLED_THROUGH_REFRESH);
        journal.write(&state, 9).unwrap();
        assert_eq!(read(), 9);
        let _ = fs::remove_dir_all(&directory);
    }
}
