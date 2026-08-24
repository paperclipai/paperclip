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

use crate::phase2::SupervisedProcess;

const STATE_SCHEMA: &str = "paperclip.runner.phase3.state.v1";
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
pub struct Phase3Error(String);

impl Phase3Error {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for Phase3Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for Phase3Error {}

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

pub fn capture_bootstrap_ticket() -> Result<Option<BootstrapTicket>, Phase3Error> {
    let value = std::env::var_os("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET");
    std::env::remove_var("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET");
    value
        .map(|value| {
            value
                .into_string()
                .map(|value| BootstrapTicket(SensitiveString::new(value)))
                .map_err(|_| Phase3Error::invalid("runner bootstrap ticket is not valid UTF-8"))
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

    pub fn apply_ack(&mut self, acked_source_seq: u64) -> Result<(), Phase3Error> {
        if acked_source_seq < self.acked_source_seq {
            return Err(Phase3Error::invalid(
                "cumulative ACK cannot move behind the durable cursor",
            ));
        }
        if acked_source_seq > self.highest_source_seq() {
            return Err(Phase3Error::invalid(
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
    pub fn new(state_dir: &Path) -> Result<Self, Phase3Error> {
        if let Ok(metadata) = fs::symlink_metadata(state_dir) {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                return Err(Phase3Error::invalid(format!(
                    "runner state directory {} must be a real directory",
                    state_dir.display()
                )));
            }
        }
        fs::create_dir_all(state_dir).map_err(|error| {
            Phase3Error::invalid(format!(
                "failed to create runner state directory {}: {error}",
                state_dir.display()
            ))
        })?;
        #[cfg(unix)]
        fs::set_permissions(state_dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
            Phase3Error::invalid(format!(
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
    ) -> Result<(DurableRunnerState, bool), Phase3Error> {
        let bytes = match open_private_regular_file(&self.path) {
            Ok(mut file) => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).map_err(|error| {
                    Phase3Error::invalid(format!(
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
                return Err(Phase3Error::invalid(format!(
                    "failed to open private durable runner state {}: {error}",
                    self.path.display()
                )))
            }
        };
        let mut state: DurableRunnerState = serde_json::from_slice(&bytes).map_err(|error| {
            Phase3Error::invalid(format!(
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

    pub fn save(&self, state: &DurableRunnerState) -> Result<(), Phase3Error> {
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            Phase3Error::invalid(format!("failed to serialize durable runner state: {error}"))
        })?;
        let (temporary, mut file) = create_private_temporary_file(&self.path)?;
        let result = (|| -> Result<(), Phase3Error> {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| {
                    Phase3Error::invalid(format!("failed to commit durable runner state: {error}"))
                })?;
            drop(file);
            fs::rename(&temporary, &self.path).map_err(|error| {
                Phase3Error::invalid(format!("failed to replace durable runner state: {error}"))
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

fn verify_private_directory(path: &Path) -> Result<(), Phase3Error> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        Phase3Error::invalid(format!(
            "failed to inspect runner state directory {}: {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(Phase3Error::invalid(
            "runner state directory must be a real directory",
        ));
    }
    #[cfg(unix)]
    {
        if metadata.mode() & 0o777 != 0o700 {
            return Err(Phase3Error::invalid(
                "runner state directory permissions must be 0700",
            ));
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        if metadata.uid()
            != effective_user_id().map_err(|error| {
                Phase3Error::invalid(format!("failed to inspect daemon ownership: {error}"))
            })?
        {
            return Err(Phase3Error::invalid(
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

fn random_suffix() -> Result<String, Phase3Error> {
    let mut bytes = [0_u8; 16];
    #[cfg(unix)]
    {
        File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut bytes))
            .map_err(|error| {
                Phase3Error::invalid(format!("failed to obtain state-file randomness: {error}"))
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
            return Err(Phase3Error::invalid(
                "failed to obtain state-file randomness from BCryptGenRandom",
            ));
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        return Err(Phase3Error::invalid(
            "secure state-file randomness is unsupported on this platform",
        ));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn create_private_temporary_file(destination: &Path) -> Result<(PathBuf, File), Phase3Error> {
    let parent = destination
        .parent()
        .ok_or_else(|| Phase3Error::invalid("durable state path has no parent directory"))?;
    let filename = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| Phase3Error::invalid("durable state filename is not valid UTF-8"))?;
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
                    return Err(Phase3Error::invalid(format!(
                        "failed to secure temporary runner state: {error}"
                    )));
                }
                let metadata = file.metadata().map_err(|error| {
                    Phase3Error::invalid(format!(
                        "failed to inspect temporary runner state: {error}"
                    ))
                })?;
                if !metadata.file_type().is_file() {
                    let _ = fs::remove_file(&path);
                    return Err(Phase3Error::invalid(
                        "temporary runner state is not a regular file",
                    ));
                }
                #[cfg(unix)]
                {
                    if metadata.mode() & 0o777 != 0o600 {
                        let _ = fs::remove_file(&path);
                        return Err(Phase3Error::invalid(
                            "temporary runner state is not private",
                        ));
                    }
                    #[cfg(any(target_os = "linux", target_os = "android"))]
                    if metadata.uid()
                        != effective_user_id().map_err(|error| {
                            Phase3Error::invalid(format!(
                                "failed to inspect temporary state ownership: {error}"
                            ))
                        })?
                    {
                        let _ = fs::remove_file(&path);
                        return Err(Phase3Error::invalid(
                            "temporary runner state is not daemon-owned",
                        ));
                    }
                }
                return Ok((path, file));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(Phase3Error::invalid(format!(
                    "failed to create exclusive temporary runner state: {error}"
                )))
            }
        }
    }
    Err(Phase3Error::invalid(
        "failed to allocate a unique temporary runner state file",
    ))
}

fn sync_parent_directory(path: &Path) -> Result<(), Phase3Error> {
    #[cfg(unix)]
    {
        let parent = path
            .parent()
            .ok_or_else(|| Phase3Error::invalid("durable state path has no parent directory"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                Phase3Error::invalid(format!(
                    "failed to sync durable state parent directory: {error}"
                ))
            })?;
    }
    Ok(())
}

fn validate_state_binding(
    state: &DurableRunnerState,
    config: &DurableRunnerConfig,
) -> Result<(), Phase3Error> {
    if state.schema != STATE_SCHEMA {
        return Err(Phase3Error::invalid(
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
            return Err(Phase3Error::invalid(format!(
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

fn hex_decode(input: &str) -> Result<Vec<u8>, Phase3Error> {
    if input.len() % 2 != 0 {
        return Err(Phase3Error::invalid("hex value has an odd length"));
    }
    input
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair)
                .map_err(|_| Phase3Error::invalid("hex value is not valid UTF-8"))?;
            u8::from_str_radix(pair, 16)
                .map_err(|_| Phase3Error::invalid("hex value contains a non-hex character"))
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
) -> Result<(), Phase3Error> {
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
        .map_err(|_| Phase3Error::invalid("transport authentication proof is invalid"))
}

fn current_unix_ms() -> Result<u64, Phase3Error> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Phase3Error::invalid("system clock precedes the Unix epoch"))?
        .as_millis();
    u64::try_from(millis).map_err(|_| Phase3Error::invalid("system clock value overflowed"))
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

fn decode_compacted_command_filter(encoded: &str) -> Result<Vec<u8>, Phase3Error> {
    let filter = hex_decode(encoded)?;
    if filter.len() != COMPACTED_COMMAND_FILTER_BYTES {
        return Err(Phase3Error::invalid(
            "durable compacted command filter has an invalid size",
        ));
    }
    Ok(filter)
}

fn compacted_command_maybe_seen(
    state: &DurableRunnerState,
    command_id: &str,
) -> Result<bool, Phase3Error> {
    let filter = decode_compacted_command_filter(&state.compacted_command_filter)?;
    Ok(command_filter_positions(command_id)
        .iter()
        .all(|position| filter[position / 8] & (1 << (position % 8)) != 0))
}

fn add_compacted_command(
    state: &mut DurableRunnerState,
    command_id: &str,
) -> Result<(), Phase3Error> {
    let mut filter = decode_compacted_command_filter(&state.compacted_command_filter)?;
    for position in command_filter_positions(command_id) {
        filter[position / 8] |= 1 << (position % 8);
    }
    state.compacted_command_filter = hex_encode(&filter);
    state.compacted_command_count = state.compacted_command_count.saturating_add(1);
    Ok(())
}

fn compact_processed_commands(state: &mut DurableRunnerState) -> Result<(), Phase3Error> {
    while state.processed_commands.len() > MAX_RECENT_PROCESSED_COMMANDS {
        let oldest = state
            .processed_commands
            .values()
            .min_by_key(|command| command.controller_seq)
            .map(|command| command.command_id.clone())
            .ok_or_else(|| Phase3Error::invalid("processed command compaction lost its cursor"))?;
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
) -> Result<(), Phase3Error> {
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
) -> Result<(), Phase3Error> {
    if priority > 2 {
        return Err(Phase3Error::invalid("event priority must be P0, P1, or P2"));
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
                    .map_err(|error| Phase3Error::invalid(error.to_string()))?
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
        serde_json::to_vec(&envelope).map_err(|error| Phase3Error::invalid(error.to_string()))?;
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
        return Err(Phase3Error::invalid(
            "P1 event cannot enter the reserved P0 storage region",
        ));
    }
    if projected > config.max_outbox_bytes {
        mark_p0_storage_exhausted(state);
        return Err(Phase3Error::invalid(
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
) -> Result<(String, u64, String), Phase3Error> {
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
                json!({ "workspace": "phase-03-durable-fixture" }),
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
                    "driverSessionId": "driver_phase3_fake",
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
                json!({ "text": payload.get("text").cloned().unwrap_or_else(|| json!("Phase 3")) }),
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
                    "summary": "Phase 3 durable transport recovered without duplicate effects.",
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
            format!("unsupported Phase 3 command: {unsupported}"),
        )),
    }
}

fn prove_harness_restart(config: &DurableRunnerConfig) -> Result<(), Phase3Error> {
    let fake_harness_path = config.fake_harness_path.as_ref().ok_or_else(|| {
        Phase3Error::invalid("fake harness path is required for restart injection")
    })?;
    let script_path = config.fake_harness_script_path.as_ref().ok_or_else(|| {
        Phase3Error::invalid("fake harness script is required for restart injection")
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
            Phase3Error::invalid(format!(
                "failed to start fake harness generation {generation}: {error}"
            ))
        })?;
        let ready = harness
            .receive_stdout_line(Duration::from_secs(2))
            .map_err(|error| Phase3Error::invalid(error.to_string()))?
            .ok_or_else(|| {
                Phase3Error::invalid(format!(
                    "fake harness generation {generation} did not become ready"
                ))
            })?;
        let message: Value = serde_json::from_str(&ready).map_err(|error| {
            Phase3Error::invalid(format!(
                "fake harness generation {generation} emitted malformed ready data: {error}"
            ))
        })?;
        if message.get("type").and_then(Value::as_str) != Some("ready") {
            return Err(Phase3Error::invalid(format!(
                "fake harness generation {generation} did not emit a ready message"
            )));
        }
        harness
            .terminate_group()
            .map_err(|error| Phase3Error::invalid(error.to_string()))?;
    }
    Ok(())
}

fn process_command(
    state: &mut DurableRunnerState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    command: &Value,
) -> Result<ProcessedCommand, Phase3Error> {
    let command_id = command
        .get("commandId")
        .and_then(Value::as_str)
        .ok_or_else(|| Phase3Error::invalid("commandId is required"))?;
    let controller_seq = command
        .get("controllerSeq")
        .and_then(Value::as_u64)
        .ok_or_else(|| Phase3Error::invalid("controllerSeq is required"))?;
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| Phase3Error::invalid("command type is required"))?;
    let canonical = canonical_json(command);
    let command_digest = sha256_digest(canonical.as_bytes());

    if let Some(previous) = state.processed_commands.get(command_id) {
        if previous.command_digest != command_digest {
            return Err(Phase3Error::invalid(
                "commandId was reused with a different payload",
            ));
        }
        return Ok(previous.clone());
    }
    if compacted_command_maybe_seen(state, command_id)? {
        if controller_seq > state.last_controller_command_seq + 1 {
            return Err(Phase3Error::invalid(format!(
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
        return Err(Phase3Error::invalid(format!(
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

struct ParsedWsUrl {
    host: String,
    authority: String,
    port: u16,
    path: String,
}

fn parse_ws_url(input: &str) -> Result<ParsedWsUrl, Phase3Error> {
    let remainder = input
        .strip_prefix("ws://")
        .ok_or_else(|| Phase3Error::invalid("runner core accepts exactly the ws:// scheme"))?;
    if remainder.is_empty()
        || remainder
            .chars()
            .any(|character| character.is_ascii_control() || character.is_ascii_whitespace())
        || remainder.contains(['?', '#', '\\'])
    {
        return Err(Phase3Error::invalid(
            "WebSocket URL contains malformed, query, fragment, or path ambiguity",
        ));
    }
    let (authority, path) = remainder
        .split_once('/')
        .map_or((remainder, "/".to_owned()), |(authority, path)| {
            (authority, format!("/{path}"))
        });
    if authority.is_empty() || authority.contains(['@', '%']) {
        return Err(Phase3Error::invalid(
            "WebSocket authority must not contain userinfo or encoding ambiguity",
        ));
    }
    let (host, port) = if authority.starts_with('[') {
        let closing = authority
            .find(']')
            .ok_or_else(|| Phase3Error::invalid("bracketed IPv6 authority is malformed"))?;
        let host = &authority[1..closing];
        let port = authority[closing + 1..]
            .strip_prefix(':')
            .ok_or_else(|| Phase3Error::invalid("bracketed IPv6 authority requires a port"))?;
        host.parse::<std::net::Ipv6Addr>()
            .map_err(|_| Phase3Error::invalid("bracketed WebSocket host must be IPv6"))?;
        (host, port)
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .ok_or_else(|| Phase3Error::invalid("WebSocket URL must include an explicit port"))?;
        if host.is_empty() || host.contains(':') {
            return Err(Phase3Error::invalid(
                "WebSocket host is empty or an unbracketed IPv6 literal",
            ));
        }
        (host, port)
    };
    let port = port
        .parse::<u16>()
        .map_err(|error| Phase3Error::invalid(format!("invalid WebSocket port: {error}")))?;
    if port == 0 {
        return Err(Phase3Error::invalid("WebSocket port must be non-zero"));
    }
    Ok(ParsedWsUrl {
        host: host.to_owned(),
        authority: authority.to_owned(),
        port,
        path,
    })
}

struct ResolvedWsTarget {
    authority: String,
    path: String,
    addresses: Vec<SocketAddr>,
}

impl ResolvedWsTarget {
    fn resolve(input: &str) -> Result<Self, Phase3Error> {
        resolve_ws_target_with(input, |host, port| {
            (host, port)
                .to_socket_addrs()
                .map(|addresses| addresses.collect())
        })
    }
}

fn resolve_ws_target_with<F>(input: &str, resolver: F) -> Result<ResolvedWsTarget, Phase3Error>
where
    F: FnOnce(&str, u16) -> io::Result<Vec<SocketAddr>>,
{
    let parsed = parse_ws_url(input)?;
    let mut addresses = resolver(&parsed.host, parsed.port).map_err(|error| {
        Phase3Error::invalid(format!("failed to resolve WebSocket destination: {error}"))
    })?;
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(Phase3Error::invalid(
            "WebSocket destination resolved to no addresses",
        ));
    }
    if addresses.iter().any(|address| !address.ip().is_loopback()) {
        return Err(Phase3Error::invalid(
            "every WebSocket destination must be loopback (127.0.0.0/8 or ::1)",
        ));
    }
    Ok(ResolvedWsTarget {
        authority: parsed.authority,
        path: parsed.path,
        addresses,
    })
}

struct WsClient {
    stream: TcpStream,
    mask_counter: u32,
    max_frame_bytes: usize,
    secure_channel: Option<SecureChannel>,
}

struct SecureChannel {
    send_cipher: Aes256Gcm,
    receive_cipher: Aes256Gcm,
    send_counter: u64,
    receive_counter: u64,
    session_id: String,
}

impl SecureChannel {
    fn new(
        auth_key: &[u8],
        challenge: &[u8],
        server_proof: &[u8],
        client_proof: &[u8],
    ) -> Result<Self, Phase3Error> {
        let session_binding = digest_domain(
            "paperclip-runner-session-binding-v1",
            &[challenge, server_proof, client_proof],
        );
        let send_key = hmac_domain(
            auth_key,
            "paperclip-runner-client-to-core-key-v1",
            &[&session_binding],
        );
        let receive_key = hmac_domain(
            auth_key,
            "paperclip-runner-core-to-client-key-v1",
            &[&session_binding],
        );
        Ok(Self {
            send_cipher: Aes256Gcm::new_from_slice(&send_key)
                .map_err(|_| Phase3Error::invalid("failed to initialize transport encryption"))?,
            receive_cipher: Aes256Gcm::new_from_slice(&receive_key)
                .map_err(|_| Phase3Error::invalid("failed to initialize transport decryption"))?,
            send_counter: 0,
            receive_counter: 0,
            session_id: format!("sha256:{}", hex_encode(&session_binding)),
        })
    }

    fn nonce(direction: &[u8; 4], counter: u64) -> [u8; 12] {
        let mut nonce = [0_u8; 12];
        nonce[..4].copy_from_slice(direction);
        nonce[4..].copy_from_slice(&counter.to_be_bytes());
        nonce
    }

    fn aad(&self, direction: &str, counter: u64) -> Vec<u8> {
        format!(
            "{SECURE_FRAME_SCHEMA}\0{}\0{direction}\0{counter}",
            self.session_id
        )
        .into_bytes()
    }

    fn encrypt(&mut self, plaintext: &[u8]) -> Result<Value, Phase3Error> {
        let counter = self.send_counter;
        let nonce = Self::nonce(b"P3C1", counter);
        let aad = self.aad("client_to_core", counter);
        let ciphertext = self
            .send_cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| Phase3Error::invalid("secure transport encryption failed"))?;
        self.send_counter = self
            .send_counter
            .checked_add(1)
            .ok_or_else(|| Phase3Error::invalid("secure transport send counter exhausted"))?;
        Ok(json!({
            "schema": SECURE_FRAME_SCHEMA,
            "counter": counter,
            "ciphertext": hex_encode(&ciphertext),
        }))
    }

    fn decrypt(&mut self, frame: &Value) -> Result<Value, Phase3Error> {
        if frame.get("schema").and_then(Value::as_str) != Some(SECURE_FRAME_SCHEMA) {
            return Err(Phase3Error::invalid(
                "unauthenticated plaintext control frame was rejected",
            ));
        }
        let counter = frame
            .get("counter")
            .and_then(Value::as_u64)
            .ok_or_else(|| Phase3Error::invalid("secure frame counter is required"))?;
        if counter != self.receive_counter {
            return Err(Phase3Error::invalid(
                "secure frame counter was replayed or arrived out of order",
            ));
        }
        let ciphertext = frame
            .get("ciphertext")
            .and_then(Value::as_str)
            .ok_or_else(|| Phase3Error::invalid("secure frame ciphertext is required"))?;
        let ciphertext = hex_decode(ciphertext)?;
        let nonce = Self::nonce(b"P3S1", counter);
        let aad = self.aad("core_to_client", counter);
        let plaintext = self
            .receive_cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| Phase3Error::invalid("secure frame authentication failed"))?;
        self.receive_counter = self
            .receive_counter
            .checked_add(1)
            .ok_or_else(|| Phase3Error::invalid("secure transport receive counter exhausted"))?;
        serde_json::from_slice(&plaintext).map_err(|error| {
            Phase3Error::invalid(format!("secure frame JSON is malformed: {error}"))
        })
    }
}

fn encode_masked_frame(
    opcode: u8,
    payload: &[u8],
    mask: [u8; 4],
    max_frame_bytes: usize,
) -> Result<Vec<u8>, Phase3Error> {
    if payload.len() > max_frame_bytes {
        return Err(Phase3Error::invalid(
            "outbound WebSocket frame exceeds the limit",
        ));
    }
    let mut frame = vec![0x80 | opcode];
    match payload.len() {
        length if length <= 125 => frame.push(0x80 | length as u8),
        length if length <= u16::MAX as usize => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    Ok(frame)
}

fn checked_inbound_frame_length(length: u64, max_frame_bytes: usize) -> Result<usize, Phase3Error> {
    let length = usize::try_from(length)
        .map_err(|_| Phase3Error::invalid("WebSocket frame length overflow"))?;
    if length > max_frame_bytes {
        return Err(Phase3Error::invalid(
            "inbound WebSocket frame exceeds the limit",
        ));
    }
    Ok(length)
}

impl WsClient {
    fn connect(target: &ResolvedWsTarget, max_frame_bytes: usize) -> Result<Self, Phase3Error> {
        let mut stream = TcpStream::connect(target.addresses.as_slice())
            .map_err(|error| Phase3Error::invalid(format!("WebSocket connect failed: {error}")))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| Phase3Error::invalid(error.to_string()))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| Phase3Error::invalid(error.to_string()))?;
        let mut request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
            target.path,
            target.authority,
            STATIC_WEBSOCKET_KEY
        )
        .into_bytes();
        let write_result = stream.write_all(&request).and_then(|_| stream.flush());
        // Keep the request buffer short-lived even though it contains only public data.
        // Authentication capabilities never cross the socket.
        request.fill(0);
        request.clear();
        write_result.map_err(|error| {
            Phase3Error::invalid(format!("WebSocket upgrade write failed: {error}"))
        })?;

        let mut response = Vec::new();
        let mut byte = [0_u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            if response.len() >= MAX_HTTP_HEADER_BYTES {
                return Err(Phase3Error::invalid(
                    "WebSocket response headers are too large",
                ));
            }
            stream.read_exact(&mut byte).map_err(|error| {
                Phase3Error::invalid(format!("WebSocket upgrade response failed: {error}"))
            })?;
            response.push(byte[0]);
        }
        let response = String::from_utf8(response)
            .map_err(|error| Phase3Error::invalid(format!("invalid HTTP response: {error}")))?;
        if !response.starts_with("HTTP/1.1 101 ") {
            let status = response
                .lines()
                .next()
                .unwrap_or("HTTP response unavailable");
            return Err(Phase3Error::invalid(format!(
                "WebSocket authentication or upgrade rejected: {status}"
            )));
        }
        let accept_valid = response.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("sec-websocket-accept")
                    && value.trim() == STATIC_WEBSOCKET_ACCEPT
            })
        });
        if !accept_valid {
            return Err(Phase3Error::invalid(
                "WebSocket server returned an invalid acceptance proof",
            ));
        }
        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|error| Phase3Error::invalid(error.to_string()))?;
        Ok(Self {
            stream,
            mask_counter: 1,
            max_frame_bytes,
            secure_channel: None,
        })
    }

    fn send_json(&mut self, value: &Value) -> Result<(), Phase3Error> {
        let bytes = serde_json::to_vec(value).map_err(|error| {
            Phase3Error::invalid(format!("frame serialization failed: {error}"))
        })?;
        let frame = self
            .secure_channel
            .as_mut()
            .ok_or_else(|| Phase3Error::invalid("secure transport is not authenticated"))?
            .encrypt(&bytes)?;
        self.send_plain_json(&frame)
    }

    fn send_plain_json(&mut self, value: &Value) -> Result<(), Phase3Error> {
        let bytes = serde_json::to_vec(value).map_err(|error| {
            Phase3Error::invalid(format!("frame serialization failed: {error}"))
        })?;
        self.send_frame(0x1, &bytes)
    }

    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), Phase3Error> {
        let mask = self.mask_counter.to_be_bytes();
        self.mask_counter = self.mask_counter.wrapping_add(1);
        let frame = encode_masked_frame(opcode, payload, mask, self.max_frame_bytes)?;
        self.stream
            .write_all(&frame)
            .and_then(|_| self.stream.flush())
            .map_err(|error| Phase3Error::invalid(format!("WebSocket frame write failed: {error}")))
    }

    fn receive_json(&mut self) -> Result<Option<Value>, Phase3Error> {
        let Some(frame) = self.receive_plain_json()? else {
            return Ok(None);
        };
        let value = self
            .secure_channel
            .as_mut()
            .ok_or_else(|| Phase3Error::invalid("secure transport is not authenticated"))?
            .decrypt(&frame)?;
        Ok(Some(value))
    }

    fn receive_plain_json(&mut self) -> Result<Option<Value>, Phase3Error> {
        loop {
            let mut header = [0_u8; 2];
            match self.stream.read_exact(&mut header) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None);
                }
                Err(error) => {
                    return Err(Phase3Error::invalid(format!(
                        "WebSocket connection closed: {error}"
                    )))
                }
            }
            let opcode = header[0] & 0x0f;
            let masked = header[1] & 0x80 != 0;
            let mut length = u64::from(header[1] & 0x7f);
            if length == 126 {
                let mut extended = [0_u8; 2];
                self.stream
                    .read_exact(&mut extended)
                    .map_err(|error| Phase3Error::invalid(error.to_string()))?;
                length = u64::from(u16::from_be_bytes(extended));
            } else if length == 127 {
                let mut extended = [0_u8; 8];
                self.stream
                    .read_exact(&mut extended)
                    .map_err(|error| Phase3Error::invalid(error.to_string()))?;
                length = u64::from_be_bytes(extended);
            }
            let length = checked_inbound_frame_length(length, self.max_frame_bytes)?;
            let mut mask = [0_u8; 4];
            if masked {
                self.stream
                    .read_exact(&mut mask)
                    .map_err(|error| Phase3Error::invalid(error.to_string()))?;
            }
            let mut payload = vec![0_u8; length];
            self.stream
                .read_exact(&mut payload)
                .map_err(|error| Phase3Error::invalid(error.to_string()))?;
            if masked {
                for (index, byte) in payload.iter_mut().enumerate() {
                    *byte ^= mask[index % 4];
                }
            }
            match opcode {
                0x1 => {
                    let value = serde_json::from_slice(&payload).map_err(|error| {
                        Phase3Error::invalid(format!("malformed WebSocket JSON: {error}"))
                    })?;
                    return Ok(Some(value));
                }
                0x8 => return Err(Phase3Error::invalid("WebSocket peer closed the connection")),
                0x9 => self.send_frame(0xA, &payload)?,
                0xA => {}
                _ => return Err(Phase3Error::invalid("unsupported WebSocket frame opcode")),
            }
        }
    }

    fn enable_secure_channel(&mut self, channel: SecureChannel) {
        self.secure_channel = Some(channel);
    }
}

fn authentication_hello_envelope(
    state: &DurableRunnerState,
    config: &DurableRunnerConfig,
    credential_id: &str,
    client_nonce: &str,
) -> Value {
    let unacked_range = state
        .outbox
        .first()
        .zip(state.outbox.last())
        .map(|(first, last)| json!([first.source_seq, last.source_seq]));
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "auth_hello",
        "payload": {
            "credentialId": credential_id,
            "clientNonce": client_nonce,
            "protocolMin": 1,
            "protocolMax": 1,
            "runnerInstanceId": state.runner_instance_id,
            "runnerVersion": config.runner_version,
            "runnerDigest": config.runner_digest,
            "environmentLeaseId": state.environment_lease_id,
            "runId": state.run_id,
            "normalizedSessionId": state.normalized_session_id,
            "turnId": state.turn_id,
            "itemId": state.item_id,
            "sandboxProvider": "standalone_mock",
            "platform": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "hostname": "redacted-standalone-runner",
            },
            "drivers": [{
                "kind": "fake",
                "version": "1.0.0",
                "capabilities": { "resume": true, "interrupt": true },
            }],
            "resume": {
                "lastControllerCommandSeq": state.last_controller_command_seq,
                "nextSourceEventSeq": state.next_source_seq,
                "ackedSourceSeq": state.acked_source_seq,
                "unackedEventRange": unacked_range,
            },
        },
    })
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, Phase3Error> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Phase3Error::invalid(format!("{field} is required")))
}

fn authenticate_transport(
    client: &mut WsClient,
    state: &DurableRunnerState,
    config: &DurableRunnerConfig,
    credential: &CredentialMaterial,
    credential_kind: &str,
    expected_lease_id: Option<&str>,
    expected_expires_at_unix_ms: Option<u64>,
    expected_revocation_epoch: Option<u64>,
) -> Result<(), Phase3Error> {
    let client_nonce = random_suffix()?;
    client.send_plain_json(&authentication_hello_envelope(
        state,
        config,
        &credential.credential_id,
        &client_nonce,
    ))?;
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(2))
        .ok_or_else(|| Phase3Error::invalid("transport authentication deadline overflowed"))?;
    let challenge = loop {
        match client.receive_plain_json()? {
            Some(value) => break value,
            None if Instant::now() < deadline => continue,
            None => return Err(Phase3Error::invalid("transport authentication timed out")),
        }
    };
    if challenge.get("protocol").and_then(Value::as_str) != Some(PROTOCOL)
        || challenge.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || challenge.get("kind").and_then(Value::as_str) != Some("auth_challenge")
    {
        return Err(Phase3Error::invalid(
            "core did not return an authenticated transport challenge",
        ));
    }
    let payload = challenge
        .get("payload")
        .ok_or_else(|| Phase3Error::invalid("authentication challenge payload is required"))?;
    for (field, expected) in [
        ("credentialId", credential.credential_id.as_str()),
        ("credentialKind", credential_kind),
        ("clientNonce", client_nonce.as_str()),
        ("runnerInstanceId", state.runner_instance_id.as_str()),
        ("environmentLeaseId", state.environment_lease_id.as_str()),
        ("runId", state.run_id.as_str()),
        ("normalizedSessionId", state.normalized_session_id.as_str()),
        ("turnId", state.turn_id.as_str()),
        ("itemId", state.item_id.as_str()),
        ("runnerVersion", config.runner_version.as_str()),
        ("runnerDigest", config.runner_digest.as_str()),
    ] {
        if required_string(payload, field)? != expected {
            return Err(Phase3Error::invalid(format!(
                "authentication challenge {field} does not match the requested session"
            )));
        }
    }
    required_string(payload, "serverNonce")?;
    required_string(payload, "credentialExpiresAt")?;
    if payload.get("selectedVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(Phase3Error::invalid(
            "authentication challenge selected an unsupported protocol",
        ));
    }
    let expires_at_unix_ms = payload
        .get("credentialExpiresAtUnixMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            Phase3Error::invalid("authentication challenge credential expiry is required")
        })?;
    if expires_at_unix_ms <= current_unix_ms()? {
        return Err(Phase3Error::invalid(
            "transport credential expired before authentication completed",
        ));
    }
    if expected_expires_at_unix_ms.is_some_and(|expected| expected != expires_at_unix_ms) {
        return Err(Phase3Error::invalid(
            "authentication challenge changed the connection lease expiry",
        ));
    }
    let revocation_epoch = payload
        .get("revocationEpoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| Phase3Error::invalid("authentication revocation epoch is required"))?;
    if expected_revocation_epoch.is_some_and(|expected| expected != revocation_epoch) {
        return Err(Phase3Error::invalid(
            "authentication challenge changed the connection lease revocation epoch",
        ));
    }
    match (expected_lease_id, payload.get("credentialLeaseId")) {
        (Some(expected), Some(Value::String(actual))) if actual == expected => {}
        (None, Some(Value::Null)) => {}
        _ => {
            return Err(Phase3Error::invalid(
                "authentication challenge lease identity does not match the credential",
            ))
        }
    }

    let server_proof = required_string(payload, "serverProof")?.to_owned();
    let mut authenticated_payload = payload.clone();
    authenticated_payload
        .as_object_mut()
        .ok_or_else(|| Phase3Error::invalid("authentication challenge payload must be an object"))?
        .remove("serverProof");
    let canonical_challenge = canonical_json(&authenticated_payload);
    verify_hmac_hex(
        &credential.auth_key,
        "paperclip-runner-server-proof-v1",
        &[canonical_challenge.as_bytes()],
        &server_proof,
    )?;
    let client_proof = hex_encode(&hmac_domain(
        &credential.auth_key,
        "paperclip-runner-client-proof-v1",
        &[canonical_challenge.as_bytes(), server_proof.as_bytes()],
    ));
    client.send_plain_json(&json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "auth_response",
        "payload": {
            "credentialId": credential.credential_id,
            "clientNonce": client_nonce,
            "serverNonce": required_string(payload, "serverNonce")?,
            "clientProof": client_proof,
        },
    }))?;
    let secure_channel = SecureChannel::new(
        &credential.auth_key,
        canonical_challenge.as_bytes(),
        server_proof.as_bytes(),
        client_proof.as_bytes(),
    )?;
    client.enable_secure_channel(secure_channel);
    Ok(())
}

fn send_outbox(client: &mut WsClient, state: &DurableRunnerState) -> Result<(), Phase3Error> {
    for event in &state.outbox {
        client.send_json(&event.envelope)?;
    }
    Ok(())
}

fn fail_revocation_flush(
    state: &mut DurableRunnerState,
    store: &DurableStateStore,
    reason: impl AsRef<str>,
) -> Result<(), Phase3Error> {
    state.recoverable_failure = Some("revocation_flush_requires_bootstrap".to_owned());
    state.record_diagnostic(format!(
        "revocation flush interrupted; unacked durable events require a fresh bootstrap: {}",
        reason.as_ref()
    ));
    store.save(state)?;
    Err(Phase3Error::invalid(
        "revocation flush interrupted; unacked durable events require a fresh bootstrap",
    ))
}

struct ConnectionMetadata {
    connection_id: String,
    lease_id: String,
    lease_expires_at_unix_ms: u64,
    revocation_epoch: u64,
}

fn validate_control_identity(
    value: &Value,
    state: &DurableRunnerState,
    connection: Option<&ConnectionMetadata>,
) -> Result<(), Phase3Error> {
    if value.get("protocol").and_then(Value::as_str) != Some(PROTOCOL)
        || value.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
    {
        return Err(Phase3Error::invalid(
            "control envelope protocol identity is invalid",
        ));
    }
    for (field, expected) in [
        ("runnerInstanceId", state.runner_instance_id.as_str()),
        ("environmentLeaseId", state.environment_lease_id.as_str()),
        ("runId", state.run_id.as_str()),
        ("normalizedSessionId", state.normalized_session_id.as_str()),
        ("turnId", state.turn_id.as_str()),
        ("itemId", state.item_id.as_str()),
    ] {
        if required_string(value, field)? != expected {
            return Err(Phase3Error::invalid(format!(
                "control envelope {field} does not match the authenticated session"
            )));
        }
    }
    if let Some(connection) = connection {
        if required_string(value, "connectionId")? != connection.connection_id
            || required_string(value, "connectionLeaseId")? != connection.lease_id
        {
            return Err(Phase3Error::invalid(
                "control envelope connection lease identity does not match the authenticated session",
            ));
        }
        if current_unix_ms()? >= connection.lease_expires_at_unix_ms {
            return Err(Phase3Error::invalid(
                "connection lease expired before the control envelope was applied",
            ));
        }
    }
    Ok(())
}

fn validate_welcome<'a>(
    value: &'a Value,
    state: &DurableRunnerState,
) -> Result<(&'a Value, ConnectionMetadata), Phase3Error> {
    validate_control_identity(value, state, None)?;
    if value.get("kind").and_then(Value::as_str) != Some("welcome") {
        return Err(Phase3Error::invalid("expected a PRP v1 welcome envelope"));
    }
    let connection_id = required_string(value, "connectionId")?.to_owned();
    let lease_id = required_string(value, "connectionLeaseId")?.to_owned();
    let payload = value
        .get("payload")
        .ok_or_else(|| Phase3Error::invalid("welcome payload is required"))?;
    if payload.get("selectedVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(Phase3Error::invalid(
            "core selected an unsupported protocol version",
        ));
    }
    if required_string(payload, "connectionLeaseId")? != lease_id {
        return Err(Phase3Error::invalid(
            "welcome lease identity is internally inconsistent",
        ));
    }
    required_string(payload, "connectionLeaseExpiresAt")?;
    let lease_expires_at_unix_ms = payload
        .get("connectionLeaseExpiresAtUnixMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| Phase3Error::invalid("welcome lease expiry is required"))?;
    if lease_expires_at_unix_ms <= current_unix_ms()? {
        return Err(Phase3Error::invalid(
            "welcome carried an already-expired connection lease",
        ));
    }
    let revocation_epoch = payload
        .get("connectionLeaseRevocationEpoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| Phase3Error::invalid("welcome revocation epoch is required"))?;
    let binding = payload
        .get("leaseBinding")
        .ok_or_else(|| Phase3Error::invalid("welcome lease binding is required"))?;
    for (field, expected) in [
        ("runnerInstanceId", state.runner_instance_id.as_str()),
        ("environmentLeaseId", state.environment_lease_id.as_str()),
        ("runId", state.run_id.as_str()),
        ("normalizedSessionId", state.normalized_session_id.as_str()),
    ] {
        if required_string(binding, field)? != expected {
            return Err(Phase3Error::invalid(format!(
                "welcome lease binding {field} does not match the authenticated session"
            )));
        }
    }
    if binding.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(Phase3Error::invalid(
            "welcome lease binding protocol is invalid",
        ));
    }
    Ok((
        payload,
        ConnectionMetadata {
            connection_id,
            lease_id,
            lease_expires_at_unix_ms,
            revocation_epoch,
        },
    ))
}

pub fn run_durable_runner(
    config: DurableRunnerConfig,
    bootstrap_ticket: BootstrapTicket,
) -> Result<(), Phase3Error> {
    if config.p0_reserve_bytes >= config.max_outbox_bytes {
        return Err(Phase3Error::invalid(
            "P0 reserve must be smaller than the outbox limit",
        ));
    }
    let store = DurableStateStore::new(&config.state_dir)?;
    let (mut state, recovered) = store.load_or_create(&config)?;
    if recovered && state.lifecycle == "revoked" && state.outbox.is_empty() {
        // A fully flushed revocation is durable and terminal. A revoked state with pending
        // events may use a newly issued bootstrap only to finish delivery below.
        drop(bootstrap_ticket);
        return Ok(());
    }
    // Resolve once before authentication. Reconnects use only this validated,
    // concrete address set, so DNS cannot redirect a retry.
    let target = ResolvedWsTarget::resolve(&config.connect_url)?;
    if recovered && state.lifecycle == "revoked" {
        state.reconnect_count += 1;
        state.record_diagnostic(
            "revoked runner restored with a fresh bootstrap for durable outbox flush only",
        );
        store.save(&state)?;
    } else if recovered {
        state.reconnect_count += 1;
        state.record_diagnostic("runner process restored the same durable identity");
        enqueue_event(
            &mut state,
            &config,
            "runner.reconciled",
            0,
            json!({
                "runnerInstanceId": config.runner_instance_id,
                "normalizedSessionId": config.normalized_session_id,
                "turnId": config.turn_id,
                "itemId": config.item_id,
                "outcome": "same_durable_session_resumed",
            }),
            None,
        )?;
        store.save(&state)?;
    }
    let mut bootstrap_ticket = Some(bootstrap_ticket);
    let mut connection_lease_token: Option<SensitiveString> = None;
    let mut connection_lease_id: Option<String> = None;
    let mut connection_lease_expires_at_unix_ms: Option<u64> = None;
    let mut connection_lease_revocation_epoch: Option<u64> = None;
    let started = Instant::now();

    loop {
        if started.elapsed() > config.max_runtime {
            state.recoverable_failure = Some("transport_reconnect_deadline_exceeded".to_owned());
            state.lifecycle = "recoverable_failure".to_owned();
            state.record_diagnostic("transport reconnect deadline exceeded");
            store.save(&state)?;
            return Err(Phase3Error::invalid(
                "transport reconnect deadline exceeded; durable state is preserved",
            ));
        }
        if connection_lease_expires_at_unix_ms
            .is_some_and(|expires_at| current_unix_ms().is_ok_and(|now| now >= expires_at))
        {
            state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
            state.lifecycle = "recoverable_failure".to_owned();
            state.record_diagnostic(
                "connection lease expired; a fresh bootstrap may resume this state",
            );
            store.save(&state)?;
            connection_lease_token.take();
            return Err(Phase3Error::invalid(
                "connection lease expired; durable state requires a fresh bootstrap",
            ));
        }
        let (credential_token, credential_kind) = connection_lease_token
            .as_ref()
            .map(|token| (token.expose(), "lease"))
            .or_else(|| {
                bootstrap_ticket
                    .as_ref()
                    .map(|ticket| (ticket.expose(), "bootstrap"))
            })
            .ok_or_else(|| {
                Phase3Error::invalid(
                    "transport capability is unavailable; a fresh runner bootstrap is required",
                )
            })?;
        let credential = CredentialMaterial::from_token(credential_token);
        let mut client = match WsClient::connect(&target, config.max_frame_bytes) {
            Ok(client) => client,
            Err(error) => {
                let text = error.to_string();
                state.record_diagnostic(format!("transport reconnect scheduled: {text}"));
                store.save(&state)?;
                thread::sleep(config.reconnect_delay);
                continue;
            }
        };
        if let Err(error) = authenticate_transport(
            &mut client,
            &state,
            &config,
            &credential,
            credential_kind,
            connection_lease_id.as_deref(),
            connection_lease_expires_at_unix_ms,
            connection_lease_revocation_epoch,
        ) {
            state.record_diagnostic(format!(
                "transport peer authentication failed closed: {error}"
            ));
            store.save(&state)?;
            thread::sleep(config.reconnect_delay);
            continue;
        }
        let mut welcome = loop {
            match client.receive_json() {
                Ok(Some(value)) => break value,
                Ok(None) if started.elapsed() <= config.max_runtime => continue,
                Ok(None) => {
                    return Err(Phase3Error::invalid("welcome timed out"));
                }
                Err(error) => {
                    state.record_diagnostic(error.to_string());
                    store.save(&state)?;
                    thread::sleep(config.reconnect_delay);
                    continue;
                }
            }
        };
        let (_, connection) = validate_welcome(&welcome, &state)?;
        let next_lease_token = match welcome.pointer_mut("/payload/connectionLeaseToken") {
            Some(Value::String(value)) => {
                let token = std::mem::take(value);
                *value = "[REDACTED]".to_owned();
                Some(SensitiveString::new(token))
            }
            _ => None,
        };
        if credential_kind == "bootstrap" && next_lease_token.is_none() {
            return Err(Phase3Error::invalid(
                "authenticated bootstrap welcome did not issue a connection lease",
            ));
        }
        if let Some(token) = next_lease_token {
            connection_lease_token = Some(token);
        }
        connection_lease_id = Some(connection.lease_id.clone());
        connection_lease_expires_at_unix_ms = Some(connection.lease_expires_at_unix_ms);
        connection_lease_revocation_epoch = Some(connection.revocation_epoch);
        // A bootstrap ticket is one-use. Clear it only after the mutually authenticated,
        // encrypted welcome has exchanged it for a bound connection lease.
        bootstrap_ticket.take();
        let payload = welcome
            .get("payload")
            .ok_or_else(|| Phase3Error::invalid("welcome payload is required"))?;
        if let Some(acked_source_seq) = payload.get("ackedSourceSeq").and_then(Value::as_u64) {
            state.apply_ack(acked_source_seq)?;
        }
        state.lifecycle =
            if state.lifecycle == "connecting" || state.lifecycle == "recoverable_failure" {
                "ready".to_owned()
            } else {
                state.lifecycle.clone()
            };
        state.recoverable_failure = None;
        store.save(&state)?;

        let initial_delivery = (|| -> Result<(), Phase3Error> {
            if state.lifecycle != "revoked" {
                if let Some(commands) = payload.get("pendingCommands").and_then(Value::as_array) {
                    for command in commands {
                        match process_command(&mut state, &store, &config, command) {
                            Ok(processed) => {
                                client.send_json(&command_result_envelope(&state, &processed))?
                            }
                            Err(error) => {
                                state.record_diagnostic(error.to_string());
                                store.save(&state)?;
                            }
                        }
                    }
                }
            }
            send_outbox(&mut client, &state)
        })();
        if let Err(error) = initial_delivery {
            state.record_diagnostic(error.to_string());
            state.reconnect_count += 1;
            store.save(&state)?;
            thread::sleep(config.reconnect_delay);
            continue;
        }

        let mut revoke_deadline: Option<Instant> = None;
        let disconnected = loop {
            if (state.stop_after_flush || state.lifecycle == "revoked") && state.outbox.is_empty() {
                state.lifecycle = if state.lifecycle == "revoked" {
                    "revoked".to_owned()
                } else {
                    "stopped".to_owned()
                };
                store.save(&state)?;
                connection_lease_token.take();
                bootstrap_ticket.take();
                return Ok(());
            }
            if revoke_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return fail_revocation_flush(
                    &mut state,
                    &store,
                    "revocation flush deadline elapsed",
                );
            }
            if current_unix_ms()? >= connection.lease_expires_at_unix_ms {
                state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
                state.lifecycle = "recoverable_failure".to_owned();
                state.record_diagnostic(
                    "connection lease expired before more control data could be accepted",
                );
                store.save(&state)?;
                connection_lease_token.take();
                return Err(Phase3Error::invalid(
                    "connection lease expired; durable state requires a fresh bootstrap",
                ));
            }
            match client.receive_json() {
                Ok(None) => continue,
                Err(error) => {
                    if state.lifecycle == "revoked" {
                        return fail_revocation_flush(&mut state, &store, error.to_string());
                    }
                    state.record_diagnostic(error.to_string());
                    state.reconnect_count += 1;
                    store.save(&state)?;
                    break true;
                }
                Ok(Some(message)) => {
                    if let Err(error) =
                        validate_control_identity(&message, &state, Some(&connection))
                    {
                        state.record_diagnostic(format!(
                            "control envelope identity mismatch failed closed: {error}"
                        ));
                        state.reconnect_count += 1;
                        store.save(&state)?;
                        break true;
                    }
                    match message.get("kind").and_then(Value::as_str) {
                        Some("ack") => {
                            let acked = message
                                .pointer("/payload/ackedSourceSeq")
                                .and_then(Value::as_u64)
                                .ok_or_else(|| Phase3Error::invalid("ACK cursor is required"))?;
                            state.apply_ack(acked)?;
                            store.save(&state)?;
                        }
                        Some("command") => {
                            let command = message.get("payload").ok_or_else(|| {
                                Phase3Error::invalid("command payload is required")
                            })?;
                            match process_command(&mut state, &store, &config, command) {
                                Ok(processed) => {
                                    let delivery = client
                                        .send_json(&command_result_envelope(&state, &processed))
                                        .and_then(|()| send_outbox(&mut client, &state));
                                    if let Err(error) = delivery {
                                        if state.lifecycle == "revoked" {
                                            return fail_revocation_flush(
                                                &mut state,
                                                &store,
                                                error.to_string(),
                                            );
                                        }
                                        state.record_diagnostic(error.to_string());
                                        state.reconnect_count += 1;
                                        store.save(&state)?;
                                        break true;
                                    }
                                }
                                Err(error) => {
                                    state.record_diagnostic(error.to_string());
                                    store.save(&state)?;
                                }
                            }
                        }
                        Some("revoke") => {
                            let revocation_epoch = message
                                .pointer("/payload/revocationEpoch")
                                .and_then(Value::as_u64)
                                .ok_or_else(|| {
                                    Phase3Error::invalid("revoke revocation epoch is required")
                                })?;
                            if revocation_epoch <= connection.revocation_epoch {
                                return Err(Phase3Error::invalid(
                                    "revoke did not advance the authenticated revocation epoch",
                                ));
                            }
                            state.lifecycle = "revoked".to_owned();
                            state.stop_after_flush = true;
                            revoke_deadline.get_or_insert_with(|| {
                                Instant::now()
                                    .checked_add(REVOKE_FLUSH_TIMEOUT)
                                    .unwrap_or_else(Instant::now)
                            });
                            state.record_diagnostic(
                                "connection lease revoked; flushing durable events",
                            );
                            store.save(&state)?;
                            if let Err(error) = send_outbox(&mut client, &state) {
                                return fail_revocation_flush(
                                    &mut state,
                                    &store,
                                    error.to_string(),
                                );
                            }
                        }
                        Some("ping") => {
                            let pong = client.send_json(&json!({
                                "protocol": PROTOCOL,
                                "version": PROTOCOL_VERSION,
                                "kind": "pong",
                                "runnerInstanceId": state.runner_instance_id,
                                "payload": {
                                    "lifecycle": state.lifecycle,
                                    "outboxBytes": state.outbox_bytes(),
                                    "ackedSourceSeq": state.acked_source_seq,
                                },
                            }));
                            if let Err(error) = pong {
                                if state.lifecycle == "revoked" {
                                    return fail_revocation_flush(
                                        &mut state,
                                        &store,
                                        error.to_string(),
                                    );
                                }
                                state.record_diagnostic(error.to_string());
                                state.reconnect_count += 1;
                                store.save(&state)?;
                                break true;
                            }
                        }
                        _ => {
                            state.record_diagnostic(
                                "malformed or unsupported control frame closed the connection",
                            );
                            if state.lifecycle == "revoked" {
                                return fail_revocation_flush(
                                    &mut state,
                                    &store,
                                    "malformed or unsupported control frame",
                                );
                            }
                            store.save(&state)?;
                            break true;
                        }
                    }
                }
            }
        };
        if disconnected {
            thread::sleep(config.reconnect_delay);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{mpsc, Mutex};

    static ENVIRONMENT_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn config(root: &Path) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1:1/phase3/connect".to_owned(),
            state_dir: root.to_path_buf(),
            runner_instance_id: "runner_phase3_stable".to_owned(),
            environment_lease_id: "lease_phase3_stable".to_owned(),
            run_id: "run_phase3_stable".to_owned(),
            normalized_session_id: "session_phase3_stable".to_owned(),
            turn_id: "turn_phase3_stable".to_owned(),
            item_id: "item_phase3_stable".to_owned(),
            runner_version: "0.3.0".to_owned(),
            runner_digest: "sha256:phase3-approved".to_owned(),
            fake_harness_path: None,
            fake_harness_script_path: None,
            max_outbox_bytes: 16 * 1024,
            p0_reserve_bytes: 8 * 1024,
            max_frame_bytes: 1024 * 1024,
            reconnect_delay: Duration::from_millis(1),
            max_runtime: Duration::from_millis(10),
        }
    }

    fn temporary_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "paperclip-runner-phase3-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn command(id: &str, sequence: u64, command_type: &str, payload: Value) -> Value {
        json!({
            "schema": "paperclip.prp.command.v1",
            "commandId": id,
            "controllerSeq": sequence,
            "type": command_type,
            "issuedAt": deterministic_time(sequence),
            "payload": payload,
        })
    }

    fn read_masked_client_text(stream: &mut TcpStream) -> (Value, Vec<u8>) {
        let mut header = [0_u8; 2];
        stream.read_exact(&mut header).unwrap();
        assert_eq!(header[0] & 0x0f, 0x1);
        assert_ne!(header[1] & 0x80, 0);
        let mut captured = header.to_vec();
        let mut length = usize::from(header[1] & 0x7f);
        if length == 126 {
            let mut extended = [0_u8; 2];
            stream.read_exact(&mut extended).unwrap();
            captured.extend_from_slice(&extended);
            length = usize::from(u16::from_be_bytes(extended));
        } else if length == 127 {
            let mut extended = [0_u8; 8];
            stream.read_exact(&mut extended).unwrap();
            captured.extend_from_slice(&extended);
            length = usize::try_from(u64::from_be_bytes(extended)).unwrap();
        }
        let mut mask = [0_u8; 4];
        stream.read_exact(&mut mask).unwrap();
        captured.extend_from_slice(&mask);
        let mut payload = vec![0_u8; length];
        stream.read_exact(&mut payload).unwrap();
        captured.extend_from_slice(&payload);
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % mask.len()];
        }
        (serde_json::from_slice(&payload).unwrap(), captured)
    }

    fn send_server_json(stream: &mut TcpStream, value: &Value) {
        let payload = serde_json::to_vec(value).unwrap();
        let mut frame = vec![0x81];
        if payload.len() <= 125 {
            frame.push(payload.len() as u8);
        } else if payload.len() <= u16::MAX as usize {
            frame.push(126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        frame.extend_from_slice(&payload);
        stream.write_all(&frame).unwrap();
        stream.flush().unwrap();
    }

    #[test]
    fn durable_state_restores_identity_outbox_and_cumulative_ack() {
        let root = temporary_root("restore");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, recovered) = store.load_or_create(&config).unwrap();
        assert!(!recovered);
        let session_id = state.normalized_session_id.clone();
        enqueue_event(
            &mut state,
            &config,
            "session.started",
            0,
            json!({ "session": session_id }),
            None,
        )
        .unwrap();
        enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "status": "succeeded" }),
            None,
        )
        .unwrap();
        let first_event_id = state.outbox[0].source_event_id.clone();
        store.save(&state).unwrap();

        let (mut restored, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(restored.runner_instance_id, config.runner_instance_id);
        assert_eq!(restored.normalized_session_id, config.normalized_session_id);
        assert_eq!(restored.outbox[0].source_event_id, first_event_id);
        restored.apply_ack(1).unwrap();
        assert_eq!(restored.acked_source_seq, 1);
        assert_eq!(restored.outbox.len(), 1);
        assert!(restored.apply_ack(0).is_err());
        assert!(restored.apply_ack(3).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_command_has_one_logical_effect_and_no_new_events() {
        let root = temporary_root("command-dedupe");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let value = command("command_prepare", 1, "run.prepare", json!({}));
        let first = process_command(&mut state, &store, &config, &value).unwrap();
        assert!(first.command_digest.starts_with("sha256:"));
        assert_eq!(first.command_digest.len(), "sha256:".len() + 64);
        let event_count = state.outbox.len();
        let second = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(first.result, second.result);
        assert_eq!(first.logical_effect_count, 1);
        assert_eq!(state.outbox.len(), event_count);
        assert_eq!(state.processed_commands.len(), 1);
        assert!(process_command(
            &mut state,
            &store,
            &config,
            &command(
                "command_prepare",
                1,
                "run.prepare",
                json!({ "changed": true })
            )
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn processed_command_ledger_compacts_to_a_fixed_bound_without_reenabling_effects() {
        let root = temporary_root("command-compaction");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        for sequence in 1..=256_u64 {
            let command_id = format!("command_compaction_{sequence:04}");
            process_command(
                &mut state,
                &store,
                &config,
                &command(&command_id, sequence, "unsupported.compaction", json!({})),
            )
            .unwrap();
        }
        let size_after_256 = fs::metadata(store.path()).unwrap().len();
        for sequence in 257..=512_u64 {
            let command_id = format!("command_compaction_{sequence:04}");
            process_command(
                &mut state,
                &store,
                &config,
                &command(&command_id, sequence, "unsupported.compaction", json!({})),
            )
            .unwrap();
        }
        let size_after_512 = fs::metadata(store.path()).unwrap().len();
        assert_eq!(
            state.processed_commands.len(),
            MAX_RECENT_PROCESSED_COMMANDS
        );
        assert_eq!(state.compacted_command_count, 384);
        assert_eq!(
            state.compacted_command_filter.len(),
            COMPACTED_COMMAND_FILTER_BYTES * 2
        );
        assert!(size_after_512 <= size_after_256 + 1024);

        let replay = process_command(
            &mut state,
            &store,
            &config,
            &command(
                "command_compaction_0001",
                513,
                "run.prepare",
                json!({ "changed": true }),
            ),
        )
        .unwrap();
        assert_eq!(replay.status, "rejected");
        assert_eq!(replay.logical_effect_count, 0);
        assert_eq!(state.last_controller_command_seq, 513);
        assert!(!state
            .outbox
            .iter()
            .any(|event| event.event_type == "workspace.ready"));
        let (restored, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(
            restored.processed_commands.len(),
            MAX_RECENT_PROCESSED_COMMANDS
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malicious_loopback_listener_gets_no_capability_and_cannot_forge_control() {
        let root = temporary_root("malicious-loopback");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (state, _) = store.load_or_create(&config).unwrap();
        let secret = "bootstrap-malicious-listener-regression";
        let credential = CredentialMaterial::from_token(secret);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (wire_sender, wire_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            stream
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
                )
                .unwrap();
            stream.flush().unwrap();
            let (hello, frame) = read_masked_client_text(&mut stream);
            let hello_payload = hello.get("payload").unwrap();
            let challenge_payload = json!({
                "credentialId": hello_payload.get("credentialId").unwrap(),
                "credentialKind": "bootstrap",
                "clientNonce": hello_payload.get("clientNonce").unwrap(),
                "serverNonce": "malicious-server-nonce",
                "runnerInstanceId": hello_payload.get("runnerInstanceId").unwrap(),
                "environmentLeaseId": hello_payload.get("environmentLeaseId").unwrap(),
                "runId": hello_payload.get("runId").unwrap(),
                "normalizedSessionId": hello_payload.get("normalizedSessionId").unwrap(),
                "turnId": hello_payload.get("turnId").unwrap(),
                "itemId": hello_payload.get("itemId").unwrap(),
                "runnerVersion": hello_payload.get("runnerVersion").unwrap(),
                "runnerDigest": hello_payload.get("runnerDigest").unwrap(),
                "selectedVersion": PROTOCOL_VERSION,
                "credentialLeaseId": Value::Null,
                "credentialExpiresAt": "2099-01-01T00:00:00.000Z",
                "credentialExpiresAtUnixMs": 4_070_908_800_000_u64,
                "revocationEpoch": 0,
                "serverProof": "00".repeat(32),
            });
            send_server_json(
                &mut stream,
                &json!({
                    "protocol": PROTOCOL,
                    "version": PROTOCOL_VERSION,
                    "kind": "auth_challenge",
                    "payload": challenge_payload,
                }),
            );
            request.extend_from_slice(&frame);
            wire_sender.send(request).unwrap();
        });
        let target =
            resolve_ws_target_with(&format!("ws://{address}/phase3/connect"), |_host, _port| {
                Ok(vec![address])
            })
            .unwrap();
        let mut client = WsClient::connect(&target, config.max_frame_bytes).unwrap();
        let error = authenticate_transport(
            &mut client,
            &state,
            &config,
            &credential,
            "bootstrap",
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("transport authentication proof is invalid"));
        assert!(client.secure_channel.is_none());
        let wire = wire_receiver.recv().unwrap();
        assert!(!wire
            .windows(secret.len())
            .any(|window| window == secret.as_bytes()));
        assert_eq!(state.acked_source_seq, 0);
        assert!(state.processed_commands.is_empty());
        server.join().unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn non_terminal_command_failure_restores_exact_prior_state_on_every_retry() {
        let root = temporary_root("command-atomic-p1");
        let mut config = config(&root);
        let sizing_state = DurableRunnerState::new(&config);
        let accepted_size = serde_json::to_vec(&event_envelope(
            &sizing_state,
            1,
            "turn.accepted",
            0,
            json!({ "turnId": sizing_state.turn_id, "sameSession": true }),
            None,
        ))
        .unwrap()
        .len();
        let started_size = serde_json::to_vec(&event_envelope(
            &sizing_state,
            2,
            "item.started",
            1,
            json!({ "kind": "assistant_message" }),
            Some(&sizing_state.item_id),
        ))
        .unwrap()
        .len();
        let non_p0_limit = accepted_size + started_size - 1;
        config.p0_reserve_bytes = 8 * 1024;
        config.max_outbox_bytes = non_p0_limit + config.p0_reserve_bytes;

        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let before_state = serde_json::to_vec(&state).unwrap();
        let before_file = fs::read(store.path()).unwrap();
        let value = command("command_tight_p1", 1, "turn.start", json!({}));

        let first_error = process_command(&mut state, &store, &config, &value).unwrap_err();
        assert_eq!(serde_json::to_vec(&state).unwrap(), before_state);
        assert_eq!(fs::read(store.path()).unwrap(), before_file);
        let second_error = process_command(&mut state, &store, &config, &value).unwrap_err();
        assert_eq!(second_error, first_error);
        assert_eq!(serde_json::to_vec(&state).unwrap(), before_state);
        assert_eq!(fs::read(store.path()).unwrap(), before_file);
        assert!(state.outbox.is_empty());
        assert!(state.processed_commands.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn p0_exhaustion_commits_only_unrecoverable_result_and_retry_is_stable() {
        let root = temporary_root("command-atomic-p0");
        let mut probe_config = config(&root);
        probe_config.max_outbox_bytes = 128 * 1024;
        probe_config.p0_reserve_bytes = 1;
        let mut probe = DurableRunnerState::new(&probe_config);
        execute_command_effect(
            &mut probe,
            &probe_config,
            "turn.start",
            &json!({ "text": "Phase 3" }),
        )
        .unwrap();
        assert!(probe.outbox.len() >= 5);
        let bytes_before_mandatory_p0 = probe
            .outbox
            .iter()
            .take(4)
            .map(|event| event.byte_size)
            .sum::<usize>();

        let mut config = config(&root);
        config.p0_reserve_bytes = 1;
        config.max_outbox_bytes = bytes_before_mandatory_p0 + 1;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let value = command(
            "command_tight_p0",
            1,
            "turn.start",
            json!({ "text": "Phase 3" }),
        );

        let first = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(first.status, "failed");
        assert_eq!(first.logical_effect_count, 0);
        assert_eq!(state.lifecycle, "unrecoverable");
        assert_eq!(
            state.unrecoverable_outcome.as_deref(),
            Some("p0_storage_exhausted")
        );
        assert_eq!(state.next_source_seq, 1);
        assert!(state.outbox.is_empty());
        assert_eq!(state.processed_commands.len(), 1);
        let after_first = serde_json::to_vec(&state).unwrap();
        let second = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(second.result, first.result);
        assert_eq!(serde_json::to_vec(&state).unwrap(), after_first);
        let (persisted, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert!(persisted.outbox.is_empty());
        assert_eq!(persisted.next_source_seq, 1);
        assert_eq!(persisted.processed_commands.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pressure_coalesces_p2_preserves_p0_and_stays_bounded() {
        let root = temporary_root("pressure");
        let mut config = config(&root);
        config.max_outbox_bytes = 12 * 1024;
        config.p0_reserve_bytes = 6 * 1024;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        process_command(
            &mut state,
            &store,
            &config,
            &command("command_pressure", 1, "fault.storage_pressure", json!({})),
        )
        .unwrap();
        assert!(state.backpressure);
        assert!(state.outbox_bytes() <= config.max_outbox_bytes);
        assert_eq!(
            state
                .outbox
                .iter()
                .filter(|event| event.event_type == "item.delta")
                .count(),
            1
        );
        assert!(state
            .outbox
            .iter()
            .any(|event| event.priority == 0 && event.event_type == "runner.backpressure"));
        let persisted = fs::read_to_string(store.path()).unwrap();
        assert!(!persisted.contains("must-not-persist"));
        assert!(persisted.contains("[REDACTED]"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_coalesced_p2_retains_prior_event_and_never_exceeds_bounds() {
        let root = temporary_root("oversized-p2-coalesce");
        let mut config = config(&root);
        config.max_outbox_bytes = 8 * 1024;
        config.p0_reserve_bytes = 4 * 1024;
        let mut state = DurableRunnerState::new(&config);
        let item_id = state.item_id.clone();
        enqueue_event(
            &mut state,
            &config,
            "item.delta",
            2,
            json!({ "text": "small durable delta" }),
            Some(&item_id),
        )
        .unwrap();
        let prior = state.outbox[0].clone();

        enqueue_event(
            &mut state,
            &config,
            "item.delta",
            2,
            json!({ "text": "x".repeat(16 * 1024) }),
            Some(&item_id),
        )
        .unwrap();

        let retained = state
            .outbox
            .iter()
            .find(|event| event.event_type == "item.delta")
            .unwrap();
        assert_eq!(retained, &prior);
        assert!(state.backpressure);
        assert!(state
            .outbox
            .iter()
            .any(|event| event.priority == 0 && event.event_type == "runner.backpressure"));
        assert!(state.outbox_bytes() <= config.max_outbox_bytes);
        assert!(state.peak_outbox_bytes <= config.max_outbox_bytes);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn drain_rejects_new_turn_and_revoke_preserves_unacked_events() {
        let root = temporary_root("drain");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        process_command(
            &mut state,
            &store,
            &config,
            &command("command_drain", 1, "runner.drain", json!({})),
        )
        .unwrap();
        let before = state.outbox.len();
        let rejected = process_command(
            &mut state,
            &store,
            &config,
            &command("command_turn", 2, "turn.start", json!({})),
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.logical_effect_count, 0);
        assert_eq!(state.outbox.len(), before);
        state.lifecycle = "revoked".to_owned();
        store.save(&state).unwrap();
        let (restored, _) = store.load_or_create(&config).unwrap();
        assert_eq!(restored.lifecycle, "revoked");
        assert_eq!(restored.outbox.len(), before);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_revocation_flush_requires_a_fresh_bootstrap() {
        let root = temporary_root("revocation-flush-failure");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "runTerminalState": "succeeded" }),
            None,
        )
        .unwrap();
        state.lifecycle = "revoked".to_owned();
        state.stop_after_flush = true;
        store.save(&state).unwrap();

        let error = fail_revocation_flush(&mut state, &store, "socket closed").unwrap_err();

        assert!(error.to_string().contains("fresh bootstrap"));
        let (restored, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(restored.lifecycle, "revoked");
        assert_eq!(
            restored.recoverable_failure.as_deref(),
            Some("revocation_flush_requires_bootstrap")
        );
        assert_eq!(restored.unrecoverable_outcome, None);
        assert_eq!(restored.outbox.len(), 1);
        assert!(restored
            .diagnostics
            .iter()
            .any(|entry| entry.contains("socket closed")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_p0_records_an_explicit_unrecoverable_outcome() {
        let root = temporary_root("unrecoverable");
        let mut config = config(&root);
        config.max_outbox_bytes = 512;
        config.p0_reserve_bytes = 256;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let result = enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "evidence": "x".repeat(4_096) }),
            None,
        );
        assert!(result.is_err());
        assert_eq!(
            state.unrecoverable_outcome.as_deref(),
            Some("p0_storage_exhausted")
        );
        assert_eq!(state.lifecycle, "unrecoverable");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn destination_validation_rejects_public_private_wildcard_and_mixed_answers() {
        for (label, url, addresses) in [
            (
                "public",
                "ws://8.8.8.8:443/phase3/connect",
                vec!["8.8.8.8:443".parse::<SocketAddr>().unwrap()],
            ),
            (
                "private",
                "ws://10.1.2.3:3100/phase3/connect",
                vec!["10.1.2.3:3100".parse::<SocketAddr>().unwrap()],
            ),
            (
                "wildcard",
                "ws://0.0.0.0:3100/phase3/connect",
                vec!["0.0.0.0:3100".parse::<SocketAddr>().unwrap()],
            ),
            (
                "mixed-answer",
                "ws://mixed.test:3100/phase3/connect",
                vec![
                    "127.0.0.1:3100".parse::<SocketAddr>().unwrap(),
                    "192.0.2.9:3100".parse::<SocketAddr>().unwrap(),
                ],
            ),
        ] {
            let result = resolve_ws_target_with(url, |_host, _port| Ok(addresses));
            assert!(result.is_err(), "{label} destination must fail closed");
        }
    }

    #[test]
    fn destination_validation_rejects_malformed_userinfo_query_and_fragment_before_resolution() {
        for url in [
            "wss://127.0.0.1:3100/phase3/connect",
            "WS://127.0.0.1:3100/phase3/connect",
            "ws://127.0.0.1/phase3/connect",
            "ws://127.0.0.1:0/phase3/connect",
            "ws://[::1:3100/phase3/connect",
            "ws://user@127.0.0.1:3100/phase3/connect",
            "ws://127.0.0.1:3100/phase3/connect?ticket=ambiguous",
            "ws://127.0.0.1:3100/phase3/connect#fragment",
            "ws://127.0.0.1:3100/phase3\\connect",
        ] {
            let mut resolution_attempted = false;
            let result = resolve_ws_target_with(url, |_host, _port| {
                resolution_attempted = true;
                Ok(vec!["127.0.0.1:3100".parse().unwrap()])
            });
            assert!(result.is_err(), "ambiguous URL must be rejected: {url}");
            assert!(
                !resolution_attempted,
                "malformed URL reached destination resolution: {url}"
            );
        }
    }

    #[test]
    fn destination_validation_accepts_only_concrete_loopback_answers() {
        let target =
            resolve_ws_target_with("ws://localhost:3100/phase3/connect", |_host, _port| {
                Ok(vec![
                    "127.42.0.9:3100".parse().unwrap(),
                    "[::1]:3100".parse().unwrap(),
                ])
            })
            .unwrap();
        assert_eq!(target.addresses.len(), 2);
        assert!(target
            .addresses
            .iter()
            .all(|address| address.ip().is_loopback()));
    }

    #[test]
    fn oversized_outbound_websocket_frame_is_rejected_before_write() {
        let error = encode_masked_frame(0x1, b"ninebytes", [0; 4], 8).unwrap_err();
        assert!(error
            .to_string()
            .contains("outbound WebSocket frame exceeds"));
    }

    #[test]
    fn oversized_inbound_websocket_frame_is_rejected_before_allocation() {
        let error = checked_inbound_frame_length(9, 8).unwrap_err();
        assert!(error
            .to_string()
            .contains("inbound WebSocket frame exceeds"));
    }

    #[test]
    fn revoked_runner_rejects_turn_with_zero_effects_and_preserves_existing_outbox() {
        let root = temporary_root("revoked-command");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "status": "succeeded" }),
            None,
        )
        .unwrap();
        state.lifecycle = "revoked".to_owned();
        let before = state.outbox.clone();
        let rejected = process_command(
            &mut state,
            &store,
            &config,
            &command("command_after_revoke", 1, "turn.start", json!({})),
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.logical_effect_count, 0);
        assert_eq!(state.outbox, before);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_state_write_ignores_preplanted_predictable_symlink_and_uses_private_modes() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("state-symlink");
        let victim = root.join("victim.txt");
        fs::write(&victim, "unchanged").unwrap();
        let planted = root.join("runner-state.json.next");
        symlink(&victim, &planted).unwrap();
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        store.save(&DurableRunnerState::new(&config)).unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "unchanged");
        assert!(fs::symlink_metadata(&planted)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(store.path()).unwrap().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn durable_state_load_rejects_a_symlink() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("state-load-symlink");
        let config = config(&root);
        let victim = root.join("victim.json");
        fs::write(
            &victim,
            serde_json::to_vec(&DurableRunnerState::new(&config)).unwrap(),
        )
        .unwrap();
        symlink(&victim, root.join("runner-state.json")).unwrap();
        let store = DurableStateStore::new(&root).unwrap();
        assert!(store.load_or_create(&config).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn captured_bootstrap_is_removed_and_absent_from_a_real_child_environment() {
        let _guard = ENVIRONMENT_TEST_LOCK.lock().unwrap();
        let secret = format!("bootstrap-environment-regression-{}", std::process::id());
        std::env::set_var("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET", &secret);
        let ticket = capture_bootstrap_ticket().unwrap().unwrap();
        assert!(std::env::var_os("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET").is_none());

        let mut child = SupervisedProcess::spawn(
            Path::new("/usr/bin/env"),
            &[],
            Duration::from_millis(50),
            16 * 1024,
        )
        .unwrap();
        let mut environment = Vec::new();
        while let Some(line) = child
            .receive_stdout_line(Duration::from_millis(250))
            .unwrap()
        {
            environment.push(line);
        }
        let exit = child.wait().unwrap();
        assert!(exit.success);
        let dump = environment.join("\n");
        assert!(!dump.contains("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET"));
        assert!(!dump.contains(&secret));
        drop(ticket);
    }
}
