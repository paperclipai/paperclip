use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::acpx_sidecar_transport::ACPX_AUTH_JSON_FILE_ENV;
use crate::credential_write_back::{self, WriteBack};
use crate::durable::{
    create_private_temporary_file, open_private_regular_file, verify_private_directory,
    DurableRunnerError, EventPriority, PolledEvent,
};

const STATE_FILE: &str = "credential-observer-state.json";
const SCHEMA: &str = "paperclip.runner.credential-observer.v1";
const MAX_BYTES: u64 = 256 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const SCAN_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    identity: String,
    fingerprint: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    schema: String,
    session_id: String,
    provider: String,
    path: PathBuf,
    snapshot: Option<Snapshot>,
    revision: u64,
    armed: bool,
    pending: Option<PolledEvent>,
    /// Execution-host credential file that receives fresher refreshes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host_file: Option<PathBuf>,
    /// Write back only; the consumer did not opt in to update events.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    silent: bool,
}

pub(crate) struct CredentialObserver {
    state_path: PathBuf,
    session_id: String,
    state: Option<State>,
    loaded: bool,
    watcher: Option<RecommendedWatcher>,
    dirty: Arc<AtomicBool>,
    last_scan: Instant,
    /// Digest of the last refreshed credential settled against the host file.
    written: Option<String>,
    /// Digest whose write-back failure was already reported.
    reported: Option<String>,
}

impl CredentialObserver {
    pub(crate) fn new(state_dir: &Path, session_id: &str) -> Self {
        Self {
            state_path: state_dir.join(STATE_FILE),
            session_id: session_id.to_owned(),
            state: None,
            loaded: false,
            watcher: None,
            dirty: Arc::new(AtomicBool::new(true)),
            last_scan: Instant::now() - SCAN_INTERVAL,
            written: None,
            reported: None,
        }
    }

    pub(crate) fn restore(&mut self) -> Result<(), DurableRunnerError> {
        if self.loaded {
            return Ok(());
        }
        let file = match open_private_regular_file(&self.state_path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.loaded = true;
                return Ok(());
            }
            Err(_) => return Err(observer_error("state is unavailable")),
        };
        if file
            .metadata()
            .map_err(|_| observer_error("state is unavailable"))?
            .len()
            > MAX_BYTES
        {
            return Err(observer_error("state exceeds its bound"));
        }
        let state: State = serde_json::from_reader(file.take(MAX_BYTES + 1))
            .map_err(|_| observer_error("state is malformed"))?;
        let valid_digest =
            |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
        if state.schema != SCHEMA
            || state.session_id != self.session_id
            || !matches!(state.provider.as_str(), "codex" | "grok")
            || !state.path.is_absolute()
            || state
                .path
                .file_name()
                .is_none_or(|name| name != "auth.json")
            || state.revision > MAX_REVISION
            || state
                .snapshot
                .as_ref()
                .is_some_and(|s| !valid_digest(&s.identity) || !valid_digest(&s.fingerprint))
            || state.pending.as_ref().is_some_and(|event| {
                event != &update_event(&state.provider, state.revision)
                    || state.revision == 0
                    || state.silent
            })
            || state
                .host_file
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
            || (state.silent && state.host_file.is_none())
        {
            return Err(observer_error("state has an invalid session binding"));
        }
        self.state = Some(state);
        self.loaded = true;
        self.watch_directory();
        Ok(())
    }

    pub(crate) fn configure(&mut self, payload: &Value) -> Result<(), DurableRunnerError> {
        self.restore()?;
        if self.state.is_some() {
            return Ok(());
        }
        self.configure_with_host_file(payload, host_credential_file()?)
    }

    fn configure_with_host_file(
        &mut self,
        payload: &Value,
        host_file: Option<PathBuf>,
    ) -> Result<(), DurableRunnerError> {
        let observe = payload.get("observeCredentials") == Some(&Value::Bool(true));
        if !observe && host_file.is_none() {
            return Ok(());
        }
        let provider = &payload["provider"];
        let kind = provider
            .get("kind")
            .or_else(|| provider.get("provider"))
            .and_then(Value::as_str);
        let acpx_file_agent =
            kind == Some("acpx") && (provider["agent"] == "grok" || provider["agent"] == "codex");
        if host_file.is_some() && kind.is_some() && !acpx_file_agent {
            return Err(observer_error(
                "credential file requires a Codex or Grok ACPX session",
            ));
        }
        let (name, path, mut seed) = match kind {
            Some("codex") => {
                let Some(home) = std::env::var_os("CODEX_HOME") else {
                    return Ok(());
                };
                let home = PathBuf::from(home);
                if !home.is_absolute() {
                    return Err(observer_error("credential home is not absolute"));
                }
                let home = fs::canonicalize(home)
                    .map_err(|_| observer_error("credential home is unavailable"))?;
                ("codex", home.join("auth.json"), None)
            }
            Some("acpx") if provider["agent"] == "grok" || provider["agent"] == "codex" => {
                let Some(root) = provider["runtimeDirectory"].as_str() else {
                    return Ok(());
                };
                let Some(session) = provider["normalizedSessionId"].as_str() else {
                    return Ok(());
                };
                if session != self.session_id {
                    return Err(observer_error("descriptor session mismatch"));
                }
                let name = provider["agent"].as_str().expect("matched agent");
                crate::acpx_provider_backend::secure_directory(Path::new(root), "ACPX runtime")
                    .map_err(|_| observer_error("runtime home is unavailable"))?;
                let root = fs::canonicalize(root)
                    .map_err(|_| observer_error("runtime home is unavailable"))?;
                let path = root
                    .join("acpx")
                    .join(acpx_session_directory(session))
                    .join(format!("{name}-home"))
                    .join("auth.json");
                // The staged credential is the baseline, so a refresh during
                // provider startup is still detected and written back.
                let seed = if let Some(file) = host_file.as_deref() {
                    credential_write_back::read_host_credential(file)
                        .ok()
                        .map(|(bytes, _)| bytes)
                } else if name == "grok" {
                    std::env::var("PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET")
                        .ok()
                        .map(String::into_bytes)
                } else {
                    None
                };
                (name, path, seed)
            }
            _ => return Ok(()),
        };
        if !path.is_absolute() {
            return Err(observer_error("credential home is not absolute"));
        }
        let snapshot = seed
            .as_ref()
            .and_then(|bytes| parse_snapshot(name, bytes))
            .or_else(|| read_snapshot(name, &path));
        if let Some(bytes) = seed.as_mut() {
            bytes.fill(0);
        }
        let state = State {
            schema: SCHEMA.to_owned(),
            session_id: self.session_id.clone(),
            provider: name.to_owned(),
            path,
            snapshot,
            revision: 0,
            armed: false,
            pending: None,
            host_file,
            silent: !observe,
        };
        self.save(&state)?;
        self.state = Some(state);
        self.watch_directory();
        Ok(())
    }

    fn watch_directory(&mut self) {
        if self.watcher.is_some() {
            return;
        }
        let Some(parent) = self.state.as_ref().and_then(|s| s.path.parent()) else {
            return;
        };
        let dirty = Arc::clone(&self.dirty);
        if let Ok(mut watcher) = notify::recommended_watcher(move |_| {
            dirty.store(true, Ordering::Relaxed);
        }) {
            if watcher.watch(parent, RecursiveMode::NonRecursive).is_ok() {
                self.watcher = Some(watcher);
            }
        }
    }

    pub(crate) fn poll(&mut self, force: bool) -> Result<(), DurableRunnerError> {
        self.restore()?;
        // A pending event still allows write-back; only event detection waits
        // for its acknowledgement.
        if self.state.as_ref().is_none_or(|state| {
            !state.armed || (state.pending.is_some() && state.host_file.is_none())
        }) {
            return Ok(());
        }
        if !force
            && !self.dirty.swap(false, Ordering::Relaxed)
            && self.last_scan.elapsed() < SCAN_INTERVAL
        {
            return Ok(());
        }
        self.last_scan = Instant::now();
        self.watch_directory();
        let state = self.state.as_ref().expect("configured observer");
        let bytes = read_private_credential(&state.path).or_else(|| {
            fs::symlink_metadata(&state.path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                .then(|| read_private_credential(&state.path.with_file_name("auth-refresh.json")))
                .flatten()
        });
        let Some(mut bytes) = bytes else {
            return Ok(());
        };
        let snapshot = parse_snapshot(&state.provider, &bytes);
        let host_file = state.host_file.clone();
        let provider = state.provider.clone();
        if let Some(host_file) = host_file {
            self.write_back(&provider, &bytes, &host_file);
        }
        bytes.fill(0);
        let state = self.state.as_ref().expect("configured observer");
        let Some(snapshot) = snapshot.filter(|_| !state.silent && state.pending.is_none()) else {
            return Ok(());
        };
        if state.snapshot.as_ref() == Some(&snapshot) {
            return Ok(());
        }
        let mut next = state.clone();
        if next.snapshot.is_some() {
            next.revision = next
                .revision
                .checked_add(1)
                .filter(|n| *n <= MAX_REVISION)
                .ok_or_else(|| observer_error("revision exhausted"))?;
            next.pending = Some(update_event(&next.provider, next.revision));
        }
        next.snapshot = Some(snapshot);
        self.save(&next)?;
        self.state = Some(next);
        Ok(())
    }

    /// Settle one refreshed credential against the host file. Failures keep the
    /// run going: the host file is left unchanged, the failure is reported once
    /// per credential, and the next scan retries.
    fn write_back(&mut self, provider: &str, bytes: &[u8], host_file: &Path) {
        let digest = format!("{:x}", Sha256::digest(bytes));
        if self.written.as_deref() == Some(digest.as_str()) {
            return;
        }
        match credential_write_back::write_back(
            provider,
            bytes,
            host_file,
            credential_write_back::now_ms(),
        ) {
            Ok(WriteBack::Written | WriteBack::Kept) => {
                self.written = Some(digest);
                self.reported = None;
            }
            Ok(WriteBack::Raced) => self.dirty.store(true, Ordering::Relaxed),
            Err(error) => {
                if self.reported.as_deref() != Some(digest.as_str()) {
                    eprintln!(
                        "paperclip-runnerd: {provider} credential write-back to the host credential file failed ({:?}); retrying",
                        error.kind()
                    );
                    self.reported = Some(digest);
                }
            }
        }
    }

    pub(crate) fn pending(&self) -> Option<PolledEvent> {
        self.state.as_ref().and_then(|state| state.pending.clone())
    }

    pub(crate) fn activate(&mut self) -> Result<(), DurableRunnerError> {
        if let Some(state) = self.state.as_ref().filter(|state| !state.armed) {
            let mut next = state.clone();
            next.armed = true;
            self.save(&next)?;
            self.state = Some(next);
        }
        self.poll(true)
    }

    pub(crate) fn acknowledge(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        if count != 1 || self.pending().is_none() {
            return Err(observer_error("invalid event acknowledgement"));
        }
        let mut next = self.state.clone().expect("pending observer");
        next.pending = None;
        self.save(&next)?;
        self.state = Some(next);
        self.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn save(&self, state: &State) -> Result<(), DurableRunnerError> {
        let parent = self.state_path.parent().expect("state directory");
        verify_private_directory(parent)?;
        let (temporary, mut file) = create_private_temporary_file(&self.state_path)?;
        let result = (|| -> std::io::Result<()> {
            file.write_all(&serde_json::to_vec(state)?)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &self.state_path)?;
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result.map_err(|_| observer_error("state could not be persisted"))
    }
}

fn observer_error(message: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(format!("credential observer {message}"))
}

fn update_event(provider: &str, revision: u64) -> PolledEvent {
    PolledEvent {
        executor_event_id: format!("credential_update_{revision:016}"),
        event_type: "auth.credentials.updated".to_owned(),
        priority: EventPriority::P0,
        payload: json!({ "schema": "paperclip.auth.credentials.updated.v1", "provider": provider,
            "bindingId": "harness-auth", "revision": revision, "detection": "credential_store" }),
    }
}

fn acpx_session_directory(session: &str) -> String {
    let readable: String = session
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let readable = if readable.chars().all(|c| c == '.') {
        "session"
    } else {
        &readable
    };
    let readable: String = readable.chars().take(80).collect();
    let suffix = format!("{:x}", Sha256::digest(session.as_bytes()));
    format!(
        "{}-{}",
        if readable.is_empty() {
            "session"
        } else {
            &readable
        },
        &suffix[..16]
    )
}

fn parse_snapshot(provider: &str, bytes: &[u8]) -> Option<Snapshot> {
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let nonempty = |v: &Value| {
        v.as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
    };
    let (identity, credentials) = match provider {
        "codex" => {
            let tokens = &value["tokens"];
            let account = nonempty(&tokens["account_id"])?;
            let access = nonempty(&tokens["access_token"])?;
            let refresh = nonempty(&tokens["refresh_token"])?;
            (account, json!([access, refresh, tokens.get("id_token")]))
        }
        "grok" => {
            let object = value.as_object()?;
            if object.len() != 1 {
                return None;
            }
            let (identity, auth) = object.iter().next()?;
            let (issuer, account) = identity.rsplit_once("::")?;
            if issuer.is_empty() || uuid::Uuid::parse_str(account).is_err() {
                return None;
            }
            (
                identity.clone(),
                json!([nonempty(&auth["key"])?, nonempty(&auth["refresh_token"])?]),
            )
        }
        _ => return None,
    };
    let mut fingerprint = Sha256::new();
    fingerprint.update(provider.as_bytes());
    fingerprint.update(serde_json::to_vec(&credentials).ok()?);
    Some(Snapshot {
        identity: format!("{:x}", Sha256::digest(identity.as_bytes())),
        fingerprint: format!("{:x}", fingerprint.finalize()),
    })
}

fn read_snapshot(provider: &str, path: &Path) -> Option<Snapshot> {
    let mut bytes = read_private_credential(path)?;
    let snapshot = parse_snapshot(provider, &bytes);
    bytes.fill(0);
    snapshot
}

/// The execution host's credential file, when it supplied one.
fn host_credential_file() -> Result<Option<PathBuf>, DurableRunnerError> {
    parse_host_credential_file(std::env::var_os(ACPX_AUTH_JSON_FILE_ENV))
}

fn parse_host_credential_file(
    value: Option<std::ffi::OsString>,
) -> Result<Option<PathBuf>, DurableRunnerError> {
    let Some(path) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(observer_error("credential file is not absolute"));
    }
    Ok(Some(path))
}

#[cfg(unix)]
fn read_private_credential(path: &Path) -> Option<Vec<u8>> {
    use rustix::fs::{open, openat, Mode, OFlags};
    use std::os::unix::fs::MetadataExt;
    let parent = path.parent()?;
    if !parent.is_absolute() {
        return None;
    }
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut directory = open("/", flags, Mode::empty()).ok()?;
    for component in parent.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                directory = openat(&directory, name, flags, Mode::empty()).ok()?;
            }
            _ => return None,
        }
    }
    let owner = File::from(directory.try_clone().ok()?)
        .metadata()
        .ok()?
        .uid();
    let fd = openat(
        &directory,
        path.file_name()?,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    let mut file = File::from(fd);
    let before = file.metadata().ok()?;
    if !before.is_file()
        || before.uid() != owner
        || before.mode() & 0o777 != 0o600
        || before.len() > MAX_BYTES
    {
        return None;
    }
    let mut bytes = Vec::new();
    let read = (&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes);
    let after = file.metadata().ok();
    let stable = after.is_some_and(|after| {
        before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
    });
    if read.is_ok() && stable {
        Some(bytes)
    } else {
        bytes.fill(0);
        None
    }
}

#[cfg(not(unix))]
fn read_private_credential(_path: &Path) -> Option<Vec<u8>> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    struct Fixture {
        root: PathBuf,
        observer: CredentialObserver,
    }
    impl Fixture {
        fn new(provider: &str, seed: &Value) -> Self {
            let root =
                std::env::temp_dir().join(format!("credential-observer-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let mut observer = CredentialObserver::new(&root, "session");
            observer.loaded = true;
            observer.state = Some(State {
                schema: SCHEMA.to_owned(),
                session_id: "session".to_owned(),
                provider: provider.to_owned(),
                path: root.join("auth.json"),
                snapshot: parse_snapshot(provider, &serde_json::to_vec(seed).unwrap()),
                revision: 0,
                armed: false,
                pending: None,
                host_file: None,
                silent: false,
            });
            observer.save(observer.state.as_ref().unwrap()).unwrap();
            Self { root, observer }
        }
        fn write(&self, name: &str, value: &Value) {
            let path = self.root.join(name);
            fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.observer.watcher = None;
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn codex(marker: &str) -> Value {
        json!({"tokens":{"account_id":"account-1", "access_token":format!("access-{marker}"),
            "refresh_token":format!("refresh-{marker}"), "id_token":format!("identity-{marker}")}, "last_refresh":"metadata"})
    }
    fn grok(marker: &str) -> Value {
        json!({"https://issuer.example::12345678-1234-1234-1234-123456789abc":{
            "key":format!("access-{marker}"), "refresh_token":format!("refresh-{marker}"), "expires_at":1234}})
    }

    #[test]
    fn refresh_is_durable_replayable_content_free_and_monotonic() {
        let mut f = Fixture::new("codex", &codex("before"));
        f.write("auth.json", &codex("before"));
        f.observer.activate().unwrap();
        assert!(f.observer.pending().is_none());
        f.write("auth.json", &codex("after"));
        f.observer.poll(true).unwrap();
        let event = f.observer.pending().unwrap();
        assert_eq!(event, update_event("codex", 1));
        let persisted = fs::read_to_string(f.root.join(STATE_FILE)).unwrap();
        for secret in [
            "access-before",
            "refresh-before",
            "identity-before",
            "access-after",
            "refresh-after",
            "identity-after",
        ] {
            assert!(!persisted.contains(secret));
            assert!(!event.payload.to_string().contains(secret));
        }
        let mut recovered = CredentialObserver::new(&f.root, "session");
        recovered.restore().unwrap();
        assert_eq!(recovered.pending(), Some(event));
        f.write("auth.json", &codex("newest"));
        recovered.poll(true).unwrap();
        assert_eq!(recovered.pending(), Some(update_event("codex", 1)));
        recovered.acknowledge(1).unwrap();
        recovered.poll(true).unwrap();
        assert_eq!(recovered.pending(), Some(update_event("codex", 2)));
        recovered.acknowledge(1).unwrap();
        recovered.poll(true).unwrap();
        assert!(recovered.pending().is_none());
        assert_eq!(recovered.state.as_ref().unwrap().revision, 2);
    }

    #[test]
    fn directory_watch_handles_atomic_replacement() {
        let mut f = Fixture::new("codex", &codex("before"));
        f.write("auth.json", &codex("before"));
        f.observer.activate().unwrap();
        f.observer.dirty.store(false, Ordering::Relaxed);
        f.write("auth.tmp", &codex("after"));
        fs::rename(f.root.join("auth.tmp"), f.root.join("auth.json")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while f.observer.pending().is_none() && Instant::now() < deadline {
            f.observer.poll(false).unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
    }

    #[test]
    fn periodic_reread_works_without_native_notifications() {
        let mut f = Fixture::new("codex", &codex("before"));
        f.write("auth.json", &codex("before"));
        f.observer.activate().unwrap();
        f.write("auth.json", &codex("after"));
        f.observer.watcher = None;
        f.observer.dirty.store(false, Ordering::Relaxed);
        f.observer.last_scan = Instant::now() - SCAN_INTERVAL;
        f.observer.poll(false).unwrap();
        assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
    }

    #[test]
    fn ignores_metadata_partial_writes_and_deletion() {
        let mut f = Fixture::new("codex", &codex("before"));
        f.write("auth.json", &codex("before"));
        f.observer.activate().unwrap();
        let mut metadata = codex("before");
        metadata["last_refresh"] = json!("new metadata");
        f.write("auth.json", &metadata);
        f.observer.poll(true).unwrap();
        assert!(f.observer.pending().is_none());
        fs::write(f.root.join("auth.json"), "{partial").unwrap();
        f.observer.poll(true).unwrap();
        assert!(f.observer.pending().is_none());
        fs::remove_file(f.root.join("auth.json")).unwrap();
        f.observer.poll(true).unwrap();
        f.write("auth.json", &codex("after"));
        f.observer.poll(true).unwrap();
        assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
    }

    #[test]
    fn account_changes_and_later_refreshes_survive_recovery_without_exposing_identity() {
        for provider in ["codex", "grok"] {
            let original = if provider == "codex" {
                codex("before")
            } else {
                grok("before")
            };
            let mut f = Fixture::new(provider, &original);
            f.write("auth.json", &original);
            f.observer.activate().unwrap();
            let mut changed = original.clone();
            let account = if provider == "codex" {
                changed["tokens"]["account_id"] = json!("different-account");
                "different-account"
            } else {
                let auth = changed
                    .as_object()
                    .unwrap()
                    .values()
                    .next()
                    .unwrap()
                    .clone();
                changed =
                    json!({"https://issuer.example::87654321-4321-4321-4321-cba987654321": auth});
                "87654321-4321-4321-4321-cba987654321"
            };
            f.write("auth.json", &changed);
            f.observer.poll(true).unwrap();
            assert_eq!(f.observer.pending(), Some(update_event(provider, 1)));
            let persisted = fs::read_to_string(f.root.join(STATE_FILE)).unwrap();
            assert!(!persisted.contains(account));
            assert!(!f
                .observer
                .pending()
                .unwrap()
                .payload
                .to_string()
                .contains(account));
            let mut recovered = CredentialObserver::new(&f.root, "session");
            recovered.restore().unwrap();
            assert_eq!(recovered.pending(), Some(update_event(provider, 1)));
            if provider == "codex" {
                changed["tokens"]["access_token"] = json!("refreshed-access");
            } else {
                changed
                    .as_object_mut()
                    .unwrap()
                    .values_mut()
                    .next()
                    .unwrap()["key"] = json!("refreshed-access");
            }
            f.write("auth.json", &changed);
            recovered.poll(true).unwrap();
            assert_eq!(recovered.pending(), Some(update_event(provider, 1)));
            recovered.acknowledge(1).unwrap();
            recovered.poll(true).unwrap();
            assert_eq!(recovered.pending(), Some(update_event(provider, 2)));
            recovered.acknowledge(1).unwrap();
            recovered.poll(true).unwrap();
            assert!(recovered.pending().is_none());
            f.write("auth.json", &original);
            recovered.poll(true).unwrap();
            assert_eq!(recovered.pending(), Some(update_event(provider, 3)));
        }
    }

    #[test]
    fn grok_seed_catches_pre_start_refresh_and_close_handoff() {
        let mut f = Fixture::new("grok", &grok("seed"));
        f.observer.poll(true).unwrap();
        assert!(f.observer.pending().is_none());
        f.write("auth.json", &grok("startup"));
        f.observer.activate().unwrap();
        assert_eq!(f.observer.pending(), Some(update_event("grok", 1)));
        f.observer.acknowledge(1).unwrap();
        f.write("auth-refresh.json", &grok("close"));
        fs::remove_file(f.root.join("auth.json")).unwrap();
        f.observer.poll(true).unwrap();
        assert_eq!(f.observer.pending(), Some(update_event("grok", 2)));
    }

    #[test]
    fn codex_close_handoff_preserves_shutdown_refresh() {
        let mut f = Fixture::new("codex", &codex("seed"));
        f.write("auth.json", &codex("seed"));
        f.observer.activate().unwrap();
        assert!(f.observer.pending().is_none());
        f.write("auth-refresh.json", &codex("close"));
        fs::remove_file(f.root.join("auth.json")).unwrap();
        f.observer.poll(true).unwrap();
        assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
        f.observer.acknowledge(1).unwrap();
        f.observer.poll(true).unwrap();
        assert!(f.observer.pending().is_none());
    }

    #[test]
    fn rejects_symlinks_unsafe_permissions_and_oversized_stores() {
        let f = Fixture::new("codex", &codex("seed"));
        f.write("auth.json", &codex("seed"));
        symlink(f.root.join("auth.json"), f.root.join("symlink.json")).unwrap();
        assert!(read_snapshot("codex", &f.root.join("symlink.json")).is_none());
        symlink(&f.root, f.root.join("parent-link")).unwrap();
        assert!(read_snapshot("codex", &f.root.join("parent-link/auth.json")).is_none());
        fs::set_permissions(f.root.join("auth.json"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_snapshot("codex", &f.root.join("auth.json")).is_none());
        fs::set_permissions(f.root.join("auth.json"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(f.root.join("auth.json"), vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert!(read_snapshot("codex", &f.root.join("auth.json")).is_none());
    }

    #[test]
    fn observer_requires_opt_in_and_rejects_cross_session_recovery() {
        let f = Fixture::new("codex", &codex("seed"));
        let mut wrong_session = CredentialObserver::new(&f.root, "different-session");
        assert!(wrong_session.restore().is_err());
        let path = f.root.join("unused");
        fs::create_dir(&path).unwrap();
        let mut disabled = CredentialObserver::new(&path, "session");
        disabled
            .configure(&json!({"provider":{"kind":"codex"}}))
            .unwrap();
        assert!(disabled.state.is_none());
        disabled
            .configure(&json!({"observeCredentials":true,"provider":{"kind":"opencode"}}))
            .unwrap();
        assert!(disabled.state.is_none());
    }

    #[test]
    fn fresh_acpx_observers_create_a_private_runtime_directory() {
        let f = Fixture::new("codex", &codex("seed"));
        for provider in ["codex", "grok"] {
            let state_dir = f.root.join(provider);
            fs::create_dir(&state_dir).unwrap();
            fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700)).unwrap();
            let runtime = state_dir.join("runtime");
            assert!(!runtime.exists());
            let mut observer = CredentialObserver::new(&state_dir, "session");
            observer.configure(&json!({"observeCredentials":true,"provider":{
                "kind":"acpx", "agent":provider, "runtimeDirectory":runtime, "normalizedSessionId":"session"
            }})).unwrap();
            assert_eq!(
                fs::metadata(&runtime).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(observer.state.as_ref().unwrap().provider, provider);
            assert!(observer.pending().is_none());
            observer.activate().unwrap();
            assert!(observer.pending().is_none());
        }
    }

    fn codex_at(marker: &str, last_refresh: &str) -> Value {
        let mut value = codex(marker);
        value["last_refresh"] = json!(last_refresh);
        value
    }

    fn with_host_file(f: &mut Fixture, silent: bool) -> PathBuf {
        let host = f.root.join("host").join("auth.json");
        fs::create_dir(host.parent().unwrap()).unwrap();
        let state = f.observer.state.as_mut().unwrap();
        state.host_file = Some(host.clone());
        state.silent = silent;
        let state = state.clone();
        f.observer.save(&state).unwrap();
        host
    }

    #[test]
    fn host_file_receives_a_newer_refresh_during_the_session_before_the_event() {
        let seed = codex_at("seed", "2026-01-01T00:00:00Z");
        let mut f = Fixture::new("codex", &seed);
        let host = with_host_file(&mut f, false);
        f.write("host/auth.json", &seed);
        f.write("auth.json", &seed);
        f.observer.activate().unwrap();
        assert!(f.observer.pending().is_none());
        assert_eq!(fs::read(&host).unwrap(), serde_json::to_vec(&seed).unwrap());

        let refreshed = codex_at("refreshed", "2026-02-01T00:00:00Z");
        f.write("auth.json", &refreshed);
        f.observer.poll(true).unwrap();
        assert_eq!(
            fs::read(&host).unwrap(),
            serde_json::to_vec(&refreshed).unwrap()
        );
        assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
        let persisted = fs::read_to_string(f.root.join(STATE_FILE)).unwrap();
        assert!(!persisted.contains("access-refreshed"));

        // A later refresh is written back while the event awaits acknowledgement.
        let later = codex_at("later", "2026-03-01T00:00:00Z");
        f.write("auth.json", &later);
        f.observer.poll(true).unwrap();
        assert_eq!(
            fs::read(&host).unwrap(),
            serde_json::to_vec(&later).unwrap()
        );
        assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
        f.observer.acknowledge(1).unwrap();
        f.observer.poll(true).unwrap();
        assert_eq!(f.observer.pending(), Some(update_event("codex", 2)));

        // Recovery keeps the host file binding.
        let mut recovered = CredentialObserver::new(&f.root, "session");
        recovered.restore().unwrap();
        assert_eq!(recovered.state.as_ref().unwrap().host_file, Some(host));
    }

    #[test]
    fn host_file_keeps_a_newer_or_different_account_credential() {
        let mut f = Fixture::new("grok", &grok("seed"));
        let host = with_host_file(&mut f, false);
        let mut newer = grok("host-newer");
        newer.as_object_mut().unwrap().values_mut().next().unwrap()["expires_at"] = json!(9999);
        f.write("host/auth.json", &newer);
        f.write("auth.json", &grok("seed"));
        f.observer.activate().unwrap();
        let mut refreshed = grok("refreshed");
        refreshed
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap()["expires_at"] = json!(5000);
        f.write("auth.json", &refreshed);
        f.observer.poll(true).unwrap();
        assert_eq!(
            fs::read(&host).unwrap(),
            serde_json::to_vec(&newer).unwrap()
        );
        // The provider still refreshed, so the opted-in consumer is told.
        assert_eq!(f.observer.pending(), Some(update_event("grok", 1)));
        f.observer.acknowledge(1).unwrap();

        let other = json!({"https://issuer.example::87654321-4321-4321-4321-cba987654321":
            {"key":"access-other", "refresh_token":"refresh-other", "expires_at": 99999}});
        f.write("auth.json", &other);
        f.observer.poll(true).unwrap();
        assert_eq!(
            fs::read(&host).unwrap(),
            serde_json::to_vec(&newer).unwrap()
        );
    }

    #[test]
    fn silent_host_file_binding_writes_back_without_events() {
        let mut f = Fixture::new("grok", &grok("seed"));
        let host = with_host_file(&mut f, true);
        f.write("host/auth.json", &grok("seed"));
        f.write("auth.json", &grok("seed"));
        f.observer.activate().unwrap();
        let mut refreshed = grok("refreshed");
        refreshed
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap()["expires_at"] = json!(5000);
        f.write("auth.json", &refreshed);
        f.observer.poll(true).unwrap();
        assert_eq!(
            fs::read(&host).unwrap(),
            serde_json::to_vec(&refreshed).unwrap()
        );
        assert!(f.observer.pending().is_none());

        // The close handoff is written back too.
        let mut closed = grok("closed");
        closed.as_object_mut().unwrap().values_mut().next().unwrap()["expires_at"] = json!(6000);
        f.write("auth-refresh.json", &closed);
        fs::remove_file(f.root.join("auth.json")).unwrap();
        f.observer.poll(true).unwrap();
        assert_eq!(
            fs::read(&host).unwrap(),
            serde_json::to_vec(&closed).unwrap()
        );
        assert!(f.observer.pending().is_none());
    }

    #[test]
    fn host_file_write_back_failure_keeps_the_session_running_and_retries() {
        let seed = codex_at("seed", "2026-01-01T00:00:00Z");
        let mut f = Fixture::new("codex", &seed);
        let host = with_host_file(&mut f, true);
        f.write("auth.json", &seed);
        f.observer.activate().unwrap();
        let refreshed = codex_at("refreshed", "2026-02-01T00:00:00Z");
        f.write("auth.json", &refreshed);
        // The host file is missing: nothing is created and the poll succeeds.
        f.observer.poll(true).unwrap();
        assert!(!host.exists());
        f.write("host/auth.json", &seed);
        f.observer.poll(true).unwrap();
        assert_eq!(
            fs::read(&host).unwrap(),
            serde_json::to_vec(&refreshed).unwrap()
        );
    }

    #[test]
    fn host_file_configuration_requires_an_absolute_path_and_a_file_credential_agent() {
        assert!(parse_host_credential_file(Some("relative/auth.json".into())).is_err());
        assert_eq!(parse_host_credential_file(Some("".into())).unwrap(), None);
        assert_eq!(parse_host_credential_file(None).unwrap(), None);

        let f = Fixture::new("codex", &codex("seed"));
        let host = f.root.join("host-auth.json");
        for provider in [
            json!({"kind":"codex"}),
            json!({"kind":"acpx", "agent":"claude", "runtimeDirectory":f.root, "normalizedSessionId":"session"}),
            json!({"kind":"opencode"}),
        ] {
            let state_dir = f.root.join(format!("state-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&state_dir).unwrap();
            let mut observer = CredentialObserver::new(&state_dir, "session");
            observer.loaded = true;
            let error = observer
                .configure_with_host_file(&json!({"provider":provider}), Some(host.clone()))
                .unwrap_err();
            assert!(error.to_string().contains("Codex or Grok ACPX"), "{error}");
            assert!(observer.state.is_none());
        }
    }

    #[test]
    fn host_file_binding_does_not_require_the_event_opt_in() {
        let f = Fixture::new("codex", &codex("seed"));
        for (agent, credential) in [
            ("codex", codex_at("seed", "2026-01-01T00:00:00Z")),
            ("grok", grok("seed")),
        ] {
            let state_dir = f.root.join(agent);
            fs::create_dir(&state_dir).unwrap();
            fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700)).unwrap();
            let host = state_dir.join("host-auth.json");
            fs::write(&host, serde_json::to_vec(&credential).unwrap()).unwrap();
            fs::set_permissions(&host, fs::Permissions::from_mode(0o600)).unwrap();
            let mut observer = CredentialObserver::new(&state_dir, "session");
            observer
                .configure_with_host_file(
                    &json!({"provider":{"kind":"acpx", "agent":agent,
                        "runtimeDirectory":state_dir.join("runtime"), "normalizedSessionId":"session"}}),
                    Some(host.clone()),
                )
                .unwrap();
            let state = observer.state.as_ref().unwrap();
            assert!(state.silent);
            assert_eq!(state.host_file, Some(host));
            assert_eq!(
                state.snapshot,
                parse_snapshot(agent, &serde_json::to_vec(&credential).unwrap())
            );
            let mut recovered = CredentialObserver::new(&state_dir, "session");
            recovered.restore().unwrap();
            assert!(recovered.state.as_ref().unwrap().silent);
        }
    }

    #[test]
    fn acpx_directory_matches_the_typescript_session_layout() {
        assert_eq!(
            acpx_session_directory("session-1"),
            "session-1-84097828fc31a8c8"
        );
        let session = "...";
        assert!(acpx_session_directory(session).starts_with("session-"));
    }
}
