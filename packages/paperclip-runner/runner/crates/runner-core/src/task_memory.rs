//! Memory limit that a launcher applies to the processes Runner supervises.
//!
//! The launcher's status file is the only source of these facts, so an
//! environment that passes no flag gets no note and no notices. The agent can
//! write to the file. It can mislead only itself, so Runner bounds what the file
//! can produce and never acts on it in any other way.

use crate::durable::{
    DurableRunnerConfig, DurableRunnerError, DurableState, DurableStateStore, EventPriority,
};
use serde::Deserialize;
use serde_json::json;
use std::borrow::Cow;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const STATUS_SCHEMA: &str = "paperclip.task-memory.v1";
const MAX_STATUS_BYTES: u64 = 4096;
const CHECK_INTERVAL: Duration = Duration::from_secs(2);
const MAX_NOTICES: u32 = 64;
const BYTES_PER_GIB: u64 = 1 << 30;

static STATUS_PATH: OnceLock<PathBuf> = OnceLock::new();

// Lib tests share a process, so a process-wide path would reach unrelated tests.
#[cfg(test)]
thread_local! {
    pub(crate) static TEST_STATUS_PATH: std::cell::RefCell<Option<PathBuf>> = const {
        std::cell::RefCell::new(None)
    };
}

/// Set once at startup from the launch flag.
pub fn set_status_path(path: PathBuf) {
    let _ = STATUS_PATH.set(path);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskMemoryStatus {
    schema: String,
    limit_bytes: u64,
    killed_processes: u64,
}

#[cfg(unix)]
fn open_status(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    // A FIFO planted at this path must not block the Runner event loop.
    OpenOptions::new()
        .read(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(path)
}

#[cfg(not(unix))]
fn open_status(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

fn read_status(path: &Path) -> Option<TaskMemoryStatus> {
    let file = open_status(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut content = String::new();
    file.take(MAX_STATUS_BYTES)
        .read_to_string(&mut content)
        .ok()?;
    let status: TaskMemoryStatus = serde_json::from_str(&content).ok()?;
    (status.schema == STATUS_SCHEMA && status.limit_bytes > 0).then_some(status)
}

fn format_limit(bytes: u64) -> String {
    if bytes.is_multiple_of(BYTES_PER_GIB) {
        format!("{} GiB", bytes / BYTES_PER_GIB)
    } else {
        format!("{:.1} GiB", bytes as f64 / BYTES_PER_GIB as f64)
    }
}

fn memory_note(limit_bytes: u64, path: &Path) -> String {
    format!(
        "All task processes on this computer share a {limit} memory limit, and memory used by a \
         concurrent task counts toward it. Above the limit, the kernel kills a process with \
         SIGKILL, usually the largest, and the shell reports exit code 137. Other causes can also \
         produce that exit code. To check, read {path}: killedProcesses counts this task's \
         processes killed by the limit, and currentBytes and peakBytes show the shared use. After \
         such a kill, the same command will probably fail again, so reduce its memory use or \
         split the work. If the work cannot fit, report that as a blocker.",
        limit = format_limit(limit_bytes),
        path = path.display(),
    )
}

fn with_note_from<'a>(path: &Path, instructions: &'a str, max_bytes: usize) -> Cow<'a, str> {
    let Some(status) = read_status(path) else {
        return Cow::Borrowed(instructions);
    };
    let note = memory_note(status.limit_bytes, path);
    let separator = if instructions.is_empty() { "" } else { "\n\n" };
    // Providers reject oversized instructions, and the note is not worth a failed launch.
    if instructions.len() + separator.len() + note.len() > max_bytes {
        return Cow::Borrowed(instructions);
    }
    Cow::Owned(format!("{instructions}{separator}{note}"))
}

/// Adds the limit to instructions for a provider whose tools run under it.
pub fn instructions_with_memory_note(instructions: &str, max_bytes: usize) -> Cow<'_, str> {
    #[cfg(test)]
    if let Some(path) = TEST_STATUS_PATH.with(|path| path.borrow().clone()) {
        return with_note_from(&path, instructions, max_bytes);
    }
    match STATUS_PATH.get() {
        Some(path) => with_note_from(path, instructions, max_bytes),
        None => Cow::Borrowed(instructions),
    }
}

/// Records a run notice when the status file reports a new kill in this task.
pub struct TaskMemoryMonitor {
    path: PathBuf,
    reported: Option<u64>,
    notices: u32,
    next_check: Instant,
}

impl TaskMemoryMonitor {
    pub fn new() -> Option<Self> {
        STATUS_PATH.get().cloned().map(Self::for_path)
    }

    fn for_path(path: PathBuf) -> Self {
        Self {
            path,
            reported: None,
            notices: 0,
            next_check: Instant::now(),
        }
    }

    pub fn poll(
        &mut self,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) {
        let now = Instant::now();
        if now < self.next_check {
            return;
        }
        self.next_check = now + CHECK_INTERVAL;
        let Some(status) = read_status(&self.path) else {
            return;
        };
        // A restarted Runner must not report kills again from an earlier process.
        let reported = *self.reported.get_or_insert(status.killed_processes);
        if status.killed_processes <= reported {
            self.reported = Some(status.killed_processes);
            return;
        }
        if state.lifecycle != "ready"
            || state.warm_transition.is_some()
            || state.run_id != config.run_id
            || self.notices >= MAX_NOTICES
        {
            return;
        }
        if self.record(&status, reported, config, state, store).is_ok() {
            self.notices += 1;
            self.reported = Some(status.killed_processes);
        }
    }

    fn record(
        &self,
        status: &TaskMemoryStatus,
        reported: u64,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) -> Result<(), DurableRunnerError> {
        let new_kills = status.killed_processes - reported;
        let limit = format_limit(status.limit_bytes);
        let total = status.killed_processes;
        let killed = if new_kills == 1 {
            "a process".to_owned()
        } else {
            format!("{new_kills} processes")
        };
        let mut next = state.clone();
        next.enqueue_event(
            config,
            "provider.notice.recorded",
            EventPriority::P1,
            json!({
                "schema": "paperclip.provider.notice.v1",
                "noticeId": format!("task-memory-kill-{total}"),
                "severity": "warning",
                "category": "task_memory_limit",
                "scope": "environment",
                "recoverable": true,
                "userActionable": false,
                "summary": format!(
                    "The {limit} task memory limit killed {killed} in this task ({total} so far)."
                ),
            }),
        )?;
        store.save(&next)?;
        *state = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn create() -> Self {
            let path = std::env::temp_dir().join(format!("task-memory-{}", Uuid::new_v4()));
            fs::DirBuilder::new().create(&path).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            }
            Self(path)
        }
        fn status_path(&self) -> PathBuf {
            self.0.join("task-memory.json")
        }
        fn write_status(&self, limit_bytes: u64, killed_processes: u64) {
            fs::write(
                self.status_path(),
                json!({
                    "schema": STATUS_SCHEMA,
                    "limitBytes": limit_bytes,
                    "currentBytes": 1024,
                    "peakBytes": 2048,
                    "killedProcesses": killed_processes,
                })
                .to_string(),
            )
            .unwrap();
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn config(path: PathBuf) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1/runner".into(),
            ca_bundle_path: None,
            state_dir: path,
            runner_instance_id: "runner-1".into(),
            environment_lease_id: "lease-1".into(),
            run_id: "run-1".into(),
            normalized_session_id: "session-1".into(),
            turn_id: "turn-1".into(),
            item_id: "item-1".into(),
            runner_version: "1".into(),
            runner_digest: "sha256:digest".into(),
            acpx_launch_profile: None,
            opencode_launch_profile: None,
            cursor_cloud_launch_profile: None,
            max_outbox_bytes: 1024 * 1024,
            p0_reserve_bytes: 64 * 1024,
            max_frame_bytes: 64 * 1024,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::ZERO,
        }
    }

    fn setup(directory: &TestDirectory) -> (DurableRunnerConfig, DurableStateStore, DurableState) {
        let config = config(directory.0.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        (config, store, state)
    }

    fn notices(state: &DurableState) -> Vec<serde_json::Value> {
        state
            .outbox
            .iter()
            .filter(|event| {
                event
                    .envelope
                    .pointer("/payload/eventType")
                    .and_then(|v| v.as_str())
                    == Some("provider.notice.recorded")
            })
            .map(|event| event.envelope["payload"]["payload"].clone())
            .collect()
    }

    fn poll_now(
        monitor: &mut TaskMemoryMonitor,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) {
        monitor.next_check = Instant::now();
        monitor.poll(config, state, store);
    }

    #[test]
    fn note_states_the_limit_the_file_and_the_way_out() {
        let directory = TestDirectory::create();
        directory.write_status(6 << 30, 0);
        let path = directory.status_path();
        let with_note = with_note_from(&path, "Do the work.", 1024 * 1024);
        assert!(with_note.starts_with("Do the work.\n\nAll task processes"));
        for fact in ["6 GiB", "exit code 137", path.to_str().unwrap(), "blocker"] {
            assert!(with_note.contains(fact), "missing {fact}");
        }
        assert!(with_note_from(&path, "", 1024 * 1024).starts_with("All task processes"));
    }

    #[test]
    fn instructions_stay_unchanged_when_the_status_is_unusable() {
        let directory = TestDirectory::create();
        let path = directory.status_path();
        assert_eq!(with_note_from(&path, "Do the work.", 4096), "Do the work.");
        for content in [
            "not json".to_owned(),
            json!({"schema": "other", "limitBytes": 1, "killedProcesses": 0}).to_string(),
            json!({"schema": STATUS_SCHEMA, "limitBytes": 0, "killedProcesses": 0}).to_string(),
            json!({"schema": STATUS_SCHEMA, "limitBytes": -1, "killedProcesses": 0}).to_string(),
        ] {
            fs::write(&path, content).unwrap();
            assert_eq!(with_note_from(&path, "Do the work.", 4096), "Do the work.");
        }
    }

    #[test]
    fn note_never_pushes_instructions_over_the_provider_limit() {
        let directory = TestDirectory::create();
        directory.write_status(6 << 30, 0);
        let path = directory.status_path();
        let note_bytes = with_note_from(&path, "", usize::MAX).len();
        let fits = "x".repeat(10);
        assert_eq!(
            with_note_from(&path, &fits, 10 + 2 + note_bytes).len(),
            10 + 2 + note_bytes
        );
        assert_eq!(with_note_from(&path, &fits, 10 + 2 + note_bytes - 1), fits);
    }

    #[cfg(unix)]
    #[test]
    fn planted_special_files_do_not_block_or_count() {
        let directory = TestDirectory::create();
        let path = directory.status_path();
        let status = std::process::Command::new("/usr/bin/mkfifo")
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(read_status(&path).is_none());
        fs::remove_file(&path).unwrap();
        let target = directory.0.join("target");
        fs::write(
            &target,
            json!({"schema": STATUS_SCHEMA, "limitBytes": 1, "killedProcesses": 0}).to_string(),
        )
        .unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(read_status(&path).is_none());
    }

    #[test]
    fn limit_keeps_a_fraction_when_it_is_not_whole() {
        assert_eq!(format_limit(6 << 30), "6 GiB");
        assert_eq!(format_limit(3 << 29), "1.5 GiB");
    }

    #[test]
    fn monitor_reports_new_kills_once_with_a_valid_notice() {
        let directory = TestDirectory::create();
        let (config, store, mut state) = setup(&directory);
        directory.write_status(6 << 30, 0);
        let mut monitor = TaskMemoryMonitor::for_path(directory.status_path());
        poll_now(&mut monitor, &config, &mut state, &store);
        assert!(notices(&state).is_empty());

        directory.write_status(6 << 30, 1);
        poll_now(&mut monitor, &config, &mut state, &store);
        poll_now(&mut monitor, &config, &mut state, &store);
        directory.write_status(6 << 30, 4);
        poll_now(&mut monitor, &config, &mut state, &store);

        let notices = notices(&state);
        assert_eq!(notices.len(), 2);
        assert_eq!(notices[0]["schema"], "paperclip.provider.notice.v1");
        assert_eq!(notices[0]["noticeId"], "task-memory-kill-1");
        assert_eq!(notices[0]["severity"], "warning");
        assert_eq!(notices[0]["scope"], "environment");
        assert_eq!(
            notices[0]["summary"],
            "The 6 GiB task memory limit killed a process in this task (1 so far)."
        );
        assert_eq!(
            notices[1]["summary"],
            "The 6 GiB task memory limit killed 3 processes in this task (4 so far)."
        );
    }

    #[test]
    fn monitor_ignores_kills_from_before_it_started() {
        let directory = TestDirectory::create();
        let (config, store, mut state) = setup(&directory);
        directory.write_status(6 << 30, 5);
        let mut monitor = TaskMemoryMonitor::for_path(directory.status_path());
        poll_now(&mut monitor, &config, &mut state, &store);
        assert!(notices(&state).is_empty());
        // A count that restarts belongs to a new cgroup.
        directory.write_status(6 << 30, 0);
        poll_now(&mut monitor, &config, &mut state, &store);
        directory.write_status(6 << 30, 1);
        poll_now(&mut monitor, &config, &mut state, &store);
        assert_eq!(notices(&state).len(), 1);
    }

    #[test]
    fn monitor_waits_for_an_active_run_and_keeps_the_kill() {
        let directory = TestDirectory::create();
        let (config, store, mut state) = setup(&directory);
        directory.write_status(6 << 30, 0);
        let mut monitor = TaskMemoryMonitor::for_path(directory.status_path());
        poll_now(&mut monitor, &config, &mut state, &store);
        directory.write_status(6 << 30, 2);
        state.lifecycle = "reconnecting".into();
        poll_now(&mut monitor, &config, &mut state, &store);
        assert!(notices(&state).is_empty());
        state.lifecycle = "ready".into();
        poll_now(&mut monitor, &config, &mut state, &store);
        assert_eq!(notices(&state).len(), 1);
    }

    #[test]
    fn monitor_bounds_notices_and_checks_at_an_interval() {
        let directory = TestDirectory::create();
        let (config, store, mut state) = setup(&directory);
        directory.write_status(6 << 30, 0);
        let mut monitor = TaskMemoryMonitor::for_path(directory.status_path());
        monitor.poll(&config, &mut state, &store);
        directory.write_status(6 << 30, 1);
        monitor.poll(&config, &mut state, &store);
        assert!(notices(&state).is_empty());
        for count in 1..=u64::from(MAX_NOTICES) + 5 {
            directory.write_status(6 << 30, count);
            poll_now(&mut monitor, &config, &mut state, &store);
        }
        assert_eq!(notices(&state).len(), MAX_NOTICES as usize);
    }
}
