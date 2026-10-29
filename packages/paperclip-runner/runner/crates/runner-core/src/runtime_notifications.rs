//! Runtime activity shares Runner's durable, authenticated event transport.
use std::collections::HashSet;
use std::ffi::CString;
use std::fs::{self, DirBuilder};
use std::io::{Read, Write};
use std::os::fd::AsFd;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::durable::{
    verify_private_directory, DurableRunnerConfig, DurableRunnerError, DurableState,
    DurableStateStore, EventPriority,
};

pub const CONTEXT_ENV: &str = "PAPERCLIP_RUNTIME_NOTIFICATION_CONTEXT";
pub const HELPER_ENV: &str = "PAPERCLIP_RUNTIME_NOTIFICATION_HELPER";
const MAX_FRAME: usize = 2048;

pub fn context_path(state_dir: &Path) -> PathBuf {
    state_dir.join("runtime-notifications.json")
}

struct MailboxDirectory {
    directory: PathBuf,
    handle: fs::File,
}

fn open_directory_handle_at(
    parent: impl AsFd,
    path: impl rustix::path::Arg,
) -> Result<fs::File, DurableRunnerError> {
    Ok(fs::File::from(
        rustix::fs::openat(
            parent,
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(failure)?,
    ))
}

fn open_directory_at(
    parent: impl AsFd,
    path: impl rustix::path::Arg,
) -> Result<fs::File, DurableRunnerError> {
    let file = open_directory_handle_at(parent, path)?;
    if file.metadata().map_err(failure)?.permissions().mode() & 0o077 != 0 {
        return Err(failure("notification directory must be private"));
    }
    Ok(file)
}

impl MailboxDirectory {
    fn create(parent: &Path) -> Result<Self, DurableRunnerError> {
        let directory = parent.join(format!("prn-{}", Uuid::new_v4().simple()));
        DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(failure)?;
        let handle = open_directory_at(rustix::fs::CWD, &directory)?;
        Ok(Self { directory, handle })
    }
}

impl Drop for MailboxDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn write_frame(path: &Path, frame: &Value) -> Result<(), DurableRunnerError> {
    let parent = open_directory_at(
        rustix::fs::CWD,
        path.parent()
            .ok_or_else(|| failure("missing frame parent"))?,
    )?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| failure("invalid frame name"))?;
    write_frame_at(&parent, name, frame)
}

fn write_frame_at(
    directory: &fs::File,
    name: &str,
    frame: &Value,
) -> Result<(), DurableRunnerError> {
    let bytes = serde_json::to_vec(frame).map_err(failure)?;
    if bytes.len() > MAX_FRAME {
        return Err(failure("oversized notification"));
    }
    let temporary = format!(".{}.tmp", Uuid::new_v4().simple());
    let mut file = fs::File::from(
        rustix::fs::openat(
            directory,
            temporary.as_str(),
            rustix::fs::OFlags::WRONLY
                | rustix::fs::OFlags::CREATE
                | rustix::fs::OFlags::EXCL
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        )
        .map_err(failure)?,
    );
    let result = file.write_all(&bytes).map_err(failure).and_then(|_| {
        rustix::fs::renameat(directory, temporary.as_str(), directory, name).map_err(failure)
    });
    if result.is_err() {
        let _ = rustix::fs::unlinkat(directory, temporary.as_str(), rustix::fs::AtFlags::empty());
    }
    result
}

fn read_frame_at(directory: &fs::File, name: &str) -> Result<Value, DurableRunnerError> {
    let file = fs::File::from(
        rustix::fs::openat(
            directory,
            name,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(failure)?,
    );
    read_frame_file(file)
}

fn read_frame(path: &Path) -> Result<Value, DurableRunnerError> {
    let file = fs::File::from(
        rustix::fs::open(
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(failure)?,
    );
    read_frame_file(file)
}

fn read_frame_file(file: fs::File) -> Result<Value, DurableRunnerError> {
    let metadata = file.metadata().map_err(failure)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
        return Err(failure("notification frame must be a private regular file"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FRAME as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() > MAX_FRAME {
        return Err(failure("oversized notification"));
    }
    serde_json::from_slice(&bytes).map_err(failure)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    jsonrpc: String,
    id: u64,
    method: String,
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivityRecord {
    context: String,
    namespace: String,
    activity_key: String,
}

struct CleanupDirectory {
    name: CString,
    directory: fs::File,
    entries: rustix::fs::Dir,
}

pub struct RuntimeNotifications {
    _watcher: RecommendedWatcher,
    local: MailboxDirectory,
    dirty: Arc<AtomicBool>,
    scan: Option<rustix::fs::Dir>,
    cleanup: Vec<CleanupDirectory>,
    deadline: Option<Instant>,
    #[cfg(test)]
    scans: usize,
    run_id: String,
    context: String,
    activated: HashSet<(String, String)>,
}

impl RuntimeNotifications {
    pub fn bind(state_dir: &Path) -> Result<Self, DurableRunnerError> {
        verify_private_directory(state_dir)?;
        let local = MailboxDirectory::create(&std::env::temp_dir())?;
        let dirty = Arc::new(AtomicBool::new(false));
        let wake = Arc::clone(&dirty);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if !event.is_ok_and(|event| matches!(event.kind, notify::EventKind::Access(_))) {
                    wake.store(true, Ordering::Release);
                }
            })
            .map_err(failure)?;
        watcher
            .watch(&local.directory, RecursiveMode::NonRecursive)
            .map_err(failure)?;
        let path = context_path(state_dir);
        write_frame(&path, &json!({"mailbox": local.directory}))?;
        Ok(Self {
            _watcher: watcher,
            local,
            dirty,
            scan: None,
            cleanup: Vec::new(),
            deadline: None,
            #[cfg(test)]
            scans: 0,
            run_id: String::new(),
            context: String::new(),
            activated: HashSet::new(),
        })
    }

    pub(crate) fn has_pending_work(&self) -> bool {
        self.scan.is_some()
            || !self.cleanup.is_empty()
            || self.dirty.load(Ordering::Acquire)
            || self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
    }

    // Process on the authenticated control loop, never under caller-supplied run identity.
    pub fn poll(
        &mut self,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) {
        if self.run_id != config.run_id {
            self.run_id.clone_from(&config.run_id);
            self.context = Uuid::new_v4().to_string();
            self.activated.clear();
        }
        // Split the fixed budget so cleanup cannot starve new requests.
        let cleanup_budget = if self.cleanup.is_empty() { 0 } else { 8 };
        self.cleanup_step(cleanup_budget);
        if self.scan.is_none() {
            let due = self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline);
            if !self.dirty.swap(false, Ordering::AcqRel) && !due {
                return;
            }
            #[cfg(test)]
            {
                self.scans += 1;
            }
            match rustix::fs::Dir::read_from(&self.local.handle) {
                Ok(scan) => {
                    self.scan = Some(scan);
                    self.deadline = None;
                }
                Err(_) => {
                    self.deadline = Some(Instant::now() + Duration::from_secs(2));
                    return;
                }
            }
        }
        // Retain the iterator and concurrent wakes until the bounded sweep is complete.
        for _ in cleanup_budget..16 {
            let Some(entry) = self.scan.as_mut().and_then(Iterator::next) else {
                self.scan = None;
                break;
            };
            let Ok(entry) = entry else {
                self.deadline = Some(Instant::now() + Duration::from_secs(2));
                continue;
            };
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            let Ok(directory) = open_directory_at(&self.local.handle, name) else {
                continue;
            };
            // Expiry is a concrete obligation only while a publisher directory remains.
            let age = directory
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|time| time.elapsed().ok())
                .unwrap_or_default();
            if age > Duration::from_secs(2) {
                if self.cleanup.is_empty() {
                    if let Ok(entries) = rustix::fs::Dir::read_from(&directory) {
                        self.cleanup.push(CleanupDirectory {
                            name: name.to_owned(),
                            directory,
                            entries,
                        });
                        continue;
                    }
                }
                self.retry_cleanup();
                continue;
            }
            let deadline = Instant::now() + Duration::from_secs(2).saturating_sub(age);
            self.deadline = Some(self.deadline.map_or(deadline, |next| next.min(deadline)));
            self.process_request(&directory, config, state, store);
        }
    }

    fn retry_cleanup(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        self.deadline = Some(self.deadline.map_or(deadline, |next| next.min(deadline)));
    }

    fn cleanup_step(&mut self, budget: usize) {
        for _ in 0..budget {
            let Some(current) = self.cleanup.last_mut() else {
                break;
            };
            match current.entries.next() {
                Some(Ok(entry)) => {
                    let name = entry.file_name();
                    if matches!(name.to_bytes(), b"." | b"..") {
                        continue;
                    }
                    if rustix::fs::unlinkat(&current.directory, name, rustix::fs::AtFlags::empty())
                        .is_ok()
                    {
                        continue;
                    }
                    if let Ok(directory) = open_directory_handle_at(&current.directory, name) {
                        if let Ok(entries) = rustix::fs::Dir::read_from(&directory) {
                            self.cleanup.push(CleanupDirectory {
                                name: name.to_owned(),
                                directory,
                                entries,
                            });
                        } else {
                            self.cleanup.clear();
                            self.retry_cleanup();
                            break;
                        }
                    }
                }
                Some(Err(_)) => {
                    self.cleanup.clear();
                    self.retry_cleanup();
                    break;
                }
                None => {
                    let finished = self.cleanup.pop().unwrap();
                    let parent = self
                        .cleanup
                        .last()
                        .map(|frame| &frame.directory)
                        .unwrap_or(&self.local.handle);
                    if rustix::fs::unlinkat(
                        parent,
                        finished.name.as_c_str(),
                        rustix::fs::AtFlags::REMOVEDIR,
                    )
                    .is_err()
                    {
                        self.cleanup.clear();
                        self.retry_cleanup();
                        break;
                    }
                    if self.cleanup.is_empty() {
                        self.dirty.store(true, Ordering::Release);
                    }
                }
            }
        }
    }

    fn process_request(
        &mut self,
        directory: &fs::File,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) {
        // All operations stay relative to the opened directory, even if its pathname is swapped.
        if rustix::fs::renameat(directory, "request.json", directory, "processing.json").is_err() {
            return;
        }
        let request = read_frame_at(directory, "processing.json")
            .ok()
            .and_then(|value| serde_json::from_value::<Request>(value).ok());
        let _ = rustix::fs::unlinkat(directory, "processing.json", rustix::fs::AtFlags::empty());
        let Some(request) = request.filter(|request| request.jsonrpc == "2.0") else {
            return;
        };
        let result = if state.lifecycle != "ready" || state.warm_transition.is_some() {
            Err(DurableRunnerError::invalid(
                "runtime authority is not active",
            ))
        } else {
            self.handle(
                request.method.as_str(),
                request.params,
                config,
                state,
                store,
            )
        };
        let reply = match result {
            Ok(result) => json!({"jsonrpc":"2.0", "id":request.id, "result":result}),
            Err(_) => {
                json!({"jsonrpc":"2.0", "id":request.id, "error":{"code":-32602,"message":"notification rejected"}})
            }
        };
        let _ = write_frame_at(directory, "reply.json", &reply);
    }

    fn handle(
        &mut self,
        method: &str,
        params: Value,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) -> Result<Value, DurableRunnerError> {
        if method == "runtime/activityContext" && params == json!({}) {
            return Ok(json!({"context":self.context}));
        }
        if method != "runtime/recordActivity" {
            return Err(failure("unknown notification"));
        }
        let activity: ActivityRecord = serde_json::from_value(params).map_err(failure)?;
        let valid = |value: &str| {
            !value.is_empty()
                && value.chars().count() <= 160
                && !value.chars().any(|ch| ch.is_ascii_control())
        };
        if activity.context != self.context
            || !valid(&activity.namespace)
            || !valid(&activity.activity_key)
        {
            return Err(failure("invalid notification context or activity"));
        }
        let key = (activity.namespace, activity.activity_key);
        if !self.activated.contains(&key) {
            if self.activated.len() >= 128 {
                return Err(failure("notification limit reached"));
            }
            // Commit before replying; a failed hint must not poison the live outbox.
            let mut next = state.clone();
            next.enqueue_event(
                config,
                "runtime.activity.recorded",
                EventPriority::P1,
                json!({"namespace":key.0,"activityKey":key.1}),
            )?;
            store.save(&next)?;
            *state = next;
            self.activated.insert(key);
        }
        Ok(json!({"accepted":true}))
    }
}

fn failure(error: impl std::fmt::Display) -> DurableRunnerError {
    DurableRunnerError::invalid(format!("runtime notification: {error}"))
}

fn mailbox_path(path: &Path) -> Result<PathBuf, DurableRunnerError> {
    let descriptor = read_frame(path)?;
    let directory = descriptor["mailbox"]
        .as_str()
        .ok_or_else(|| failure("missing notification mailbox"))?;
    let directory = PathBuf::from(directory);
    if !directory.is_absolute() {
        return Err(failure("notification mailbox must be absolute"));
    }
    verify_private_directory(&directory)?;
    Ok(directory)
}

/// Exact resources needed by a publisher; never grant the enclosing Runner state directory.
pub(crate) fn access_paths() -> Option<[PathBuf; 3]> {
    let descriptor = PathBuf::from(std::env::var_os(CONTEXT_ENV)?);
    let helper = PathBuf::from(std::env::var_os(HELPER_ENV)?);
    let directory = mailbox_path(&descriptor).ok()?;
    if !descriptor.is_absolute() || !helper.is_absolute() {
        return None;
    }
    Some([helper, descriptor, directory])
}

fn request(path: &Path, method: &str, params: Value) -> Result<Value, DurableRunnerError> {
    let directory = mailbox_path(path)?;
    // Filesystem RPC works in tool sandboxes without network access or Runner state access.
    let root = open_directory_at(rustix::fs::CWD, &directory)?;
    let client = MailboxDirectory::create(&directory)?;
    write_frame_at(
        &client.handle,
        "request.json",
        &json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}),
    )?;
    write_frame_at(&root, "wake", &json!({}))?;
    let path = client.directory.join("reply.json");
    let deadline = Instant::now() + Duration::from_millis(500);
    while !path.try_exists().map_err(failure)? {
        if Instant::now() >= deadline {
            return Err(failure("notification timed out"));
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let reply = read_frame(&path)?;
    if reply["jsonrpc"] != "2.0" || reply["id"] != 1 || reply.get("error").is_some() {
        return Err(failure("notification rejected"));
    }
    reply
        .get("result")
        .cloned()
        .ok_or_else(|| failure("missing notification result"))
}

/// CLI helpers intentionally accept no run ID; the opaque context fences warm attachments.
pub fn run_cli(args: &[String]) -> Result<(), DurableRunnerError> {
    let path = std::env::var_os(CONTEXT_ENV)
        .ok_or_else(|| failure("notification context is unavailable"))?;
    match args {
        [command] if command == "notification-context" => {
            let result = request(Path::new(&path), "runtime/activityContext", json!({}))?;
            let context = result["context"]
                .as_str()
                .ok_or_else(|| failure("missing activity context"))?;
            println!("{context}");
            Ok(())
        }
        [command, context, namespace, activity_key] if command == "record-activity" => {
            request(
                Path::new(&path),
                "runtime/recordActivity",
                json!({"context":context,"namespace":namespace,"activityKey":activity_key}),
            )?;
            Ok(())
        }
        _ => Err(failure("invalid notification arguments")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::durable::create_private_temporary_file;
    use std::thread;

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

    fn rpc(
        server: &mut RuntimeNotifications,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
        method: &str,
        params: Value,
    ) -> Result<Value, DurableRunnerError> {
        let path = context_path(&config.state_dir);
        let method = method.to_owned();
        let client = thread::spawn(move || request(&path, &method, params));
        let start = Instant::now();
        while !client.is_finished() && start.elapsed() < Duration::from_secs(2) {
            server.poll(config, state, store);
            thread::sleep(Duration::from_millis(1));
        }
        client.join().unwrap()
    }

    fn wait_for_quiet_mailbox(
        server: &mut RuntimeNotifications,
        config: &DurableRunnerConfig,
        state: &mut DurableState,
        store: &DurableStateStore,
    ) {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut quiet_since = Instant::now();
        loop {
            let scans = server.scans;
            server.poll(config, state, store);
            if server.scans != scans
                || server.scan.is_some()
                || !server.cleanup.is_empty()
                || server.deadline.is_some()
                || server.dirty.load(Ordering::Acquire)
            {
                quiet_since = Instant::now();
            }
            if quiet_since.elapsed() >= Duration::from_millis(50) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "settled mailbox did not become quiet"
            );
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    #[ignore = "requires CODEX_NOTIFICATION_SANDBOX_COMMAND and PAPERCLIP_RUNTIME_NOTIFICATION_HELPER"]
    fn publisher_crosses_real_codex_tool_boundary_without_runner_state_access() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        use std::sync::mpsc;
        let command = std::env::var_os("CODEX_NOTIFICATION_SANDBOX_COMMAND").unwrap();
        let helper = std::env::var_os(HELPER_ENV).unwrap();
        let directory = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(directory.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        let paths = [
            PathBuf::from(&helper),
            context_path(&config.state_dir),
            server.local.directory.clone(),
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
touch "$2/probe" || exit 75
rm "$2/probe" || exit 76
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
                        "command":["/bin/sh","-c",script,"publisher",config.state_dir.join("runner-state.json"),paths[2]],
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
        assert_eq!(state.outbox.len(), 1);
        assert_eq!(state.outbox[0].envelope["payload"]["runId"], config.run_id);
    }

    #[test]
    fn concurrent_context_requests_finish_with_the_production_control_cadence() {
        let root = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(root.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(34));
        let clients = (0..33)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let descriptor = context_path(&config.state_dir);
                thread::spawn(move || {
                    barrier.wait();
                    request(&descriptor, "runtime/activityContext", json!({}))
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        // Requests arrive just after the active controller starts its normal quiet read.
        thread::sleep(crate::durable::control_read_timeout(false));
        let deadline = Instant::now() + Duration::from_secs(2);
        while clients.iter().any(|client| !client.is_finished()) && Instant::now() < deadline {
            server.poll(&config, &mut state, &store);
            thread::sleep(crate::durable::control_read_timeout(
                server.has_pending_work(),
            ));
        }
        for client in clients {
            assert!(client.join().unwrap().unwrap()["context"]
                .as_str()
                .is_some());
        }
        wait_for_quiet_mailbox(&mut server, &config, &mut state, &store);
        assert!(!server.has_pending_work());
        assert!(server.deadline.is_none());
    }

    #[test]
    fn failed_mailbox_inspection_retains_a_deadline_until_recovery() {
        let root = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(root.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        let client = MailboxDirectory::create(&server.local.directory).unwrap();
        write_frame_at(
            &client.handle,
            "request.json",
            &json!({"jsonrpc":"2.0","id":1,"method":"runtime/activityContext","params":{}}),
        )
        .unwrap();
        let saved = std::mem::replace(
            &mut server.local.handle,
            fs::File::open(context_path(&config.state_dir)).unwrap(),
        );
        server.dirty.store(true, Ordering::Release);
        server.poll(&config, &mut state, &store);
        assert!(server.scan.is_none());
        assert!(server.deadline.is_some());
        server.local.handle = saved;
        server.dirty.store(false, Ordering::Release);
        let scans = server.scans;
        server.poll(&config, &mut state, &store);
        assert_eq!(server.scans, scans);
        server.deadline = Some(Instant::now());
        server.poll(&config, &mut state, &store);
        assert_eq!(
            read_frame_at(&client.handle, "reply.json").unwrap()["id"],
            1
        );
    }

    #[test]
    fn mailbox_retains_bounded_sweeps_and_a_concurrent_publication() {
        let root = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(root.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        let mut clients = Vec::new();
        for _ in 0..20 {
            let client = MailboxDirectory::create(&server.local.directory).unwrap();
            write_frame_at(
                &client.handle,
                "request.json",
                &json!({"jsonrpc":"2.0","id":1,"method":"runtime/activityContext","params":{}}),
            )
            .unwrap();
            clients.push(client);
        }
        server.dirty.store(true, Ordering::Release);
        server.poll(&config, &mut state, &store);
        assert!(server.scan.is_some());
        assert!(clients
            .iter()
            .any(|client| !client.directory.join("reply.json").exists()));
        let late = MailboxDirectory::create(&server.local.directory).unwrap();
        write_frame_at(
            &late.handle,
            "request.json",
            &json!({"jsonrpc":"2.0","id":2,"method":"runtime/activityContext","params":{}}),
        )
        .unwrap();
        write_frame_at(&server.local.handle, "wake", &json!({})).unwrap();
        clients.push(late);
        let deadline = Instant::now() + Duration::from_secs(2);
        while clients
            .iter()
            .any(|client| !client.directory.join("reply.json").exists())
        {
            assert!(
                Instant::now() < deadline,
                "a bounded sweep lost a pending request"
            );
            server.poll(&config, &mut state, &store);
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(
            read_frame_at(&clients.last().unwrap().handle, "reply.json").unwrap()["id"],
            2
        );
        assert!(state.outbox.is_empty());
    }

    #[test]
    fn mailbox_is_quiet_until_publication_and_after_retained_history_settles() {
        let root = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(root.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        wait_for_quiet_mailbox(&mut server, &config, &mut state, &store);
        let initial_scans = server.scans;
        for _ in 0..100 {
            server.poll(&config, &mut state, &store);
        }
        assert_eq!(server.scans, initial_scans);
        let context = rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/activityContext",
            json!({}),
        )
        .unwrap()["context"]
            .clone();
        rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/recordActivity",
            json!({"context":context,"namespace":"example.runtime","activityKey":"desktop.used"}),
        )
        .unwrap();
        assert_eq!(state.outbox.len(), 1);
        wait_for_quiet_mailbox(&mut server, &config, &mut state, &store);
        let scans = server.scans;
        for _ in 0..100 {
            server.poll(&config, &mut state, &store);
        }
        assert_eq!(server.scans, scans);
        assert!(server.deadline.is_none());
        let _ = rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/activityContext",
            json!({}),
        )
        .unwrap();
        assert!(server.scans > scans);
        assert_eq!(state.outbox.len(), 1);
    }

    #[test]
    fn mailbox_directory_swap_cannot_redirect_reads_writes_or_cleanup() {
        let root = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(root.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        server.poll(&config, &mut state, &store);
        let client = MailboxDirectory::create(&server.local.directory).unwrap();
        write_frame_at(
            &client.handle,
            "request.json",
            &json!({"jsonrpc":"2.0","id":1,"method":"runtime/activityContext","params":{}}),
        )
        .unwrap();
        // Capture the exact production directory handle before the provider swaps its pathname.
        let opened =
            open_directory_at(&server.local.handle, client.directory.file_name().unwrap()).unwrap();
        let moved = client.directory.with_extension("held");
        fs::rename(&client.directory, &moved).unwrap();
        let target = config.state_dir.join("protected");
        fs::create_dir(&target).unwrap();
        let protected_request =
            json!({"jsonrpc":"2.0","id":999,"method":"runtime/activityContext","params":{}})
                .to_string();
        fs::write(target.join("request.json"), &protected_request).unwrap();
        fs::write(target.join("reply.json"), b"protected-reply").unwrap();
        std::os::unix::fs::symlink(&target, &client.directory).unwrap();
        server.process_request(&opened, &config, &mut state, &store);
        assert_eq!(read_frame_at(&opened, "reply.json").unwrap()["id"], 1);
        assert!(
            read_frame_at(&opened, "reply.json").unwrap()["result"]["context"]
                .as_str()
                .is_some()
        );
        assert_eq!(
            fs::read(target.join("request.json")).unwrap(),
            protected_request.as_bytes()
        );
        assert_eq!(
            fs::read(target.join("reply.json")).unwrap(),
            b"protected-reply"
        );
        // Expiry cleans the original object; the replacement symlink is never entered.
        let old = std::time::SystemTime::now() - Duration::from_secs(3);
        opened
            .set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();
        server.dirty.store(true, Ordering::Release);
        server.poll(&config, &mut state, &store);
        wait_for_quiet_mailbox(&mut server, &config, &mut state, &store);
        assert_eq!(fs::read_dir(&target).unwrap().count(), 2);
        assert!(state.outbox.is_empty());
        assert!(!moved.exists());
        fs::remove_file(&client.directory).unwrap();
    }

    #[test]
    fn mailbox_waits_for_complete_atomic_publication() {
        let root = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(root.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        let client = MailboxDirectory::create(&server.local.directory).unwrap();
        let request = client.directory.join("request.json");
        let (temporary, mut file) = create_private_temporary_file(&request).unwrap();
        file.write_all(b"{").unwrap();
        server.poll(&config, &mut state, &store);
        assert!(temporary.is_file());
        assert!(!client.directory.join("reply.json").exists());
        file.write_all(
            br#""jsonrpc":"2.0","id":1,"method":"runtime/activityContext","params":{}}"#,
        )
        .unwrap();
        fs::rename(temporary, &request).unwrap();
        write_frame_at(&server.local.handle, "wake", &json!({})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !client.directory.join("reply.json").exists() && Instant::now() < deadline {
            server.poll(&config, &mut state, &store);
            thread::sleep(Duration::from_millis(1));
        }
        let reply = read_frame(&client.directory.join("reply.json")).unwrap();
        assert!(reply["result"]["context"].as_str().is_some());
        assert!(!request.exists());
        assert!(state.outbox.is_empty());
    }

    #[test]
    fn mailbox_frames_are_bounded_private_and_cleaned_after_timeout() {
        let root = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(root.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        let client = MailboxDirectory::create(&server.local.directory).unwrap();
        let path = client.directory.join("request.json");
        assert!(write_frame(&path, &json!("x".repeat(MAX_FRAME))).is_err());
        fs::write(&path, "x".repeat(MAX_FRAME + 1)).unwrap();
        assert!(read_frame(&path).is_err());
        fs::remove_file(&path).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .args(["-m", "600"])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        assert!(read_frame(&path).is_err());
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(config.state_dir.join("runner-state.json"), &path).unwrap();
        server.poll(&config, &mut state, &store);
        assert!(state.outbox.is_empty());
        assert!(config.state_dir.join("runner-state.json").is_file());
        drop(client);
        assert!(request(
            &context_path(&config.state_dir),
            "runtime/activityContext",
            json!({})
        )
        .is_err());
        assert!(fs::read_dir(&server.local.directory)
            .unwrap()
            .flatten()
            .all(|entry| entry.file_name() == "wake"));
        // Model a client killed after publishing but before receiving its reply.
        let orphan = MailboxDirectory::create(&server.local.directory).unwrap();
        let handle = fs::File::open(&orphan.directory).unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(3);
        handle
            .set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();
        server.dirty.store(true, Ordering::Release);
        server.poll(&config, &mut state, &store);
        wait_for_quiet_mailbox(&mut server, &config, &mut state, &store);
        assert!(!orphan.directory.exists());
    }

    #[test]
    fn nested_orphan_cleanup_is_bounded_preserves_symlink_targets_and_becomes_quiet() {
        let root = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(root.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        let orphan = MailboxDirectory::create(&server.local.directory).unwrap();
        let mut nested = orphan.directory.clone();
        for _ in 0..24 {
            nested = nested.join("nested");
            fs::create_dir(&nested).unwrap();
        }
        for index in 0..64 {
            fs::write(nested.join(index.to_string()), b"abandoned").unwrap();
        }
        let protected = config.state_dir.join("protected");
        fs::create_dir(&protected).unwrap();
        fs::write(protected.join("sentinel"), b"unchanged").unwrap();
        std::os::unix::fs::symlink(&protected, nested.join("outside")).unwrap();
        orphan
            .handle
            .set_times(
                fs::FileTimes::new()
                    .set_modified(std::time::SystemTime::now() - Duration::from_secs(3)),
            )
            .unwrap();
        server.dirty.store(true, Ordering::Release);
        server.poll(&config, &mut state, &store);
        assert!(
            orphan.directory.exists(),
            "cleanup must yield between bounded batches"
        );
        let reply = rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/activityContext",
            json!({}),
        )
        .unwrap();
        assert!(
            reply["context"].as_str().is_some(),
            "cleanup must not starve requests"
        );
        wait_for_quiet_mailbox(&mut server, &config, &mut state, &store);
        assert!(!orphan.directory.exists());
        assert_eq!(fs::read(protected.join("sentinel")).unwrap(), b"unchanged");
        assert!(server.deadline.is_none());
        let scans = server.scans;
        for _ in 0..100 {
            server.poll(&config, &mut state, &store);
        }
        assert_eq!(server.scans, scans);
    }

    #[test]
    fn activation_identifiers_match_schema_unicode_bounds() {
        let directory = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let config = config(directory.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        let context = rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/activityContext",
            json!({}),
        )
        .unwrap()["context"]
            .clone();
        for slot in [
            "视".repeat(60),
            "😀".repeat(160),
            "view-0".into(),
            "\u{0085}".into(),
        ] {
            rpc(
                &mut server,
                &config,
                &mut state,
                &store,
                "runtime/recordActivity",
                json!({"context":context,"namespace":"example.runtime","activityKey":slot}),
            )
            .unwrap();
        }
        for slot in [
            "😀".repeat(161),
            "".into(),
            "\u{001f}".into(),
            "\u{007f}".into(),
        ] {
            assert!(rpc(
                &mut server,
                &config,
                &mut state,
                &store,
                "runtime/recordActivity",
                json!({"context":context,"namespace":"example.runtime","activityKey":slot})
            )
            .is_err());
        }
    }

    #[test]
    fn structured_activation_is_durable_bounded_and_fenced_by_runner_authority() {
        let directory = MailboxDirectory::create(&std::env::temp_dir()).unwrap();
        let mut config = config(directory.directory.clone());
        let store = DurableStateStore::new(&config.state_dir).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.lifecycle = "ready".into();
        let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
        let context = rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/activityContext",
            json!({}),
        )
        .unwrap()["context"]
            .clone();
        let activation =
            json!({"context":context,"namespace":"example.runtime","activityKey":"desktop.used"});
        let state_path = config.state_dir.join("runner-state.json");
        let backup = config.state_dir.join("state-backup");
        fs::rename(&state_path, &backup).unwrap();
        fs::create_dir(&state_path).unwrap();
        assert!(rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/recordActivity",
            activation.clone()
        )
        .is_err());
        assert!(state.outbox.is_empty());
        fs::remove_dir(&state_path).unwrap();
        fs::rename(&backup, &state_path).unwrap();
        rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/recordActivity",
            activation.clone(),
        )
        .unwrap();
        rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/recordActivity",
            activation.clone(),
        )
        .unwrap();
        assert_eq!(state.outbox.len(), 1);
        let event = &state.outbox[0].envelope["payload"];
        assert_eq!(event["eventType"], "runtime.activity.recorded");
        assert_eq!(event["runId"], "run-1");
        assert_eq!(event["sourceKind"], "runner");
        assert_eq!(
            event["payload"],
            json!({"namespace":"example.runtime","activityKey":"desktop.used"})
        );
        assert_eq!(
            store.load_or_create(&config).unwrap().0.outbox,
            state.outbox
        );
        let mut forged = activation.clone();
        forged["runId"] = json!("run-2");
        assert!(rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/recordActivity",
            forged
        )
        .is_err());
        let mut oversized = activation.clone();
        oversized["activityKey"] = json!("x".repeat(161));
        assert!(rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/recordActivity",
            oversized
        )
        .is_err());
        config.run_id = "run-2".into();
        state.run_id.clone_from(&config.run_id);
        assert!(rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/recordActivity",
            activation
        )
        .is_err());
        let current = rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/activityContext",
            json!({}),
        )
        .unwrap()["context"]
            .clone();
        assert_ne!(current, context);
        rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/recordActivity",
            json!({"context":current,"namespace":"example.runtime","activityKey":"desktop.used"}),
        )
        .unwrap();
        assert_eq!(state.outbox.len(), 2);
        assert_eq!(state.outbox[1].envelope["payload"]["runId"], "run-2");
        state.lifecycle = "suspended".into();
        assert!(rpc(
            &mut server,
            &config,
            &mut state,
            &store,
            "runtime/activityContext",
            json!({})
        )
        .is_err());
        drop(server);
        // The stable descriptor survives process recovery; old contexts do not.
        let mut replacement = RuntimeNotifications::bind(&config.state_dir).unwrap();
        state.lifecycle = "ready".into();
        assert!(rpc(
            &mut replacement,
            &config,
            &mut state,
            &store,
            "runtime/recordActivity",
            json!({"context":current,"namespace":"example.runtime","activityKey":"desktop.used"})
        )
        .is_err());
        let recovered = rpc(
            &mut replacement,
            &config,
            &mut state,
            &store,
            "runtime/activityContext",
            json!({}),
        )
        .unwrap();
        assert_ne!(recovered["context"], current);
        drop(replacement);
        fs::remove_dir_all(&config.state_dir).unwrap();
    }
}
