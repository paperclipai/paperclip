use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::process_supervisor::SupervisedProcess;

const STATE_SCHEMA: &str = "paperclip.runner.durable.state.v1";
const PROTOCOL: &str = "paperclip.runner";
const PROTOCOL_VERSION: u64 = 1;
const SECURE_FRAME_SCHEMA: &str = "paperclip.runner.secure-frame.v1";
const STATIC_WEBSOCKET_KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const STATIC_WEBSOCKET_ACCEPT: &str = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const MAX_DIAGNOSTICS: usize = 32;
const MAX_RECENT_PROCESSED_COMMANDS: usize = 128;
const COMPACTED_COMMAND_FILTER_BYTES: usize = 4096;
const COMPACTED_COMMAND_FILTER_HASHES: usize = 7;
const REVOKE_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
const TEMP_FILE_ATTEMPTS: usize = 16;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableRunnerError(String);

impl DurableRunnerError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for DurableRunnerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for DurableRunnerError {}

struct SensitiveString(Vec<u8>);

impl SensitiveString {
    fn new(value: String) -> Self {
        Self(value.into_bytes())
    }

    fn expose(&self) -> &str {
        std::str::from_utf8(&self.0).expect("sensitive value started as valid UTF-8")
    }

    fn clear(&mut self) {
        self.0.fill(0);
        self.0.clear();
    }
}

impl Drop for SensitiveString {
    fn drop(&mut self) {
        self.clear();
    }
}

pub struct BootstrapTicket(SensitiveString);

impl BootstrapTicket {
    fn expose(&self) -> &str {
        self.0.expose()
    }
}

pub fn capture_bootstrap_ticket() -> Result<Option<BootstrapTicket>, DurableRunnerError> {
    let value = std::env::var_os("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET");
    std::env::remove_var("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET");
    value
        .map(|value| {
            value
                .into_string()
                .map(|value| BootstrapTicket(SensitiveString::new(value)))
                .map_err(|_| DurableRunnerError::invalid("runner bootstrap ticket is not valid UTF-8"))
        })
        .transpose()
}

#[derive(Clone, Debug)]
pub struct DurableRunnerConfig {
    pub connect_url: String,
    pub state_dir: PathBuf,
    pub runner_instance_id: String,
    pub environment_lease_id: String,
    pub run_id: String,
    pub normalized_session_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub runner_version: String,
    pub runner_digest: String,
    pub fake_harness_path: Option<PathBuf>,
    pub fake_harness_script_path: Option<PathBuf>,
    pub max_outbox_bytes: usize,
    pub p0_reserve_bytes: usize,
    pub max_frame_bytes: usize,
    pub reconnect_delay: Duration,
    pub max_runtime: Duration,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredOutboxEvent {
    pub source_seq: u64,
    pub source_event_id: String,
    pub priority: u8,
    pub event_type: String,
    pub item_id: Option<String>,
    pub envelope: Value,
    pub byte_size: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedCommand {
    pub command_id: String,
    pub controller_seq: u64,
    pub command_digest: String,
    pub status: String,
    pub logical_effect_count: u64,
    pub result: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableRunnerState {
    pub schema: String,
    pub runner_instance_id: String,
    pub environment_lease_id: String,
    pub run_id: String,
    pub normalized_session_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub lifecycle: String,
    pub next_source_seq: u64,
    pub acked_source_seq: u64,
    pub last_controller_command_seq: u64,
    pub reconnect_count: u64,
    pub max_outbox_bytes: usize,
    pub peak_outbox_bytes: usize,
    pub outbox: Vec<StoredOutboxEvent>,
    pub processed_commands: BTreeMap<String, ProcessedCommand>,
    #[serde(default = "empty_compacted_command_filter")]
    pub compacted_command_filter: String,
    #[serde(default)]
    pub compacted_command_count: u64,
    pub diagnostics: Vec<String>,
    pub backpressure: bool,
    pub recoverable_failure: Option<String>,
    pub unrecoverable_outcome: Option<String>,
    pub harness_generation: u64,
    pub stop_after_flush: bool,
}

impl DurableRunnerState {
    fn new(config: &DurableRunnerConfig) -> Self {
        Self {
            schema: STATE_SCHEMA.to_owned(),
            runner_instance_id: config.runner_instance_id.clone(),
            environment_lease_id: config.environment_lease_id.clone(),
            run_id: config.run_id.clone(),
            normalized_session_id: config.normalized_session_id.clone(),
            turn_id: config.turn_id.clone(),
            item_id: config.item_id.clone(),
            lifecycle: "connecting".to_owned(),
            next_source_seq: 1,
            acked_source_seq: 0,
            last_controller_command_seq: 0,
            reconnect_count: 0,
            max_outbox_bytes: config.max_outbox_bytes,
            peak_outbox_bytes: 0,
            outbox: Vec::new(),
            processed_commands: BTreeMap::new(),
            compacted_command_filter: empty_compacted_command_filter(),
            compacted_command_count: 0,
            diagnostics: Vec::new(),
            backpressure: false,
            recoverable_failure: None,
            unrecoverable_outcome: None,
            harness_generation: 1,
            stop_after_flush: false,
        }
    }

    pub fn outbox_bytes(&self) -> usize {
        self.outbox.iter().map(|event| event.byte_size).sum()
    }

    pub fn highest_source_seq(&self) -> u64 {
        self.next_source_seq.saturating_sub(1)
    }

    pub fn apply_ack(&mut self, acked_source_seq: u64) -> Result<(), DurableRunnerError> {
        if acked_source_seq < self.acked_source_seq {
            return Err(DurableRunnerError::invalid(
                "cumulative ACK cannot move behind the durable cursor",
            ));
        }
        if acked_source_seq > self.highest_source_seq() {
            return Err(DurableRunnerError::invalid(
                "cumulative ACK cannot move beyond the produced source cursor",
            ));
        }
        self.acked_source_seq = acked_source_seq;
        self.outbox
            .retain(|event| event.source_seq > acked_source_seq);
        Ok(())
    }

    fn record_diagnostic(&mut self, message: impl Into<String>) {
        self.diagnostics.push(redact_text(&message.into()));
        if self.diagnostics.len() > MAX_DIAGNOSTICS {
            self.diagnostics.remove(0);
        }
    }
}

#[derive(Clone, Debug)]
pub struct DurableStateStore {
    path: PathBuf,
}

impl DurableStateStore {
    pub fn new(state_dir: &Path) -> Result<Self, DurableRunnerError> {
        if let Ok(metadata) = fs::symlink_metadata(state_dir) {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                return Err(DurableRunnerError::invalid(format!(
                    "runner state directory {} must be a real directory",
                    state_dir.display()
                )));
            }
        }
        fs::create_dir_all(state_dir).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to create runner state directory {}: {error}",
                state_dir.display()
            ))
        })?;
        #[cfg(unix)]
        fs::set_permissions(state_dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to secure runner state directory {}: {error}",
                state_dir.display()
            ))
        })?;
        verify_private_directory(state_dir)?;
        Ok(Self {
            path: state_dir.join("runner-state.json"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load_or_create(
        &self,
        config: &DurableRunnerConfig,
    ) -> Result<(DurableRunnerState, bool), DurableRunnerError> {
        let bytes = match open_private_regular_file(&self.path) {
            Ok(mut file) => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to read durable runner state {}: {error}",
                        self.path.display()
                    ))
                })?;
                bytes
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let state = DurableRunnerState::new(config);
                self.save(&state)?;
                return Ok((state, false));
            }
            Err(error) => {
                return Err(DurableRunnerError::invalid(format!(
                    "failed to open private durable runner state {}: {error}",
                    self.path.display()
                )))
            }
        };
        let mut state: DurableRunnerState = serde_json::from_slice(&bytes).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "durable runner state is malformed and cannot be recovered: {error}"
            ))
        })?;
        validate_state_binding(&state, config)?;
        let previous_command_count = state.processed_commands.len();
        compact_processed_commands(&mut state)?;
        if state.processed_commands.len() != previous_command_count {
            self.save(&state)?;
        }
        Ok((state, true))
    }

    pub fn save(&self, state: &DurableRunnerState) -> Result<(), DurableRunnerError> {
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to serialize durable runner state: {error}"))
        })?;
        let (temporary, mut file) = create_private_temporary_file(&self.path)?;
        let result = (|| -> Result<(), DurableRunnerError> {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("failed to commit durable runner state: {error}"))
                })?;
            drop(file);
            fs::rename(&temporary, &self.path).map_err(|error| {
                DurableRunnerError::invalid(format!("failed to replace durable runner state: {error}"))
            })?;
            sync_parent_directory(&self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn effective_user_id() -> io::Result<u32> {
    Ok(fs::metadata("/proc/self")?.uid())
}

fn verify_private_directory(path: &Path) -> Result<(), DurableRunnerError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        DurableRunnerError::invalid(format!(
            "failed to inspect runner state directory {}: {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(DurableRunnerError::invalid(
            "runner state directory must be a real directory",
        ));
    }
    #[cfg(unix)]
    {
        if metadata.mode() & 0o777 != 0o700 {
            return Err(DurableRunnerError::invalid(
                "runner state directory permissions must be 0700",
            ));
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        if metadata.uid()
            != effective_user_id().map_err(|error| {
                DurableRunnerError::invalid(format!("failed to inspect daemon ownership: {error}"))
            })?
        {
            return Err(DurableRunnerError::invalid(
                "runner state directory must be owned by the daemon user",
            ));
        }
    }
    Ok(())
}

fn open_private_regular_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(no_follow_flag());
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "state path is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        if metadata.mode() & 0o777 != 0o600 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "state file permissions must be 0600",
            ));
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        if metadata.uid() != effective_user_id()? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "state file must be owned by the daemon user",
            ));
        }
    }
    Ok(file)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
const fn no_follow_flag() -> i32 {
    0x20000
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
const fn no_follow_flag() -> i32 {
    0x100
}

fn random_suffix() -> Result<String, DurableRunnerError> {
    let mut bytes = [0_u8; 16];
    #[cfg(unix)]
    {
        File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut bytes))
            .map_err(|error| {
                DurableRunnerError::invalid(format!("failed to obtain state-file randomness: {error}"))
            })?;
    }
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "bcrypt")]
        unsafe extern "system" {
            fn BCryptGenRandom(
                algorithm: *mut c_void,
                buffer: *mut u8,
                buffer_length: u32,
                flags: u32,
            ) -> i32;
        }
        const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;
        // SAFETY: the system RNG receives a valid writable buffer for its exact length.
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status < 0 {
            return Err(DurableRunnerError::invalid(
                "failed to obtain state-file randomness from BCryptGenRandom",
            ));
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        return Err(DurableRunnerError::invalid(
            "secure state-file randomness is unsupported on this platform",
        ));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn create_private_temporary_file(destination: &Path) -> Result<(PathBuf, File), DurableRunnerError> {
    let parent = destination
        .parent()
        .ok_or_else(|| DurableRunnerError::invalid("durable state path has no parent directory"))?;
    let filename = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| DurableRunnerError::invalid("durable state filename is not valid UTF-8"))?;
    for _ in 0..TEMP_FILE_ATTEMPTS {
        let path = parent.join(format!(".{filename}.{}.tmp", random_suffix()?));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(no_follow_flag());
        match options.open(&path) {
            Ok(file) => {
                #[cfg(unix)]
                if let Err(error) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
                    let _ = fs::remove_file(&path);
                    return Err(DurableRunnerError::invalid(format!(
                        "failed to secure temporary runner state: {error}"
                    )));
                }
                let metadata = file.metadata().map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to inspect temporary runner state: {error}"
                    ))
                })?;
                if !metadata.file_type().is_file() {
                    let _ = fs::remove_file(&path);
                    return Err(DurableRunnerError::invalid(
                        "temporary runner state is not a regular file",
                    ));
                }
                #[cfg(unix)]
                {
                    if metadata.mode() & 0o777 != 0o600 {
                        let _ = fs::remove_file(&path);
                        return Err(DurableRunnerError::invalid(
                            "temporary runner state is not private",
                        ));
                    }
                    #[cfg(any(target_os = "linux", target_os = "android"))]
                    if metadata.uid()
                        != effective_user_id().map_err(|error| {
                            DurableRunnerError::invalid(format!(
                                "failed to inspect temporary state ownership: {error}"
                            ))
                        })?
                    {
                        let _ = fs::remove_file(&path);
                        return Err(DurableRunnerError::invalid(
                            "temporary runner state is not daemon-owned",
                        ));
                    }
                }
                return Ok((path, file));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(DurableRunnerError::invalid(format!(
                    "failed to create exclusive temporary runner state: {error}"
                )))
            }
        }
    }
    Err(DurableRunnerError::invalid(
        "failed to allocate a unique temporary runner state file",
    ))
}

fn sync_parent_directory(path: &Path) -> Result<(), DurableRunnerError> {
    #[cfg(unix)]
    {
        let parent = path
            .parent()
            .ok_or_else(|| DurableRunnerError::invalid("durable state path has no parent directory"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to sync durable state parent directory: {error}"
                ))
            })?;
    }
    Ok(())
}

fn validate_state_binding(
    state: &DurableRunnerState,
    config: &DurableRunnerConfig,
) -> Result<(), DurableRunnerError> {
    if state.schema != STATE_SCHEMA {
        return Err(DurableRunnerError::invalid(
            "unsupported durable runner state schema",
        ));
    }
    for (name, stored, expected) in [
        (
            "runnerInstanceId",
            state.runner_instance_id.as_str(),
            config.runner_instance_id.as_str(),
        ),
        (
            "environmentLeaseId",
            state.environment_lease_id.as_str(),
            config.environment_lease_id.as_str(),
        ),
        ("runId", state.run_id.as_str(), config.run_id.as_str()),
        (
            "normalizedSessionId",
            state.normalized_session_id.as_str(),
            config.normalized_session_id.as_str(),
        ),
        ("turnId", state.turn_id.as_str(), config.turn_id.as_str()),
        ("itemId", state.item_id.as_str(), config.item_id.as_str()),
    ] {
        if stored != expected {
            return Err(DurableRunnerError::invalid(format!(
                "durable {name} does not match the requested recovery identity"
            )));
        }
    }
    decode_compacted_command_filter(&state.compacted_command_filter)?;
    Ok(())
}

fn redaction_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase().replace('-', "_");
    [
        "authorization",
        "password",
        "secret",
        "token",
        "api_key",
        "apikey",
        "credential",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

pub fn redact_text(input: &str) -> String {
    if input.to_ascii_lowercase().contains("bearer ") {
        return "[REDACTED]".to_owned();
    }
    input.to_owned()
}

pub fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if redaction_key(key) {
                            Value::String("[REDACTED]".to_owned())
                        } else {
                            sanitize_value(value)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_value).collect()),
        Value::String(text) => Value::String(redact_text(text)),
        other => other.clone(),
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let body = entries
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key serialization cannot fail"),
                        canonical_json(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        scalar => serde_json::to_string(scalar).expect("JSON scalar serialization cannot fail"),
    }
}

fn hex_encode(input: &[u8]) -> String {
    input.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(input: &str) -> Result<Vec<u8>, DurableRunnerError> {
    if input.len() % 2 != 0 {
        return Err(DurableRunnerError::invalid("hex value has an odd length"));
    }
    input
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair)
                .map_err(|_| DurableRunnerError::invalid("hex value is not valid UTF-8"))?;
            u8::from_str_radix(pair, 16)
                .map_err(|_| DurableRunnerError::invalid("hex value contains a non-hex character"))
        })
        .collect()
}

fn sha256_bytes(input: &[u8]) -> [u8; 32] {
    Sha256::digest(input).into()
}

fn sha256_digest(input: &[u8]) -> String {
    format!("sha256:{}", hex_encode(&sha256_bytes(input)))
}

fn digest_domain(domain: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(domain.as_bytes());
    digest.update([0]);
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    digest.finalize().into()
}

fn hmac_domain(key: &[u8], domain: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC-SHA256 accepts keys of every size");
    mac.update(domain.as_bytes());
    mac.update(&[0]);
    for part in parts {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

fn verify_hmac_hex(
    key: &[u8],
    domain: &str,
    parts: &[&[u8]],
    supplied: &str,
) -> Result<(), DurableRunnerError> {
    let supplied = hex_decode(supplied)?;
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC-SHA256 accepts keys of every size");
    mac.update(domain.as_bytes());
    mac.update(&[0]);
    for part in parts {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part);
    }
    mac.verify_slice(&supplied)
        .map_err(|_| DurableRunnerError::invalid("transport authentication proof is invalid"))
}

fn current_unix_ms() -> Result<u64, DurableRunnerError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DurableRunnerError::invalid("system clock precedes the Unix epoch"))?
        .as_millis();
    u64::try_from(millis).map_err(|_| DurableRunnerError::invalid("system clock value overflowed"))
}

struct CredentialMaterial {
    credential_id: String,
    auth_key: [u8; 32],
}

impl CredentialMaterial {
    fn from_token(token: &str) -> Self {
        Self {
            credential_id: format!(
                "sha256:{}",
                hex_encode(&digest_domain(
                    "paperclip-runner-credential-id-v1",
                    &[token.as_bytes()]
                ))
            ),
            auth_key: digest_domain("paperclip-runner-auth-key-v1", &[token.as_bytes()]),
        }
    }
}

impl Drop for CredentialMaterial {
    fn drop(&mut self) {
        self.auth_key.fill(0);
    }
}

fn empty_compacted_command_filter() -> String {
    "00".repeat(COMPACTED_COMMAND_FILTER_BYTES)
}

fn command_filter_positions(command_id: &str) -> [usize; COMPACTED_COMMAND_FILTER_HASHES] {
    let digest = digest_domain(
        "paperclip-runner-command-replay-filter-v1",
        &[command_id.as_bytes()],
    );
    let mut positions = [0_usize; COMPACTED_COMMAND_FILTER_HASHES];
    for (index, position) in positions.iter_mut().enumerate() {
        let offset = index * 4;
        let word = u32::from_be_bytes(digest[offset..offset + 4].try_into().unwrap());
        *position = word as usize % (COMPACTED_COMMAND_FILTER_BYTES * 8);
    }
    positions
}

fn decode_compacted_command_filter(encoded: &str) -> Result<Vec<u8>, DurableRunnerError> {
    let filter = hex_decode(encoded)?;
    if filter.len() != COMPACTED_COMMAND_FILTER_BYTES {
        return Err(DurableRunnerError::invalid(
            "durable compacted command filter has an invalid size",
        ));
    }
    Ok(filter)
}

fn compacted_command_maybe_seen(
    state: &DurableRunnerState,
    command_id: &str,
) -> Result<bool, DurableRunnerError> {
    let filter = decode_compacted_command_filter(&state.compacted_command_filter)?;
    Ok(command_filter_positions(command_id)
        .iter()
        .all(|position| filter[position / 8] & (1 << (position % 8)) != 0))
}

fn add_compacted_command(
    state: &mut DurableRunnerState,
    command_id: &str,
) -> Result<(), DurableRunnerError> {
    let mut filter = decode_compacted_command_filter(&state.compacted_command_filter)?;
    for position in command_filter_positions(command_id) {
        filter[position / 8] |= 1 << (position % 8);
    }
    state.compacted_command_filter = hex_encode(&filter);
    state.compacted_command_count = state.compacted_command_count.saturating_add(1);
    Ok(())
}

fn compact_processed_commands(state: &mut DurableRunnerState) -> Result<(), DurableRunnerError> {
    while state.processed_commands.len() > MAX_RECENT_PROCESSED_COMMANDS {
        let oldest = state
            .processed_commands
            .values()
            .min_by_key(|command| command.controller_seq)
            .map(|command| command.command_id.clone())
            .ok_or_else(|| DurableRunnerError::invalid("processed command compaction lost its cursor"))?;
        state.processed_commands.remove(&oldest);
        add_compacted_command(state, &oldest)?;
    }
    Ok(())
}

fn deterministic_time(sequence: u64) -> String {
    format!(
        "2026-08-07T23:{:02}:{:02}.{:03}Z",
        (sequence / 60_000) % 60,
        (sequence / 1_000) % 60,
        sequence % 1_000
    )
}

fn event_envelope(
    state: &DurableRunnerState,
    source_seq: u64,
    event_type: &str,
    priority: u8,
    payload: Value,
    item_id: Option<&str>,
) -> Value {
    let source_event_id = format!("event_{}_{source_seq:06}", state.runner_instance_id);
    let mut event = json!({
        "schema": "paperclip.prp.event.v1",
        "sourceEventId": source_event_id,
        "sourceSeq": source_seq,
        "sourceInstanceId": state.runner_instance_id,
        "sourceKind": "runner",
        "runId": state.run_id,
        "normalizedSessionId": state.normalized_session_id,
        "turnId": state.turn_id,
        "eventType": event_type,
        "schemaVersion": 1,
        "priority": priority,
        "emittedAt": deterministic_time(source_seq),
        "payload": sanitize_value(&payload),
    });
    if let Some(item_id) = item_id {
        event["itemId"] = Value::String(item_id.to_owned());
    }
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "envelopeId": format!("envelope_event_{source_seq:06}"),
        "kind": "event",
        "runnerInstanceId": state.runner_instance_id,
        "environmentLeaseId": state.environment_lease_id,
        "runId": state.run_id,
        "normalizedSessionId": state.normalized_session_id,
        "turnId": state.turn_id,
        "itemId": state.item_id,
        "sentAt": deterministic_time(source_seq),
        "payload": event,
    })
}

fn mark_backpressure(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
) -> Result<(), DurableRunnerError> {
    if state.backpressure {
        return Ok(());
    }
    state.backpressure = true;
    state.lifecycle = "backpressure".to_owned();
    enqueue_event(
        state,
        config,
        "runner.backpressure",
        0,
        json!({
            "reason": "outbox_soft_limit",
            "maxOutboxBytes": config.max_outbox_bytes,
            "p0ReserveBytes": config.p0_reserve_bytes,
            "newTurnsAccepted": false,
        }),
        None,
    )
}

fn mark_p0_storage_exhausted(state: &mut DurableRunnerState) {
    state.lifecycle = "unrecoverable".to_owned();
    state.unrecoverable_outcome = Some("p0_storage_exhausted".to_owned());
    state.record_diagnostic(
        "P0 storage reserve is exhausted; the durable session requires operator recovery",
    );
}

fn enqueue_event(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
    event_type: &str,
    priority: u8,
    payload: Value,
    item_id: Option<&str>,
) -> Result<(), DurableRunnerError> {
    if priority > 2 {
        return Err(DurableRunnerError::invalid("event priority must be P0, P1, or P2"));
    }

    if priority == 2 {
        if let Some(last) = state.outbox.last() {
            if last.priority == 2
                && last.event_type == event_type
                && last.item_id.as_deref() == item_id
            {
                let previous_count = last
                    .envelope
                    .pointer("/payload/payload/coalescedCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(1);
                let compacted = json!({
                    "coalescedCount": previous_count + 1,
                    "latest": sanitize_value(&payload),
                });
                let mut replacement = last.clone();
                replacement.envelope["payload"]["payload"] = compacted;
                replacement.byte_size = serde_json::to_vec(&replacement.envelope)
                    .map_err(|error| DurableRunnerError::invalid(error.to_string()))?
                    .len();
                let projected = state
                    .outbox_bytes()
                    .saturating_sub(last.byte_size)
                    .saturating_add(replacement.byte_size);
                let non_p0_limit = config
                    .max_outbox_bytes
                    .saturating_sub(config.p0_reserve_bytes);
                if projected > non_p0_limit {
                    return mark_backpressure(state, config);
                }
                *state
                    .outbox
                    .last_mut()
                    .expect("coalesced event was just read from the outbox tail") = replacement;
                state.peak_outbox_bytes = state.peak_outbox_bytes.max(projected);
                return Ok(());
            }
        }
    }

    let source_seq = state.next_source_seq;
    let envelope = event_envelope(state, source_seq, event_type, priority, payload, item_id);
    let bytes =
        serde_json::to_vec(&envelope).map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
    let byte_size = bytes.len();
    let projected = state.outbox_bytes().saturating_add(byte_size);
    let non_p0_limit = config
        .max_outbox_bytes
        .saturating_sub(config.p0_reserve_bytes);

    if priority == 2 && projected > non_p0_limit {
        return mark_backpressure(state, config);
    }
    if priority == 1 && projected > non_p0_limit {
        mark_backpressure(state, config)?;
        return Err(DurableRunnerError::invalid(
            "P1 event cannot enter the reserved P0 storage region",
        ));
    }
    if projected > config.max_outbox_bytes {
        mark_p0_storage_exhausted(state);
        return Err(DurableRunnerError::invalid(
            "P0 storage reserve exhausted; durable recovery is explicit",
        ));
    }

    state.next_source_seq += 1;
    state.outbox.push(StoredOutboxEvent {
        source_seq,
        source_event_id: format!("event_{}_{source_seq:06}", state.runner_instance_id),
        priority,
        event_type: event_type.to_owned(),
        item_id: item_id.map(str::to_owned),
        envelope,
        byte_size,
    });
    state.peak_outbox_bytes = state.peak_outbox_bytes.max(state.outbox_bytes());
    Ok(())
}

fn command_result_envelope(state: &DurableRunnerState, processed: &ProcessedCommand) -> Value {
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "envelopeId": format!("envelope_result_{}", processed.command_id),
        "kind": "command_result",
        "runnerInstanceId": state.runner_instance_id,
        "environmentLeaseId": state.environment_lease_id,
        "runId": state.run_id,
        "normalizedSessionId": state.normalized_session_id,
        "turnId": state.turn_id,
        "itemId": state.item_id,
        "sentAt": deterministic_time(processed.controller_seq),
        "payload": processed.result,
    })
}

fn execute_command_effect(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
    command_type: &str,
    payload: &Value,
) -> Result<(String, u64, String), DurableRunnerError> {
    if state.lifecycle == "revoked" {
        return Ok((
            "rejected".to_owned(),
            0,
            "connection capability is revoked; commands have no logical effect".to_owned(),
        ));
    }
    match command_type {
        "run.prepare" => {
            state.lifecycle = "ready".to_owned();
            enqueue_event(
                state,
                config,
                "workspace.ready",
                1,
                json!({ "workspace": "durable-recovery-durable-fixture" }),
                None,
            )?;
            Ok(("completed".to_owned(), 1, "run prepared".to_owned()))
        }
        "session.open" => {
            enqueue_event(
                state,
                config,
                "session.started",
                0,
                json!({
                    "normalizedSessionId": state.normalized_session_id,
                    "driverSessionId": "driver_durable_runner_fake",
                    "resumed": state.reconnect_count > 0,
                }),
                None,
            )?;
            Ok(("completed".to_owned(), 1, "session bound".to_owned()))
        }
        "fault.harness_restart" => {
            prove_harness_restart(config)?;
            let previous_generation = state.harness_generation;
            state.harness_generation += 1;
            enqueue_event(
                state,
                config,
                "harness.exited",
                0,
                json!({
                    "generation": previous_generation,
                    "reason": "fault_injection_restart",
                    "recoverable": true,
                }),
                None,
            )?;
            enqueue_event(
                state,
                config,
                "harness.ready",
                0,
                json!({
                    "generation": state.harness_generation,
                    "driverKind": "fake",
                }),
                None,
            )?;
            enqueue_event(
                state,
                config,
                "session.reconciled",
                0,
                json!({
                    "normalizedSessionId": state.normalized_session_id,
                    "turnId": state.turn_id,
                    "itemId": state.item_id,
                    "outcome": "same_session_resumed",
                }),
                Some(&state.item_id.clone()),
            )?;
            Ok((
                "completed".to_owned(),
                1,
                "harness restarted and reconciled".to_owned(),
            ))
        }
        "fault.storage_pressure" => {
            let item_id = state.item_id.clone();
            for index in 0..250_u64 {
                enqueue_event(
                    state,
                    config,
                    "item.delta",
                    2,
                    json!({
                        "chunk": format!("bounded-progress-{index:03}"),
                        "secretToken": "must-not-persist",
                    }),
                    Some(&item_id),
                )?;
            }
            mark_backpressure(state, config)?;
            Ok((
                "completed".to_owned(),
                1,
                "storage pressure applied with P2 coalescing".to_owned(),
            ))
        }
        "turn.start" if state.lifecycle == "draining" || state.backpressure => Ok((
            "rejected".to_owned(),
            0,
            "new turns are disabled while draining or backpressured".to_owned(),
        )),
        "turn.start" => {
            let item_id = state.item_id.clone();
            enqueue_event(
                state,
                config,
                "turn.accepted",
                0,
                json!({ "turnId": state.turn_id, "sameSession": true }),
                None,
            )?;
            enqueue_event(
                state,
                config,
                "item.started",
                1,
                json!({ "kind": "assistant_message" }),
                Some(&item_id),
            )?;
            enqueue_event(
                state,
                config,
                "item.delta",
                2,
                json!({ "text": payload.get("text").cloned().unwrap_or_else(|| json!("Durable runner")) }),
                Some(&item_id),
            )?;
            enqueue_event(
                state,
                config,
                "item.completed",
                1,
                json!({ "text": "Durable recovery completed." }),
                Some(&item_id),
            )?;
            enqueue_event(
                state,
                config,
                "run.result.proposed",
                0,
                json!({
                    "schema": "paperclip.prp.result.v1",
                    "status": "succeeded",
                    "reportedWorkDisposition": "done",
                    "summary": "Durable runner durable transport recovered without duplicate effects.",
                }),
                None,
            )?;
            enqueue_event(
                state,
                config,
                "run.terminal",
                0,
                json!({
                    "schema": "paperclip.prp.terminal.v1",
                    "turnTerminalState": "completed",
                    "runTerminalState": "succeeded",
                    "reportedWorkDisposition": "done",
                }),
                None,
            )?;
            state.lifecycle = "terminal".to_owned();
            Ok(("completed".to_owned(), 1, "turn completed".to_owned()))
        }
        "runner.drain" => {
            state.lifecycle = "draining".to_owned();
            enqueue_event(
                state,
                config,
                "runner.draining",
                0,
                json!({ "newWorkAccepted": false }),
                None,
            )?;
            Ok(("completed".to_owned(), 1, "runner draining".to_owned()))
        }
        "runner.shutdown" => {
            state.stop_after_flush = true;
            enqueue_event(
                state,
                config,
                "runner.stopped",
                0,
                json!({ "afterDurableFlush": true }),
                None,
            )?;
            Ok((
                "completed".to_owned(),
                1,
                "runner will stop after durable flush".to_owned(),
            ))
        }
        unsupported => Ok((
            "rejected".to_owned(),
            0,
            format!("unsupported Durable runner command: {unsupported}"),
        )),
    }
}

fn prove_harness_restart(config: &DurableRunnerConfig) -> Result<(), DurableRunnerError> {
    let fake_harness_path = config.fake_harness_path.as_ref().ok_or_else(|| {
        DurableRunnerError::invalid("fake harness path is required for restart injection")
    })?;
    let script_path = config.fake_harness_script_path.as_ref().ok_or_else(|| {
        DurableRunnerError::invalid("fake harness script is required for restart injection")
    })?;
    let args = vec![
        "--script".to_owned(),
        script_path.display().to_string(),
        "--delay-ms".to_owned(),
        "1".to_owned(),
    ];
    for generation in 1..=2_u64 {
        let mut harness = SupervisedProcess::spawn(
            fake_harness_path,
            &args,
            Duration::from_millis(50),
            64 * 1024,
        )
        .map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to start fake harness generation {generation}: {error}"
            ))
        })?;
        let ready = harness
            .receive_stdout_line(Duration::from_secs(2))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?
            .ok_or_else(|| {
                DurableRunnerError::invalid(format!(
                    "fake harness generation {generation} did not become ready"
                ))
            })?;
        let message: Value = serde_json::from_str(&ready).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "fake harness generation {generation} emitted malformed ready data: {error}"
            ))
        })?;
        if message.get("type").and_then(Value::as_str) != Some("ready") {
            return Err(DurableRunnerError::invalid(format!(
                "fake harness generation {generation} did not emit a ready message"
            )));
        }
        harness
            .terminate_group()
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
    }
    Ok(())
}

fn process_command(
    state: &mut DurableRunnerState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    command: &Value,
) -> Result<ProcessedCommand, DurableRunnerError> {
    let command_id = command
        .get("commandId")
        .and_then(Value::as_str)
        .ok_or_else(|| DurableRunnerError::invalid("commandId is required"))?;
    let controller_seq = command
        .get("controllerSeq")
        .and_then(Value::as_u64)
        .ok_or_else(|| DurableRunnerError::invalid("controllerSeq is required"))?;
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| DurableRunnerError::invalid("command type is required"))?;
    let canonical = canonical_json(command);
    let command_digest = sha256_digest(canonical.as_bytes());

    if let Some(previous) = state.processed_commands.get(command_id) {
        if previous.command_digest != command_digest {
            return Err(DurableRunnerError::invalid(
                "commandId was reused with a different payload",
            ));
        }
        return Ok(previous.clone());
    }
    if compacted_command_maybe_seen(state, command_id)? {
        if controller_seq > state.last_controller_command_seq + 1 {
            return Err(DurableRunnerError::invalid(format!(
                "controllerSeq must be at most {}; received {controller_seq}",
                state.last_controller_command_seq + 1
            )));
        }
        let result = sanitize_value(&json!({
            "commandId": command_id,
            "controllerSeq": controller_seq,
            "status": "rejected",
            "logicalEffectCount": 0,
            "detail": "command identity may have been processed before ledger compaction; replay rejected fail-closed",
        }));
        let processed = ProcessedCommand {
            command_id: command_id.to_owned(),
            controller_seq,
            command_digest,
            status: "rejected".to_owned(),
            logical_effect_count: 0,
            result,
        };
        if controller_seq == state.last_controller_command_seq + 1 {
            let mut candidate = state.clone();
            candidate.last_controller_command_seq = controller_seq;
            candidate
                .processed_commands
                .insert(command_id.to_owned(), processed.clone());
            compact_processed_commands(&mut candidate)?;
            store.save(&candidate)?;
            *state = candidate;
        }
        return Ok(processed);
    }
    if controller_seq != state.last_controller_command_seq + 1 {
        return Err(DurableRunnerError::invalid(format!(
            "controllerSeq must be {}; received {controller_seq}",
            state.last_controller_command_seq + 1
        )));
    }

    let payload = command.get("payload").cloned().unwrap_or(Value::Null);
    let mut candidate = state.clone();
    let effect = execute_command_effect(&mut candidate, config, command_type, &payload);
    let (status, logical_effect_count, detail) = match effect {
        Ok(effect) => effect,
        Err(error)
            if state.unrecoverable_outcome.as_deref() != Some("p0_storage_exhausted")
                && candidate.unrecoverable_outcome.as_deref() == Some("p0_storage_exhausted") =>
        {
            // The attempted command may have staged earlier events before discovering that a
            // mandatory P0 event cannot be stored. Discard every staged logical effect and keep
            // only the truthful terminal storage outcome plus its durable command result.
            candidate = state.clone();
            mark_p0_storage_exhausted(&mut candidate);
            ("failed".to_owned(), 0, error.to_string())
        }
        Err(error) => return Err(error),
    };
    let result = sanitize_value(&json!({
        "commandId": command_id,
        "controllerSeq": controller_seq,
        "status": status,
        "logicalEffectCount": logical_effect_count,
        "detail": detail,
    }));
    let processed = ProcessedCommand {
        command_id: command_id.to_owned(),
        controller_seq,
        command_digest,
        status,
        logical_effect_count,
        result,
    };
    candidate.last_controller_command_seq = controller_seq;
    candidate
        .processed_commands
        .insert(command_id.to_owned(), processed.clone());
    compact_processed_commands(&mut candidate)?;
    store.save(&candidate)?;
    *state = candidate;
    Ok(processed)
}
