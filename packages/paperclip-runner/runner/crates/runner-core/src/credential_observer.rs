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
/// Decisions per write-back while other writers keep replacing the host file.
const WRITE_BACK_ATTEMPTS: usize = 3;

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
    /// Write back only; the consumer did not opt in to update events. Inactive
    /// when a recovered Runner no longer names a credential file.
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
    /// Digest of the last refreshed credential settled against the host file,
    /// with the host file stamp that decision depends on, if any.
    written: Option<(String, Option<credential_write_back::HostStamp>)>,
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
        }
    }

    pub(crate) fn restore(&mut self) -> Result<(), DurableRunnerError> {
        self.restore_with_host_file(host_credential_file)
    }

    /// `host_file` reads the current Runner's binding; it runs only when saved
    /// state is loaded, so the binding is reconciled once per process.
    fn restore_with_host_file(
        &mut self,
        host_file: impl FnOnce() -> Result<Option<PathBuf>, DurableRunnerError>,
    ) -> Result<(), DurableRunnerError> {
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
        {
            return Err(observer_error("state has an invalid session binding"));
        }
        self.state = Some(state);
        self.reconcile_host_file(host_file()?)?;
        self.loaded = true;
        self.watch_directory();
        Ok(())
    }

    /// Follow the credential file named by the current Runner process.
    ///
    /// The sidecar seeds the isolated home from the file this process was
    /// given, so write-back must target that same file. A recovered session
    /// adopts a newly supplied file, switches to a changed one, and stops
    /// writing back when the host no longer names one. Revision, baseline and
    /// any pending event are unchanged; freshness rules still guard the write.
    fn reconcile_host_file(
        &mut self,
        host_file: Option<PathBuf>,
    ) -> Result<(), DurableRunnerError> {
        let Some(state) = self.state.as_ref() else {
            return Ok(());
        };
        if state.host_file == host_file {
            return Ok(());
        }
        if host_file.is_some() && !is_acpx_credential_path(&state.provider, &state.path) {
            return Err(observer_error(
                "credential file requires a Codex or Grok ACPX session",
            ));
        }
        let mut next = state.clone();
        next.host_file = host_file;
        self.save(&next)?;
        self.state = Some(next);
        self.written = None;
        self.dirty.store(true, Ordering::Relaxed);
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
            !state.armed || (state.host_file.is_none() && (state.pending.is_some() || state.silent))
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
        let written = host_file.map_or(Ok(()), |host_file| {
            self.write_back(&provider, &bytes, &host_file)
        });
        bytes.fill(0);
        written?;
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

    /// Settle one refreshed credential against the host file. A host file that
    /// changes during the replacement is read and decided again at once. A
    /// failure is returned, so the command or turn that observed it fails: a
    /// rotated refresh token that cannot reach the host file must not be lost
    /// quietly.
    fn write_back(
        &mut self,
        provider: &str,
        bytes: &[u8],
        host_file: &Path,
    ) -> Result<(), DurableRunnerError> {
        let digest = format!("{:x}", Sha256::digest(bytes));
        // A kept decision holds only while the host file is unchanged, so a
        // repaired or replaced host file is compared again.
        if self.written.as_ref().is_some_and(|(written, stamp)| {
            *written == digest
                && stamp.as_ref().is_none_or(|stamp| {
                    credential_write_back::host_stamp(host_file).as_ref() == Some(stamp)
                })
        }) {
            return Ok(());
        }
        for _ in 0..WRITE_BACK_ATTEMPTS {
            match credential_write_back::write_back(
                provider,
                bytes,
                host_file,
                credential_write_back::now_ms(),
            ) {
                Ok(WriteBack::Kept(stamp)) => {
                    self.written = Some((digest, stamp));
                    return Ok(());
                }
                // The next scan reads the replaced host file and settles a
                // tie, recording the stamp of the file actually in place.
                Ok(WriteBack::Written) => {
                    self.written = None;
                    return Ok(());
                }
                Ok(WriteBack::Raced) => {}
                Err(error) => {
                    return Err(observer_error(&format!(
                        "{provider} write-back to the host credential file failed ({:?})",
                        error.kind()
                    )))
                }
            }
        }
        Err(observer_error(&format!(
            "{provider} write-back to the host credential file failed: the file kept changing"
        )))
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

/// `<runtime>/acpx/<session>/<provider>-home/auth.json`, as `configure` builds it.
fn is_acpx_credential_path(provider: &str, path: &Path) -> bool {
    let home = path.parent();
    home.and_then(Path::file_name)
        .is_some_and(|name| name == format!("{provider}-home").as_str())
        && home
            .and_then(Path::parent)
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .is_some_and(|name| name == "acpx")
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
#[path = "tests/credential_observer.rs"]
mod tests;
