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
}

pub(crate) struct CredentialObserver {
    state_path: PathBuf,
    session_id: String,
    state: Option<State>,
    loaded: bool,
    watcher: Option<RecommendedWatcher>,
    dirty: Arc<AtomicBool>,
    last_scan: Instant,
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
                event != &update_event(&state.provider, state.revision) || state.revision == 0
            })
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
        if self.state.is_some() || payload.get("observeCredentials") != Some(&Value::Bool(true)) {
            return Ok(());
        }
        let provider = &payload["provider"];
        let kind = provider
            .get("kind")
            .or_else(|| provider.get("provider"))
            .and_then(Value::as_str);
        let (name, path, seed) = match kind {
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
                let seed = if name == "grok" {
                    std::env::var("PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET").ok()
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
        let mut seed = seed.map(String::into_bytes);
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
        if self
            .state
            .as_ref()
            .is_none_or(|state| !state.armed || state.pending.is_some())
        {
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
        let snapshot = read_snapshot(&state.provider, &state.path).or_else(|| {
            (state.provider == "grok"
                && fs::symlink_metadata(&state.path)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound))
            .then(|| read_snapshot("grok", &state.path.with_file_name("auth-refresh.json")))
            .flatten()
        });
        let Some(snapshot) = snapshot else {
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

#[cfg(unix)]
fn read_snapshot(provider: &str, path: &Path) -> Option<Snapshot> {
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
    let snapshot = if read.is_ok() && stable {
        parse_snapshot(provider, &bytes)
    } else {
        None
    };
    bytes.fill(0);
    snapshot
}

#[cfg(not(unix))]
fn read_snapshot(_provider: &str, _path: &Path) -> Option<Snapshot> {
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
