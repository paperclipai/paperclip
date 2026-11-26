use super::super::tests::{entry, pids, table, FixedTable};
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
    let state = LineageState {
        root: Some((provider.pid, provider.started)),
        ..LineageState::default()
    };
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
        Duration::from_secs(1),
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

fn reap_torn_reads(
    name: &str,
    reads: Vec<FixedTable>,
    settled: fn() -> FixedTable,
) -> (ReapReport, bool) {
    reap_scripted_reads(name, reads.into_iter().map(Some).collect(), settled)
}

fn reap_scripted_reads(
    name: &str,
    reads: Vec<Option<FixedTable>>,
    settled: fn() -> FixedTable,
) -> (ReapReport, bool) {
    let directory = temporary_directory(name);
    let writer = exited_writer();
    write_marker(&directory, writer);
    let provider = exited_writer();
    let state = LineageState {
        root: Some((provider.pid, provider.started)),
        ..LineageState::default()
    };
    let journal = directory
        .join(JOURNAL_DIRECTORY_NAME)
        .join(format!("lineage-{}-0.json", writer.pid));
    fs::write(
        &journal,
        serde_json::to_vec(&state.journal_record(writer, 100)).unwrap(),
    )
    .unwrap();
    let mut reads = std::collections::VecDeque::from(reads);
    let report = reap_journals_from(
        &directory,
        writer.pid,
        Duration::ZERO,
        Duration::from_millis(200),
        || reads.pop_front().unwrap_or_else(|| Some(settled())),
        |_| true,
    );
    let journal_kept = journal.exists();
    let _ = fs::remove_dir_all(&directory);
    (report, journal_kept)
}

const TORN_ORPHAN: i32 = 900_001;
const TORN_CHILD: i32 = 900_002;
const TORN_GRANDCHILD: i32 = 900_003;
const FOREIGN_PARENT: i32 = 900_010;

#[test]
fn reaping_counts_a_process_whose_parent_exited_during_the_first_read() {
    let (report, journal_kept) = reap_torn_reads("torn-first-read", Vec::new(), || {
        table(vec![(
            entry(TORN_CHILD, TORN_ORPHAN, TORN_CHILD, 300),
            TORN_CHILD,
        )])
    });
    assert_eq!(report.reason, Some("unattributed_orphan"), "{report:?}");
    assert!(!report.verified);
    assert_eq!(report.remaining, vec![TORN_CHILD], "{report:?}");
    assert_eq!(report.signalled, 0, "{report:?}");
    assert!(journal_kept, "a refused proof keeps the journal");
}

#[test]
fn reaping_restarts_its_clean_reads_after_an_unreadable_table() {
    let (report, journal_kept) = reap_scripted_reads(
        "unreadable-between-clean-reads",
        vec![Some(table(Vec::new())), None, Some(table(Vec::new()))],
        || table(vec![(entry(TORN_ORPHAN, 1, TORN_ORPHAN, 200), TORN_ORPHAN)]),
    );
    assert_eq!(report.reason, Some("unattributed_orphan"), "{report:?}");
    assert!(!report.verified);
    assert_eq!(report.remaining, vec![TORN_ORPHAN], "{report:?}");
    assert!(journal_kept, "a refused proof keeps the journal");
}

#[test]
fn reaping_needs_consecutive_clean_reads_before_a_proof() {
    let (report, journal_kept) = reap_torn_reads("clean-reads", vec![table(Vec::new())], || {
        table(vec![(entry(TORN_ORPHAN, 1, TORN_ORPHAN, 200), TORN_ORPHAN)])
    });
    assert_eq!(report.reason, Some("unattributed_orphan"), "{report:?}");
    assert_eq!(report.remaining, vec![TORN_ORPHAN], "{report:?}");
    assert!(journal_kept, "a refused proof keeps the journal");
}

#[test]
fn reaping_keeps_a_process_in_an_orphans_group_or_session_after_the_orphan_exits() {
    let (report, journal_kept) = reap_torn_reads(
        "orphan-group",
        vec![table(vec![
            (entry(TORN_ORPHAN, 1, TORN_ORPHAN, 200), TORN_ORPHAN),
            (entry(FOREIGN_PARENT, 1, FOREIGN_PARENT, 50), FOREIGN_PARENT),
            (
                entry(TORN_CHILD, FOREIGN_PARENT, TORN_ORPHAN, 300),
                TORN_ORPHAN,
            ),
        ])],
        || {
            table(vec![
                (entry(FOREIGN_PARENT, 1, FOREIGN_PARENT, 50), FOREIGN_PARENT),
                (
                    entry(TORN_CHILD, FOREIGN_PARENT, TORN_ORPHAN, 300),
                    TORN_ORPHAN,
                ),
            ])
        },
    );
    assert_eq!(report.reason, Some("unattributed_orphan"), "{report:?}");
    assert!(!report.verified);
    assert_eq!(report.remaining, vec![TORN_CHILD], "{report:?}");
    assert_eq!(report.signalled, 0, "{report:?}");
    assert!(journal_kept, "a refused proof keeps the journal");
}

#[test]
fn reaping_keeps_an_orphans_descendants_across_reads() {
    let (report, journal_kept) = reap_torn_reads(
        "orphan-tree",
        vec![table(vec![
            (entry(TORN_ORPHAN, 1, TORN_ORPHAN, 200), TORN_ORPHAN),
            (
                entry(TORN_CHILD, TORN_ORPHAN, TORN_ORPHAN, 300),
                TORN_ORPHAN,
            ),
        ])],
        || {
            super::super::tests::table_with_unreadable(
                vec![(
                    entry(TORN_CHILD, TORN_ORPHAN, TORN_ORPHAN, 300),
                    TORN_ORPHAN,
                )],
                vec![TORN_ORPHAN],
            )
        },
    );
    assert_eq!(report.reason, Some("unattributed_orphan"), "{report:?}");
    assert!(!report.verified);
    assert_eq!(
        report.remaining,
        vec![TORN_ORPHAN, TORN_CHILD],
        "{report:?}"
    );
    assert_eq!(report.signalled, 0, "{report:?}");
    assert!(journal_kept, "a refused proof keeps the journal");
}

#[test]
fn reaping_follows_an_orphan_tree_through_successive_torn_reads() {
    let (report, journal_kept) = reap_torn_reads(
        "torn-chain",
        vec![
            table(vec![
                (entry(TORN_ORPHAN, 1, TORN_ORPHAN, 200), TORN_ORPHAN),
                (
                    entry(TORN_CHILD, TORN_ORPHAN, TORN_ORPHAN, 300),
                    TORN_ORPHAN,
                ),
            ]),
            table(vec![(
                entry(TORN_CHILD, TORN_ORPHAN, TORN_ORPHAN, 300),
                TORN_ORPHAN,
            )]),
            table(vec![(
                entry(TORN_GRANDCHILD, TORN_CHILD, TORN_ORPHAN, 400),
                TORN_ORPHAN,
            )]),
        ],
        || {
            table(vec![(
                entry(TORN_GRANDCHILD, 1, TORN_ORPHAN, 400),
                TORN_ORPHAN,
            )])
        },
    );
    assert_eq!(report.reason, Some("unattributed_orphan"), "{report:?}");
    assert!(!report.verified);
    assert_eq!(report.remaining, vec![TORN_GRANDCHILD], "{report:?}");
    assert_eq!(report.signalled, 0, "{report:?}");
    assert!(journal_kept, "a refused proof keeps the journal");
}

#[test]
fn reaping_waits_out_a_short_lived_orphan_it_cannot_attribute() {
    let _no_foreign_orphans = super::super::host_orphans::no_foreign_orphans();
    let directory = temporary_directory("short-orphan");
    let writer = exited_writer();
    write_marker(&directory, writer);
    let provider = exited_writer();
    let state = LineageState {
        root: Some((provider.pid, provider.started)),
        ..LineageState::default()
    };
    fs::write(
        directory
            .join(JOURNAL_DIRECTORY_NAME)
            .join(format!("lineage-{}-0.json", writer.pid)),
        serde_json::to_vec(&state.journal_record(writer, newest_start())).unwrap(),
    )
    .unwrap();
    let pid_file = directory.join("orphan.pid");
    let status = std::process::Command::new("perl")
        .args([
            "-e",
            "use POSIX (); exit 0 if fork(); POSIX::setsid() or die; exit 0 if fork(); select(undef, undef, undef, 0.01) while getppid() != 1; open(STDIN, '<', '/dev/null'); open(STDOUT, '>', '/dev/null'); open(STDERR, '>', '/dev/null'); open(my $f, '>', \"$ARGV[0].tmp\") or die; print $f $$; close $f; rename(\"$ARGV[0].tmp\", $ARGV[0]) or die; select(undef, undef, undef, 0.5); exit 0",
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
            .filter(|entry| entry.ppid == 1 && !entry.zombie)
        {
            break entry;
        }
        assert!(Instant::now() < deadline, "orphan job did not start");
        thread::sleep(Duration::from_millis(5));
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
    if alive {
        if let Some(group) = rustix::process::Pid::from_raw(orphan.pgid) {
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
        }
        super::super::host_orphans::wait_until_group_gone(orphan.pgid);
    }
    let _ = fs::remove_dir_all(&directory);
    assert!(report.verified, "{report:?}");
    assert_eq!(report.signalled, 0, "{report:?}");
    assert!(!alive, "the reap returned while the orphan lived");
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
