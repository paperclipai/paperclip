//! Run-scoped activity notifications from provider commands.
use crate::durable::{
    create_private_temporary_file, verify_private_directory, DurableRunnerConfig,
    DurableRunnerError, DurableState, DurableStateStore, EventPriority,
};
use crate::process_supervisor::{read_bounded_line, BoundedLine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, SyncSender},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const CONTEXT_ENV: &str = "PAPERCLIP_RUNTIME_NOTIFICATION_CONTEXT";
pub const HELPER_ENV: &str = "PAPERCLIP_RUNTIME_NOTIFICATION_HELPER";
const MAX_FRAME: usize = 2048;
const QUEUE_LIMIT: usize = 128;

pub fn context_path(state_dir: &Path) -> PathBuf {
    state_dir.join("runtime-notifications.json")
}
fn failure(error: impl std::fmt::Display) -> DurableRunnerError {
    DurableRunnerError::invalid(format!("runtime notification: {error}"))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    pipe: PathBuf,
    context: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Activity {
    context: String,
    namespace: String,
    activity_key: String,
}

// Fixed-path cleanup never traverses provider-created contents.
struct ActivityPipe(PathBuf);
impl Drop for ActivityPipe {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_file(self.0.with_extension("lock"));
        let _ = fs::remove_dir(self.0.parent().unwrap());
    }
}

fn private_file(path: &Path) -> Result<File, DurableRunnerError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(path)
        .map_err(failure)?;
    let metadata = file.metadata().map_err(failure)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 || metadata.len() > 8192 {
        return Err(failure("invalid endpoint descriptor"));
    }
    Ok(file)
}

fn descriptor(path: &Path) -> Result<Endpoint, DurableRunnerError> {
    let mut file = private_file(path)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    serde_json::from_slice(&bytes).map_err(failure)
}

fn write_descriptor(path: &Path, endpoint: &Endpoint) -> Result<(), DurableRunnerError> {
    let bytes = serde_json::to_vec(endpoint).map_err(failure)?;
    let (temporary, mut file) = create_private_temporary_file(path)?;
    let result = file
        .write_all(&bytes)
        .and_then(|()| fs::rename(&temporary, path));
    let _ = fs::remove_file(temporary);
    result.map_err(failure)
}

// Check between reads so shutdown also ends an unterminated full-pipe record.
struct StoppableReader<'a, R>(R, &'a AtomicBool);
impl<R: Read> Read for StoppableReader<'_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if self.1.load(Ordering::Acquire) {
            return Ok(0);
        }
        self.0.read(bytes)
    }
}

fn receive_records(mut reader: impl Read, sender: SyncSender<Activity>, stopped: &AtomicBool) {
    let mut reader = BufReader::with_capacity(MAX_FRAME, StoppableReader(&mut reader, stopped));
    while !stopped.load(Ordering::Acquire) {
        match read_bounded_line(&mut reader, MAX_FRAME - 2) {
            Ok(BoundedLine::Line(line)) => {
                if let Ok(activity) = serde_json::from_str(&line) {
                    let _ = sender.try_send(activity);
                }
            }
            Err(error)
                if !matches!(
                    error.kind(),
                    std::io::ErrorKind::Interrupted | std::io::ErrorKind::InvalidData
                ) =>
            {
                break
            }
            Ok(BoundedLine::Eof) => break,
            _ => {}
        }
    }
}

fn publish(path: &Path, activity: &Activity) -> Result<(), DurableRunnerError> {
    let bytes = serde_json::to_vec(activity).map_err(failure)?;
    if bytes.len() + 2 > MAX_FRAME {
        return Err(failure("oversized activity"));
    }
    let endpoint = descriptor(path)?;
    if endpoint.context.is_empty() || endpoint.context != activity.context {
        return Err(failure("runtime authority is inactive or changed"));
    }
    // A stable read-only lock serializes publishers; the descriptor can rotate atomically.
    let guard = private_file(&endpoint.pipe.with_extension("lock"))?;
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match guard.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(1))
            }
            Err(error) => return Err(failure(error)),
        }
    }
    let mut pipe = OpenOptions::new()
        .write(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(endpoint.pipe)
        .map_err(failure)?;
    if !pipe.metadata().map_err(failure)?.file_type().is_fifo() {
        return Err(failure("invalid activity pipe"));
    }
    // A leading newline terminates any incomplete previous write.
    let mut frame = vec![b'\n'];
    frame.extend(bytes);
    frame.push(b'\n');
    pipe.write_all(&frame).map_err(failure)
}

pub struct RuntimeNotifications {
    pipe: ActivityPipe,
    wake: File,
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    incoming: Receiver<Activity>,
    run_id: Option<String>,
    context: String,
    recorded: HashSet<(String, String)>,
}

impl RuntimeNotifications {
    pub fn bind(state_dir: &Path) -> Result<Self, DurableRunnerError> {
        verify_private_directory(state_dir)?;
        let directory = fs::canonicalize(std::env::temp_dir())
            .map_err(failure)?
            .join(format!("runtime-activity-{}", Uuid::new_v4().simple()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(failure)?;
        let pipe = ActivityPipe(directory.join("activity.fifo"));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(pipe.0.with_extension("lock"))
            .map_err(failure)?;
        let status = std::process::Command::new("/usr/bin/mkfifo")
            .args(["-m", "600"])
            .arg(&pipe.0)
            .env_clear()
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(failure)?;
        if !status.success() {
            return Err(failure("cannot create activity pipe"));
        }
        let reader = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(&pipe.0)
            .map_err(failure)?;
        if !reader.metadata().map_err(failure)?.file_type().is_fifo() {
            return Err(failure("invalid activity pipe"));
        }
        let wake = OpenOptions::new()
            .write(true)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
            )
            .open(&pipe.0)
            .map_err(failure)?;
        write_descriptor(
            &context_path(state_dir),
            &Endpoint {
                pipe: pipe.0.clone(),
                context: String::new(),
            },
        )?;
        let (sender, incoming) = mpsc::sync_channel(QUEUE_LIMIT);
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        let worker = thread::Builder::new()
            .name("runner-activity".into())
            .spawn(move || receive_records(reader, sender, &stop))
            .map_err(failure)?;
        Ok(Self {
            pipe,
            wake,
            stopped,
            worker: Some(worker),
            incoming,
            run_id: None,
            context: String::new(),
            recorded: HashSet::new(),
        })
    }

    pub fn poll(
        &mut self,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) {
        let run_id = (state.lifecycle == "ready"
            && state.warm_transition.is_none()
            && state.run_id == config.run_id)
            .then_some(config.run_id.as_str());
        if self.run_id.as_deref() != run_id {
            self.run_id = run_id.map(str::to_owned);
            self.recorded.clear();
            self.context = if run_id.is_some() {
                Uuid::new_v4().to_string()
            } else {
                String::new()
            };
            if write_descriptor(
                &context_path(&config.state_dir),
                &Endpoint {
                    pipe: self.pipe.0.clone(),
                    context: self.context.clone(),
                },
            )
            .is_err()
            {
                self.context.clear();
            }
        }
        for _ in 0..16 {
            let Ok(activity) = self.incoming.try_recv() else {
                break;
            };
            let _ = self.record(activity, config, state, store);
        }
    }

    fn record(
        &mut self,
        activity: Activity,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) -> Result<(), DurableRunnerError> {
        let valid = |value: &str| {
            !value.is_empty()
                && value.chars().count() <= 160
                && !value.chars().any(|ch| ch.is_ascii_control())
        };
        if self.context.is_empty()
            || state.run_id != config.run_id
            || activity.context != self.context
            || !valid(&activity.namespace)
            || !valid(&activity.activity_key)
        {
            return Err(failure("invalid activity context or identifiers"));
        }
        let key = (activity.namespace, activity.activity_key);
        if !self.recorded.contains(&key) {
            if self.recorded.len() >= QUEUE_LIMIT {
                return Err(failure("activity limit reached"));
            }
            let mut next = state.clone();
            next.enqueue_event(
                config,
                "runtime.activity.recorded",
                EventPriority::P1,
                json!({"namespace":key.0,"activityKey":key.1}),
            )?;
            store.save(&next)?;
            *state = next;
            self.recorded.insert(key);
        }
        Ok(())
    }
}

impl Drop for RuntimeNotifications {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        // A nonblocking, sub-PIPE_BUF write wakes an idle reader; a full pipe is already readable.
        loop {
            match self.wake.write(b"\n") {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                _ => break,
            }
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn access_paths() -> Option<[PathBuf; 4]> {
    let path = PathBuf::from(std::env::var_os(CONTEXT_ENV)?);
    let endpoint = descriptor(&path).ok()?;
    Some([
        PathBuf::from(std::env::var_os(HELPER_ENV)?),
        path,
        endpoint.pipe.with_extension("lock"),
        endpoint.pipe,
    ])
}

pub fn run_cli(args: &[String]) -> Result<(), DurableRunnerError> {
    let path = PathBuf::from(
        std::env::var_os(CONTEXT_ENV).ok_or_else(|| failure("activity endpoint is unavailable"))?,
    );
    match args {
        [command] if command == "notification-context" => {
            let endpoint = descriptor(&path)?;
            if endpoint.context.is_empty() {
                return Err(failure("runtime authority is inactive"));
            }
            println!("{}", endpoint.context);
            Ok(())
        }
        [command, context, namespace, activity_key] if command == "record-activity" => publish(
            &path,
            &Activity {
                context: context.clone(),
                namespace: namespace.clone(),
                activity_key: activity_key.clone(),
            },
        ),
        _ => Err(failure("invalid activity arguments")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::os::unix::fs::DirBuilderExt;
    struct TestDirectory {
        directory: PathBuf,
    }
    impl TestDirectory {
        fn create(parent: &Path) -> std::io::Result<Self> {
            let directory = parent.join(format!("activity-test-{}", Uuid::new_v4()));
            fs::DirBuilder::new().mode(0o700).create(&directory)?;
            Ok(Self { directory })
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
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
            max_outbox_bytes: 1024 * 1024,
            p0_reserve_bytes: 64 * 1024,
            max_frame_bytes: 64 * 1024,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::ZERO,
        }
    }

    fn activity(context: &str, key: &str) -> Activity {
        Activity {
            context: context.into(),
            namespace: "example.runtime".into(),
            activity_key: key.into(),
        }
    }
    fn setup() -> (
        TestDirectory,
        DurableRunnerConfig,
        DurableStateStore,
        DurableState,
        RuntimeNotifications,
    ) {
        let directory = TestDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(directory.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        server.poll(&config, &mut state, &store);
        (directory, config, store, state, server)
    }
    #[test]
    fn capture_is_local_and_authority_rotation_rejects_late_completion() {
        let (_directory, mut config, store, mut state, mut server) = setup();
        let first = descriptor(&context_path(&config.state_dir)).unwrap();
        for _ in 0..100 {
            assert_eq!(
                descriptor(&context_path(&config.state_dir))
                    .unwrap()
                    .context,
                first.context
            );
        }
        config.run_id = "next-run".into();
        state.run_id.clone_from(&config.run_id);
        server.poll(&config, &mut state, &store);
        assert!(server
            .record(
                activity(&first.context, "desktop.used"),
                &config,
                &mut state,
                &store
            )
            .is_err());
        let current = server.context.clone();
        server
            .record(
                activity(&current, "desktop.used"),
                &config,
                &mut state,
                &store,
            )
            .unwrap();
        server
            .record(
                activity(&current, "desktop.used"),
                &config,
                &mut state,
                &store,
            )
            .unwrap();
        assert_eq!(state.outbox.len(), 1);
        assert_eq!(state.outbox[0].envelope["payload"]["runId"], "next-run");
        state.lifecycle = "closed".into();
        server.poll(&config, &mut state, &store);
        assert!(server
            .record(
                activity(&current, "desktop.used"),
                &config,
                &mut state,
                &store
            )
            .is_err());
        assert!(descriptor(&context_path(&config.state_dir))
            .unwrap()
            .context
            .is_empty());
        drop(server);
        state.lifecycle = "ready".into();
        let mut recovered = RuntimeNotifications::bind(&config.state_dir).unwrap();
        recovered.poll(&config, &mut state, &store);
        assert!(recovered
            .record(
                activity(&current, "desktop.used"),
                &config,
                &mut state,
                &store
            )
            .is_err());
    }
    #[test]
    fn unicode_limits_and_failed_persistence_leave_authority_usable() {
        let (_directory, config, store, mut state, mut server) = setup();
        let context = server.context.clone();
        for key in ["视".repeat(60), "😀".repeat(160), "\u{85}".into()] {
            server
                .record(activity(&context, &key), &config, &mut state, &store)
                .unwrap();
        }
        for key in [
            "".into(),
            "😀".repeat(161),
            "\u{1f}".into(),
            "\u{7f}".into(),
        ] {
            assert!(server
                .record(activity(&context, &key), &config, &mut state, &store)
                .is_err());
        }
        let saved = config.state_dir.join("runner-state.json");
        let backup = saved.with_extension("backup");
        fs::rename(&saved, &backup).unwrap();
        fs::create_dir(&saved).unwrap();
        let before = state.outbox.len();
        assert!(server
            .record(
                activity(&context, "retry.used"),
                &config,
                &mut state,
                &store
            )
            .is_err());
        assert_eq!(state.outbox.len(), before);
        fs::remove_dir(&saved).unwrap();
        fs::rename(backup, saved).unwrap();
        server
            .record(
                activity(&context, "retry.used"),
                &config,
                &mut state,
                &store,
            )
            .unwrap();
        assert_eq!(state.outbox.len(), before + 1);
    }
    #[test]
    fn malformed_partial_and_oversized_records_resynchronize_with_bounded_queue() {
        let good = serde_json::to_vec(&activity("context", "desktop.used")).unwrap();
        let mut bytes = vec![b'x'; MAX_FRAME * 2];
        bytes.extend(b"\n{broken\n\xff\n{\"partial\":");
        for _ in 0..QUEUE_LIMIT + 10 {
            bytes.push(b'\n');
            bytes.extend(&good);
            bytes.push(b'\n');
        }
        let (tx, rx) = mpsc::sync_channel(QUEUE_LIMIT);
        receive_records(Cursor::new(bytes), tx, &AtomicBool::new(false));
        let records: Vec<_> = rx.try_iter().collect();
        assert_eq!(records.len(), QUEUE_LIMIT);
        assert_eq!(records[0].activity_key, "desktop.used");
        assert!(serde_json::from_value::<Activity>(json!({"context":"context","namespace":"example.runtime","activityKey":"desktop.used","runId":"caller"})).is_err());
    }
    #[test]
    fn publish_reaches_the_durable_run_without_a_reply_or_idle_filesystem_work() {
        let (_directory, config, store, mut state, mut server) = setup();
        let path = context_path(&config.state_dir);
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let context = server.context.clone();
        publish(&path, &activity(&context, "desktop.used")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while state.outbox.is_empty() && Instant::now() < deadline {
            server.poll(&config, &mut state, &store);
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(state.outbox.len(), 1);
        for _ in 0..100 {
            server.poll(&config, &mut state, &store);
        }
        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), modified);
        assert_eq!(
            state.outbox[0].envelope["payload"]["payload"],
            json!({"namespace":"example.runtime","activityKey":"desktop.used"})
        );
    }
    #[test]
    fn concurrent_unicode_records_stay_framed_and_rotation_does_not_wait_for_publishers() {
        let (_directory, mut config, store, mut state, mut server) = setup();
        let path = context_path(&config.state_dir);
        let old = descriptor(&path).unwrap();
        let guard = private_file(&old.pipe.with_extension("lock")).unwrap();
        guard.try_lock().unwrap();
        config.run_id = "next-run".into();
        state.run_id.clone_from(&config.run_id);
        server.poll(&config, &mut state, &store);
        let current = descriptor(&path).unwrap();
        assert_ne!(old.context, current.context);
        assert!(publish(&path, &activity(&old.context, "desktop.used")).is_err());
        assert!(publish(&path, &activity(&current.context, "desktop.used")).is_err());
        drop(guard);
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                let activity = Activity {
                    context: current.context.clone(),
                    namespace: "😀".repeat(160),
                    activity_key: format!("{index}{}", "😀".repeat(159)),
                };
                thread::spawn(move || {
                    barrier.wait();
                    publish(&path, &activity).unwrap();
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while state.outbox.len() < 8 && Instant::now() < deadline {
            server.poll(&config, &mut state, &store);
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(state.outbox.len(), 8);
        assert!(state
            .outbox
            .iter()
            .all(|event| event.envelope["payload"]["runId"] == "next-run"));
    }

    #[test]
    fn endpoint_replacement_cannot_redirect_writes_or_make_shutdown_traverse_a_tree() {
        let (_directory, config, store, mut state, mut server) = setup();
        let pipe = server.pipe.0.clone();
        fs::remove_file(&pipe).unwrap();
        fs::create_dir(&pipe).unwrap();
        let mut nested = pipe.clone();
        for _ in 0..100 {
            nested = nested.join("deep");
            fs::create_dir(&nested).unwrap();
        }
        fs::write(nested.join("protected"), b"unchanged").unwrap();
        fs::set_permissions(&nested, fs::Permissions::from_mode(0)).unwrap();
        assert!(publish(
            &context_path(&config.state_dir),
            &activity(&server.context, "desktop.used")
        )
        .is_err());
        for _ in 0..100 {
            server.poll(&config, &mut state, &store);
        }
        server.wake.write_all(b"{\"partial\":").unwrap();
        let started = Instant::now();
        drop(server);
        assert!(started.elapsed() < Duration::from_secs(2));
        fs::set_permissions(&nested, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(fs::read(nested.join("protected")).unwrap(), b"unchanged");
        fs::remove_dir_all(pipe.parent().unwrap()).unwrap();
    }
    #[test]
    #[ignore = "requires CODEX_NOTIFICATION_SANDBOX_COMMAND and PAPERCLIP_RUNTIME_NOTIFICATION_HELPER"]
    fn publisher_crosses_real_codex_tool_boundary_without_runner_state_access() {
        use serde_json::Value;
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        use std::sync::mpsc;
        let command = std::env::var_os("CODEX_NOTIFICATION_SANDBOX_COMMAND").unwrap();
        let helper = std::env::var_os(HELPER_ENV).unwrap();
        let directory = TestDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(directory.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        server.poll(&config, &mut state, &store);
        let paths = [
            PathBuf::from(&helper),
            context_path(&config.state_dir),
            server.pipe.0.with_extension("lock"),
            server.pipe.0.clone(),
        ];
        let workspace = config.state_dir.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let home = workspace.join("home");
        fs::create_dir(&home).unwrap();
        let profile = "paperclip-runner-workspace-only";
        let mut args = vec![
            "-c".into(),
            format!("default_permissions=\"{profile}\""),
            "-c".into(),
            "shell_environment_policy.include_only=[\"PATH\",\"LANG\"]".into(),
        ];
        for name in [profile, "paperclip-runner-workspace-read-only"] {
            args.extend(["-c".into(), format!("permissions.{name}.filesystem={{\":root\"=\"none\",\":minimal\"=\"read\",\":tmpdir\"=\"none\",\":workspace_roots\"={{\".\"=\"read\"}}}}"),
                "-c".into(), format!("permissions.{name}.network.enabled=false")]);
        }
        let extra = crate::codex_provider::runtime_notification_codex_args(&args, profile, &paths);
        let script = r#"
[ -z "${UNRELATED_SECRET:-}" ] || exit 70
if cat "$1" >/dev/null 2>&1; then exit 71; fi
if /bin/sh -c ': >> "$PAPERCLIP_RUNTIME_NOTIFICATION_CONTEXT"' 2>/dev/null; then exit 72; fi
if touch "$2/probe" 2>/dev/null; then exit 75; fi
if touch "$3/probe" 2>/dev/null; then exit 76; fi
if /bin/sh -c ': >> "$1"' ignored "$4" 2>/dev/null; then exit 77; fi
context=$("$PAPERCLIP_RUNTIME_NOTIFICATION_HELPER" notification-context) || exit 73
"$PAPERCLIP_RUNTIME_NOTIFICATION_HELPER" record-activity "$context" example.runtime desktop.used || exit 74
"#;
        let mut child = Command::new(command)
            .args(args)
            .args(extra)
            .args(["app-server", "--stdio", "--strict-config"])
            .current_dir(&workspace)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .env("HOME", &home)
            .env("CODEX_HOME", &home)
            .env("UNRELATED_SECRET", "must-not-reach-command")
            .env(CONTEXT_ENV, &paths[1])
            .env(HELPER_ENV, helper)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(value);
                }
            }
        });
        writeln!(input, "{}", json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"notification-probe","version":"1"},"capabilities":{"experimentalApi":true}}})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut response = None;
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline && response.is_none()
        {
            server.poll(&config, &mut state, &store);
            while let Ok(message) = rx.try_recv() {
                if message["id"] == 1 {
                    assert!(message.get("error").is_none(), "initialize: {message}");
                    writeln!(input, "{}", json!({"method":"initialized","params":{}})).unwrap();
                    writeln!(input, "{}", json!({"id":2,"method":"command/exec","params":{
                        "command":["/bin/sh","-c",script,"publisher",config.state_dir.join("runner-state.json"),config.state_dir,server.pipe.0.parent().unwrap(),server.pipe.0.with_extension("lock")],
                        "cwd":workspace,"timeoutMs":10000}})).unwrap();
                } else if message["id"] == 2 {
                    response = Some(message);
                }
            }
            thread::sleep(Duration::from_millis(1));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        let result = child.wait_with_output().unwrap();
        reader.join().unwrap();
        let response = response.unwrap_or_else(|| {
            panic!(
                "app-server did not reply: {}",
                String::from_utf8_lossy(&result.stderr)
            )
        });
        assert!(response.get("error").is_none(), "command: {response}");
        assert_eq!(response["result"]["exitCode"], 0, "publisher: {response}");
        let deadline = Instant::now() + Duration::from_secs(2);
        while state.outbox.is_empty() && Instant::now() < deadline {
            server.poll(&config, &mut state, &store);
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(state.outbox.len(), 1);
        assert_eq!(state.outbox[0].envelope["payload"]["runId"], config.run_id);
    }
}
