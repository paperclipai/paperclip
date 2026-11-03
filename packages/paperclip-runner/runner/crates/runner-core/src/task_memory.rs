//! Memory limit that a launcher applies to the processes Runner supervises.
//!
//! The kernel's cgroup files are the only source of these facts, so an environment
//! that passes no flag gets no note and no notices.

use crate::durable::{
    DurableRunnerConfig, DurableRunnerError, DurableState, DurableStateStore, EventPriority,
};
use serde_json::json;
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const CHECK_INTERVAL: Duration = Duration::from_secs(2);
const MAX_NOTICES: u32 = 64;
const BYTES_PER_GIB: u64 = 1 << 30;

static TASK_CGROUP: OnceLock<PathBuf> = OnceLock::new();

// Lib tests share a process, so a process-wide path would reach unrelated tests.
#[cfg(test)]
thread_local! {
    pub(crate) static TEST_TASK_CGROUP: std::cell::RefCell<Option<PathBuf>> = const {
        std::cell::RefCell::new(None)
    };
}

/// Set once at startup from the launch flag.
pub fn set_task_cgroup(path: PathBuf) {
    let _ = TASK_CGROUP.set(path);
}

/// The limit on the parent cgroup, which tasks share. "max" means no limit.
fn read_limit(task_cgroup: &Path) -> Option<u64> {
    let content = fs::read_to_string(task_cgroup.parent()?.join("memory.max")).ok()?;
    content.trim().parse().ok().filter(|limit| *limit > 0)
}

/// The kernel counts a limit kill in the victim's cgroup, so this is specific to
/// the task even though the limit is shared.
fn read_kills(task_cgroup: &Path) -> Option<u64> {
    fs::read_to_string(task_cgroup.join("memory.events"))
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("oom_kill "))?
        .trim()
        .parse()
        .ok()
}

fn format_limit(bytes: u64) -> String {
    if bytes.is_multiple_of(BYTES_PER_GIB) {
        format!("{} GiB", bytes / BYTES_PER_GIB)
    } else {
        format!("{:.1} GiB", bytes as f64 / BYTES_PER_GIB as f64)
    }
}

fn memory_note(limit_bytes: u64, task_cgroup: &Path) -> Option<String> {
    let shared = task_cgroup.parent()?;
    Some(format!(
        "All task processes on this computer share a {limit} memory limit, and memory used by a \
         concurrent task counts toward it. Above the limit, the kernel kills a process with \
         SIGKILL, usually the largest, and the shell reports exit code 137. Other causes can also \
         produce that exit code. To check, read the oom_kill count in {task}/memory.events. Read \
         {shared}/memory.current and {shared}/memory.peak for the shared use. After such a kill, \
         the same command will probably fail again, so reduce its memory use or split the work. \
         If the work cannot fit, report that as a blocker.",
        limit = format_limit(limit_bytes),
        task = task_cgroup.display(),
        shared = shared.display(),
    ))
}

fn with_note_from<'a>(task_cgroup: &Path, instructions: &'a str, max_bytes: usize) -> Cow<'a, str> {
    let Some(note) = read_limit(task_cgroup).and_then(|limit| memory_note(limit, task_cgroup))
    else {
        return Cow::Borrowed(instructions);
    };
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
    if let Some(path) = TEST_TASK_CGROUP.with(|path| path.borrow().clone()) {
        return with_note_from(&path, instructions, max_bytes);
    }
    match TASK_CGROUP.get() {
        Some(path) => with_note_from(path, instructions, max_bytes),
        None => Cow::Borrowed(instructions),
    }
}

/// Records a run notice when the kernel reports a new kill in this task.
pub struct TaskMemoryMonitor {
    task_cgroup: PathBuf,
    reported: Option<u64>,
    notices: u32,
    next_check: Instant,
}

impl TaskMemoryMonitor {
    pub fn new() -> Option<Self> {
        TASK_CGROUP.get().cloned().map(Self::for_cgroup)
    }

    fn for_cgroup(task_cgroup: PathBuf) -> Self {
        Self {
            task_cgroup,
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
        let Some(kills) = read_kills(&self.task_cgroup) else {
            return;
        };
        // A restarted Runner must not report kills again from an earlier process.
        let reported = *self.reported.get_or_insert(kills);
        if kills <= reported {
            return;
        }
        if state.lifecycle != "ready"
            || state.warm_transition.is_some()
            || state.run_id != config.run_id
            || self.notices >= MAX_NOTICES
        {
            return;
        }
        if self.record(kills, reported, config, state, store).is_ok() {
            self.notices += 1;
            self.reported = Some(kills);
        }
    }

    fn record(
        &self,
        total: u64,
        reported: u64,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) -> Result<(), DurableRunnerError> {
        let new_kills = total - reported;
        let limit = read_limit(&self.task_cgroup)
            .map(|limit| format!("{} ", format_limit(limit)))
            .unwrap_or_default();
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
                    "The {limit}task memory limit killed {killed} in this task ({total} so far)."
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
            fs::create_dir_all(path.join("tasks").join("task-a")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            }
            Self(path)
        }
        fn task_cgroup(&self) -> PathBuf {
            self.0.join("tasks").join("task-a")
        }
        fn write_limit(&self, limit: &str) {
            fs::write(self.0.join("tasks").join("memory.max"), limit).unwrap();
        }
        fn write_kills(&self, kills: u64) {
            fs::write(
                self.task_cgroup().join("memory.events"),
                format!("low 0\nhigh 0\nmax 7\noom 2\noom_kill {kills}\noom_group_kill 0\n"),
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

    fn monitor(directory: &TestDirectory) -> TaskMemoryMonitor {
        directory.write_limit("6442450944\n");
        directory.write_kills(0);
        TaskMemoryMonitor::for_cgroup(directory.task_cgroup())
    }

    #[test]
    fn note_states_the_limit_the_files_and_the_way_out() {
        let directory = TestDirectory::create();
        directory.write_limit("6442450944\n");
        let task = directory.task_cgroup();
        let with_note = with_note_from(&task, "Do the work.", 1024 * 1024);
        assert!(with_note.starts_with("Do the work.\n\nAll task processes"));
        let events = format!("{}/memory.events", task.display());
        let current = format!("{}/memory.current", task.parent().unwrap().display());
        for fact in ["6 GiB", "exit code 137", &events, &current, "blocker"] {
            assert!(with_note.contains(fact), "missing {fact}");
        }
        assert!(with_note_from(&task, "", 1024 * 1024).starts_with("All task processes"));
    }

    #[test]
    fn instructions_stay_unchanged_without_a_limit() {
        let directory = TestDirectory::create();
        let task = directory.task_cgroup();
        assert_eq!(with_note_from(&task, "Do the work.", 4096), "Do the work.");
        for limit in ["max\n", "0\n", "not a number"] {
            directory.write_limit(limit);
            assert_eq!(with_note_from(&task, "Do the work.", 4096), "Do the work.");
        }
    }

    #[test]
    fn note_never_pushes_instructions_over_the_provider_limit() {
        let directory = TestDirectory::create();
        directory.write_limit("6442450944\n");
        let task = directory.task_cgroup();
        let note_bytes = with_note_from(&task, "", usize::MAX).len();
        let fits = "x".repeat(10);
        assert_eq!(
            with_note_from(&task, &fits, 10 + 2 + note_bytes).len(),
            10 + 2 + note_bytes
        );
        assert_eq!(with_note_from(&task, &fits, 10 + 2 + note_bytes - 1), fits);
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
        let mut monitor = monitor(&directory);
        poll_now(&mut monitor, &config, &mut state, &store);
        assert!(notices(&state).is_empty());

        directory.write_kills(1);
        poll_now(&mut monitor, &config, &mut state, &store);
        poll_now(&mut monitor, &config, &mut state, &store);
        directory.write_kills(4);
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
        let mut monitor = monitor(&directory);
        directory.write_kills(5);
        poll_now(&mut monitor, &config, &mut state, &store);
        assert!(notices(&state).is_empty());
        directory.write_kills(6);
        poll_now(&mut monitor, &config, &mut state, &store);
        assert_eq!(notices(&state).len(), 1);
    }

    #[test]
    fn monitor_waits_for_an_active_run_and_keeps_the_kill() {
        let directory = TestDirectory::create();
        let (config, store, mut state) = setup(&directory);
        let mut monitor = monitor(&directory);
        poll_now(&mut monitor, &config, &mut state, &store);
        directory.write_kills(2);
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
        let mut monitor = monitor(&directory);
        monitor.poll(&config, &mut state, &store);
        directory.write_kills(1);
        monitor.poll(&config, &mut state, &store);
        assert!(notices(&state).is_empty());
        for count in 1..=u64::from(MAX_NOTICES) + 5 {
            directory.write_kills(count);
            poll_now(&mut monitor, &config, &mut state, &store);
        }
        assert_eq!(notices(&state).len(), MAX_NOTICES as usize);
    }
}
