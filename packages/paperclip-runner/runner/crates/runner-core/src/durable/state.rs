use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{DurableRunnerConfig, DurableRunnerError, PROTOCOL, PROTOCOL_VERSION};

const STATE_SCHEMA: &str = "paperclip.runner.durable.state.v1";
const STATE_FILE: &str = "runner-state.json";
const MAX_RECENT_COMMANDS: usize = 128;
const MAX_DIAGNOSTICS: usize = 32;
const MAX_COMMAND_RESULT_BYTES: usize = 64 * 1024;
const MAX_EXECUTOR_EVENT_RECEIPTS: usize = 256;
const STATE_OVERHEAD_BYTES: usize = 16 * 1024 * 1024;
const TEMP_FILE_ATTEMPTS: usize = 32;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventPriority {
    P0,
    P1,
    P2,
}

impl EventPriority {
    fn number(self) -> u8 {
        match self {
            Self::P0 => 0,
            Self::P1 => 1,
            Self::P2 => 2,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub schema: String,
    pub command_id: String,
    pub controller_seq: u64,
    #[serde(rename = "type")]
    pub command_type: String,
    pub issued_at: String,
    #[serde(default)]
    pub deadline_at: Option<String>,
    #[serde(default)]
    pub precondition: Option<Value>,
    #[serde(default)]
    pub payload: Value,
}

impl Command {
    pub fn validate(&self) -> Result<(), DurableRunnerError> {
        if self.schema != "paperclip.prp.command.v1" {
            return Err(DurableRunnerError::invalid(
                "command requires the paperclip.prp.command.v1 schema",
            ));
        }
        if self.command_id.is_empty()
            || self.command_id.len() > 160
            || self.command_id.chars().any(char::is_control)
        {
            return Err(DurableRunnerError::invalid(
                "commandId is empty, oversized, or contains control characters",
            ));
        }
        if self.issued_at.is_empty()
            || self.issued_at.len() > 64
            || self.issued_at.chars().any(char::is_control)
            || self.deadline_at.as_ref().is_some_and(|deadline| {
                deadline.is_empty() || deadline.len() > 64 || deadline.chars().any(char::is_control)
            })
        {
            return Err(DurableRunnerError::invalid(
                "command timestamps are empty, oversized, or contain control characters",
            ));
        }
        if self.controller_seq == 0 {
            return Err(DurableRunnerError::invalid(
                "command controllerSeq must be positive",
            ));
        }
        if !self.payload.is_object() {
            return Err(DurableRunnerError::invalid(
                "command payload must be an object",
            ));
        }
        if self
            .precondition
            .as_ref()
            .is_some_and(|precondition| !precondition.is_object())
        {
            return Err(DurableRunnerError::invalid(
                "command precondition must be an object",
            ));
        }
        if !matches!(
            self.command_type.as_str(),
            "run.prepare"
                | "run.attach"
                | "session.open"
                | "turn.start"
                | "turn.steer"
                | "turn.interrupt"
                | "turn.stop"
                | "request.resolve"
                | "interaction.receipt"
                | "semantic_tool.result"
                | "session.snapshot"
                | "session.close"
                | "session.budget.increase"
                | "session.destroy"
                | "run.cancel"
                | "runner.drain"
                | "runner.suspend"
                | "runner.shutdown"
        ) {
            return Err(DurableRunnerError::invalid(
                "command type is not supported by PRP v1",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredOutboxEvent {
    pub source_seq: u64,
    pub priority: u8,
    pub event_type: String,
    pub envelope: Value,
    pub byte_size: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCommandResult {
    pub command_id: String,
    pub controller_seq: u64,
    pub command_type: String,
    pub status: String,
    pub result: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutorEventReceipt {
    fingerprint: String,
    source_seq: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CommandDisposition {
    Execute,
    Replay(StoredCommandResult),
    Reject(StoredCommandResult),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableState {
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
    pub compacted_through_controller_seq: u64,
    pub reconnect_count: u64,
    pub max_outbox_bytes: usize,
    pub p0_reserve_bytes: usize,
    pub peak_outbox_bytes: usize,
    pub outbox: Vec<StoredOutboxEvent>,
    pub processed_commands: BTreeMap<String, StoredCommandResult>,
    #[serde(default)]
    pub processed_command_fingerprints: BTreeMap<String, String>,
    #[serde(default)]
    executor_event_receipts: BTreeMap<String, ExecutorEventReceipt>,
    pub diagnostics: Vec<String>,
    pub backpressure: bool,
    pub recoverable_failure: Option<String>,
}

impl DurableState {
    pub(crate) fn new(config: &DurableRunnerConfig) -> Self {
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
            compacted_through_controller_seq: 0,
            reconnect_count: 0,
            max_outbox_bytes: config.max_outbox_bytes,
            p0_reserve_bytes: config.p0_reserve_bytes,
            peak_outbox_bytes: 0,
            outbox: Vec::new(),
            processed_commands: BTreeMap::new(),
            processed_command_fingerprints: BTreeMap::new(),
            executor_event_receipts: BTreeMap::new(),
            diagnostics: Vec::new(),
            backpressure: false,
            recoverable_failure: None,
        }
    }

    pub fn outbox_bytes(&self) -> usize {
        self.outbox.iter().map(|event| event.byte_size).sum()
    }

    pub fn highest_source_seq(&self) -> u64 {
        self.next_source_seq.saturating_sub(1)
    }

    pub fn enqueue_event(
        &mut self,
        config: &DurableRunnerConfig,
        event_type: impl Into<String>,
        priority: EventPriority,
        payload: Value,
    ) -> Result<u64, DurableRunnerError> {
        let source_event_id = format!(
            "event_{}_{:016}",
            self.runner_instance_id, self.next_source_seq
        );
        self.enqueue_event_with_source_event_id(
            config,
            source_event_id,
            event_type,
            priority,
            payload,
        )
    }

    fn source_event_id_for_executor(
        &self,
        executor_event_id: &str,
    ) -> Result<String, DurableRunnerError> {
        if executor_event_id.is_empty()
            || executor_event_id.len() > 160
            || executor_event_id.chars().any(char::is_control)
        {
            return Err(DurableRunnerError::invalid(
                "executor event identity is empty, oversized, or contains control characters",
            ));
        }
        let mut hasher = Sha256::new();
        hasher.update(b"paperclip.executor-event.v1\0");
        hasher.update(self.runner_instance_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(executor_event_id.as_bytes());
        Ok(format!("event_executor_{:x}", hasher.finalize()))
    }

    fn has_source_event_id(&self, source_event_id: &str) -> bool {
        self.outbox.iter().any(|event| {
            event
                .envelope
                .pointer("/payload/sourceEventId")
                .and_then(Value::as_str)
                == Some(source_event_id)
        })
    }

    pub(crate) fn has_executor_event_receipt(
        &self,
        executor_event_id: &str,
        event_type: &str,
        priority: EventPriority,
        payload: &Value,
    ) -> Result<bool, DurableRunnerError> {
        self.source_event_id_for_executor(executor_event_id)?;
        let Some(existing) = self.executor_event_receipts.get(executor_event_id) else {
            return Ok(false);
        };
        if existing.fingerprint != executor_event_fingerprint(event_type, priority, payload) {
            return Err(DurableRunnerError::invalid(
                "executor event identity was reused with different event data",
            ));
        }
        Ok(true)
    }

    pub(crate) fn enqueue_executor_event(
        &mut self,
        config: &DurableRunnerConfig,
        executor_event_id: String,
        event_type: String,
        priority: EventPriority,
        payload: Value,
    ) -> Result<u64, DurableRunnerError> {
        if self.has_executor_event_receipt(&executor_event_id, &event_type, priority, &payload)? {
            return Err(DurableRunnerError::invalid(
                "executor event identity is already committed",
            ));
        }
        let source_event_id = self.source_event_id_for_executor(&executor_event_id)?;
        let fingerprint = executor_event_fingerprint(&event_type, priority, &payload);
        let source_seq = self.enqueue_event_with_source_event_id(
            config,
            source_event_id,
            event_type,
            priority,
            payload,
        )?;
        self.executor_event_receipts.insert(
            executor_event_id,
            ExecutorEventReceipt {
                fingerprint,
                source_seq,
            },
        );
        self.compact_executor_event_receipts();
        Ok(source_seq)
    }

    pub(crate) fn enqueue_event_with_source_event_id(
        &mut self,
        config: &DurableRunnerConfig,
        source_event_id: String,
        event_type: impl Into<String>,
        priority: EventPriority,
        payload: Value,
    ) -> Result<u64, DurableRunnerError> {
        let event_type = event_type.into();
        if source_event_id.is_empty()
            || source_event_id.len() > 160
            || source_event_id.chars().any(char::is_control)
            || self.has_source_event_id(&source_event_id)
        {
            return Err(DurableRunnerError::invalid(
                "source event identity is malformed or already queued",
            ));
        }
        if event_type.is_empty()
            || event_type.len() > 160
            || event_type.chars().any(char::is_control)
        {
            return Err(DurableRunnerError::invalid(
                "event type is empty, oversized, or contains control characters",
            ));
        }
        if !payload.is_object() {
            return Err(DurableRunnerError::invalid(
                "durable event payload must be an object",
            ));
        }

        let source_seq = self.next_source_seq;
        let emitted_at = current_timestamp()?;
        let sanitized_payload = sanitize_event_payload(&event_type, &payload);
        let envelope = json!({
            "protocol": PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "event",
            "runnerInstanceId": self.runner_instance_id,
            "environmentLeaseId": self.environment_lease_id,
            "runId": self.run_id,
            "normalizedSessionId": self.normalized_session_id,
            "turnId": self.turn_id,
            "itemId": self.item_id,
            "payload": {
                "schema": "paperclip.prp.event.v1",
                "sourceEventId": source_event_id,
                "sourceSeq": source_seq,
                "sourceInstanceId": self.runner_instance_id,
                "sourceKind": "runner",
                "runId": self.run_id,
                "normalizedSessionId": self.normalized_session_id,
                "turnId": self.turn_id,
                "itemId": self.item_id,
                "eventType": event_type,
                "schemaVersion": 1,
                "priority": priority.number(),
                "emittedAt": emitted_at,
                "payload": sanitized_payload,
            },
        });
        let byte_size = serde_json::to_vec(&envelope)
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?
            .len();
        if byte_size > config.max_frame_bytes {
            return Err(DurableRunnerError::invalid(
                "durable event exceeds the transport frame limit",
            ));
        }
        let projected = self.outbox_bytes().saturating_add(byte_size);
        let non_p0_limit = config
            .max_outbox_bytes
            .saturating_sub(config.p0_reserve_bytes);

        if priority != EventPriority::P0 && projected > non_p0_limit {
            self.backpressure = true;
            self.lifecycle = "backpressure".to_owned();
            self.record_diagnostic("outbox soft limit reached; non-P0 event rejected");
            return Err(DurableRunnerError::invalid(
                "outbox soft limit reached; reserved storage is available only to P0 events",
            ));
        }
        if projected > config.max_outbox_bytes {
            self.lifecycle = "unrecoverable".to_owned();
            self.record_diagnostic("P0 outbox reserve exhausted; operator recovery is required");
            return Err(DurableRunnerError::invalid(
                "durable outbox limit exhausted",
            ));
        }

        self.next_source_seq = self
            .next_source_seq
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("source sequence exhausted"))?;
        self.outbox.push(StoredOutboxEvent {
            source_seq,
            priority: priority.number(),
            event_type,
            envelope,
            byte_size,
        });
        self.peak_outbox_bytes = self.peak_outbox_bytes.max(projected);
        Ok(source_seq)
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
        if self.backpressure
            && self.outbox_bytes() < self.max_outbox_bytes.saturating_sub(self.p0_reserve_bytes)
        {
            self.backpressure = false;
            if self.lifecycle == "backpressure" {
                self.lifecycle = "ready".to_owned();
            }
        }
        Ok(())
    }

    pub fn begin_command(
        &mut self,
        command: &Command,
    ) -> Result<CommandDisposition, DurableRunnerError> {
        command.validate()?;
        let fingerprint = command_fingerprint(command)?;
        if let Some(previous) = self.processed_commands.get(&command.command_id) {
            let previous_fingerprint = self
                .processed_command_fingerprints
                .get(&command.command_id)
                .ok_or_else(|| {
                    DurableRunnerError::invalid(
                        "durable command journal is missing its identity fingerprint",
                    )
                })?;
            if previous_fingerprint != &fingerprint {
                return Err(DurableRunnerError::invalid(
                    "commandId was reused with different command data",
                ));
            }
            return Ok(CommandDisposition::Replay(previous.clone()));
        }
        if command.controller_seq <= self.compacted_through_controller_seq {
            return Ok(CommandDisposition::Reject(command_result(
                command,
                "rejected",
                json!({
                    "code": "command_history_compacted",
                    "message": "command is older than the bounded replay journal and was not re-executed",
                }),
            )));
        }
        let expected = self
            .last_controller_command_seq
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("controller sequence exhausted"))?;
        if command.controller_seq != expected {
            return Err(DurableRunnerError::invalid(format!(
                "controller sequence must be contiguous: expected {expected}, received {}",
                command.controller_seq
            )));
        }

        self.last_controller_command_seq = command.controller_seq;
        self.processed_commands.insert(
            command.command_id.clone(),
            command_result(
                command,
                "pending",
                json!({
                    "code": "execution_indeterminate",
                    "message": "command was journaled before its effect",
                }),
            ),
        );
        self.processed_command_fingerprints
            .insert(command.command_id.clone(), fingerprint);
        self.compact_command_history();
        Ok(CommandDisposition::Execute)
    }

    pub fn complete_command(
        &mut self,
        command: &Command,
        result: Value,
    ) -> Result<StoredCommandResult, DurableRunnerError> {
        let stored = self
            .processed_commands
            .get_mut(&command.command_id)
            .ok_or_else(|| {
                DurableRunnerError::invalid("command was not journaled before completion")
            })?;
        if stored.controller_seq != command.controller_seq || stored.status != "pending" {
            return Err(DurableRunnerError::invalid(
                "command completion does not match a pending journal entry",
            ));
        }
        let result = sanitize_value(&result);
        let result_bytes = serde_json::to_vec(&result)
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?
            .len();
        if result_bytes > MAX_COMMAND_RESULT_BYTES {
            return Err(DurableRunnerError::invalid(
                "command result exceeds the 64 KiB durable journal limit",
            ));
        }
        stored.status = "completed".to_owned();
        stored.result = result;
        Ok(stored.clone())
    }

    pub fn reconcile_pending_commands(&mut self) -> bool {
        let mut changed = false;
        for command in self.processed_commands.values_mut() {
            if command.status == "pending" {
                command.status = "indeterminate".to_owned();
                command.result = json!({
                    "code": "execution_indeterminate",
                    "message": "runner recovered after journaling this command; it will not execute twice",
                });
                changed = true;
            }
        }
        changed
    }

    fn has_legacy_command_journal(&self) -> bool {
        !self.processed_commands.is_empty() && self.processed_command_fingerprints.is_empty()
    }

    fn compact_legacy_command_journal(&mut self) {
        self.processed_commands.clear();
        self.processed_command_fingerprints.clear();
        self.compacted_through_controller_seq = self.last_controller_command_seq;
        self.record_diagnostic(
            "pre-fingerprint command journal was compacted; prior commands remain non-reexecutable",
        );
    }

    pub(crate) fn record_diagnostic(&mut self, message: impl Into<String>) {
        self.diagnostics.push(redact_text(&message.into()));
        if self.diagnostics.len() > MAX_DIAGNOSTICS {
            self.diagnostics.remove(0);
        }
    }

    fn compact_command_history(&mut self) {
        while self.processed_commands.len() > MAX_RECENT_COMMANDS {
            let Some(oldest_id) = self
                .processed_commands
                .values()
                .min_by_key(|command| command.controller_seq)
                .map(|command| command.command_id.clone())
            else {
                break;
            };
            if let Some(oldest) = self.processed_commands.remove(&oldest_id) {
                self.processed_command_fingerprints.remove(&oldest_id);
                self.compacted_through_controller_seq = self
                    .compacted_through_controller_seq
                    .max(oldest.controller_seq);
            }
        }
    }

    fn compact_executor_event_receipts(&mut self) {
        while self.executor_event_receipts.len() > MAX_EXECUTOR_EVENT_RECEIPTS {
            let Some(oldest_id) = self
                .executor_event_receipts
                .iter()
                .min_by_key(|(_, receipt)| receipt.source_seq)
                .map(|(event_id, _)| event_id.clone())
            else {
                break;
            };
            self.executor_event_receipts.remove(&oldest_id);
        }
    }
}

fn command_result(command: &Command, status: &str, result: Value) -> StoredCommandResult {
    StoredCommandResult {
        command_id: command.command_id.clone(),
        controller_seq: command.controller_seq,
        command_type: command.command_type.clone(),
        status: status.to_owned(),
        result,
    }
}

fn command_fingerprint(command: &Command) -> Result<String, DurableRunnerError> {
    let value = serde_json::to_value(command).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to fingerprint durable command: {error}"))
    })?;
    let digest = Sha256::digest(canonical_json(&value).as_bytes());
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut fingerprint = String::with_capacity(digest.len() * 2);
    for byte in digest {
        fingerprint.push(HEX[usize::from(byte >> 4)] as char);
        fingerprint.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    Ok(fingerprint)
}

fn executor_event_fingerprint(
    event_type: &str,
    priority: EventPriority,
    payload: &Value,
) -> String {
    let identity = json!({
        "eventType": event_type,
        "priority": priority.number(),
        "payload": sanitize_value(payload),
    });
    format!("{:x}", Sha256::digest(canonical_json(&identity).as_bytes()))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON object key should serialize"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => value.to_string(),
    }
}

#[derive(Clone, Debug)]
pub struct DurableStateStore {
    path: PathBuf,
}

impl DurableStateStore {
    pub fn new(state_dir: &Path) -> Result<Self, DurableRunnerError> {
        if let Ok(metadata) = fs::symlink_metadata(state_dir) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
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
            path: state_dir.join(STATE_FILE),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load_or_create(
        &self,
        config: &DurableRunnerConfig,
    ) -> Result<(DurableState, bool), DurableRunnerError> {
        let mut bytes = Vec::new();
        match open_private_regular_file(&self.path) {
            Ok(mut file) => {
                let maximum_state_bytes =
                    config.max_outbox_bytes.saturating_add(STATE_OVERHEAD_BYTES);
                let file_bytes = usize::try_from(
                    file.metadata()
                        .map_err(|error| DurableRunnerError::invalid(error.to_string()))?
                        .len(),
                )
                .map_err(|_| DurableRunnerError::invalid("durable state length overflowed"))?;
                if file_bytes > maximum_state_bytes {
                    return Err(DurableRunnerError::invalid(
                        "durable state exceeds its configured storage bound",
                    ));
                }
                file.read_to_end(&mut bytes).map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to read durable state {}: {error}",
                        self.path.display()
                    ))
                })?
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let state = DurableState::new(config);
                self.save(&state)?;
                return Ok((state, false));
            }
            Err(error) => {
                return Err(DurableRunnerError::invalid(format!(
                    "failed to open durable state {}: {error}",
                    self.path.display()
                )))
            }
        };
        let mut state: DurableState = serde_json::from_slice(&bytes).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "durable state is malformed and cannot be recovered: {error}"
            ))
        })?;
        let has_legacy_command_journal = state.has_legacy_command_journal();
        validate_binding(&state, config, has_legacy_command_journal)?;
        let mut changed = false;
        if has_legacy_command_journal {
            state.compact_legacy_command_journal();
            validate_binding(&state, config, false)?;
            changed = true;
        }
        if state.reconcile_pending_commands() {
            changed = true;
        }
        if changed {
            self.save(&state)?;
        }
        Ok((state, true))
    }

    pub fn save(&self, state: &DurableState) -> Result<(), DurableRunnerError> {
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to serialize durable state: {error}"))
        })?;
        if bytes.len() > state.max_outbox_bytes.saturating_add(STATE_OVERHEAD_BYTES) {
            return Err(DurableRunnerError::invalid(
                "durable state exceeds its configured storage bound",
            ));
        }
        let (temporary, mut file) = create_private_temporary_file(&self.path)?;
        let result = (|| -> Result<(), DurableRunnerError> {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("failed to commit durable state: {error}"))
                })?;
            drop(file);
            fs::rename(&temporary, &self.path).map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to atomically replace durable state: {error}"
                ))
            })?;
            #[cfg(unix)]
            if let Some(parent) = self.path.parent() {
                File::open(parent)
                    .and_then(|directory| directory.sync_all())
                    .map_err(|error| {
                        DurableRunnerError::invalid(format!(
                            "failed to sync durable state directory: {error}"
                        ))
                    })?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn validate_binding(
    state: &DurableState,
    config: &DurableRunnerConfig,
    allow_legacy_command_journal: bool,
) -> Result<(), DurableRunnerError> {
    if state.schema != STATE_SCHEMA
        || state.runner_instance_id != config.runner_instance_id
        || state.environment_lease_id != config.environment_lease_id
        || state.run_id != config.run_id
        || state.normalized_session_id != config.normalized_session_id
        || state.turn_id != config.turn_id
        || state.item_id != config.item_id
        || state.max_outbox_bytes != config.max_outbox_bytes
        || state.p0_reserve_bytes != config.p0_reserve_bytes
    {
        return Err(DurableRunnerError::invalid(
            "durable state binding does not match this runner invocation",
        ));
    }
    let outbox_bytes = state.outbox.iter().try_fold(0_usize, |total, event| {
        let serialized = serde_json::to_vec(&event.envelope)
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        if event.byte_size != serialized.len()
            || event
                .envelope
                .pointer("/payload/sourceSeq")
                .and_then(Value::as_u64)
                != Some(event.source_seq)
            || event.priority > 2
        {
            return Err(DurableRunnerError::invalid(
                "durable outbox metadata does not match its envelope",
            ));
        }
        total
            .checked_add(event.byte_size)
            .ok_or_else(|| DurableRunnerError::invalid("durable outbox size overflowed"))
    })?;
    let outbox_cursors_are_valid = match (state.outbox.first(), state.outbox.last()) {
        (None, None) => state.acked_source_seq == state.highest_source_seq(),
        (Some(first), Some(last)) => {
            state.acked_source_seq.checked_add(1) == Some(first.source_seq)
                && last.source_seq == state.highest_source_seq()
        }
        _ => false,
    };
    let mut command_sequences = state
        .processed_commands
        .iter()
        .map(|(key, command)| {
            if key != &command.command_id
                || command.controller_seq <= state.compacted_through_controller_seq
                || command.controller_seq > state.last_controller_command_seq
                || !matches!(
                    command.status.as_str(),
                    "pending" | "completed" | "indeterminate"
                )
            {
                return Err(DurableRunnerError::invalid(
                    "durable command journal metadata is inconsistent",
                ));
            }
            Ok(command.controller_seq)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let command_fingerprints_are_valid = (state.processed_command_fingerprints.len()
        == state.processed_commands.len()
        && state
            .processed_command_fingerprints
            .iter()
            .all(|(key, value)| {
                state.processed_commands.contains_key(key)
                    && value.len() == 64
                    && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            }))
        || (allow_legacy_command_journal
            && !state.processed_commands.is_empty()
            && state.processed_command_fingerprints.is_empty());
    let mut executor_receipt_sequences = HashSet::new();
    let executor_event_receipts_are_valid = state.executor_event_receipts.len()
        <= MAX_EXECUTOR_EVENT_RECEIPTS
        && state
            .executor_event_receipts
            .iter()
            .all(|(event_id, receipt)| {
                state.source_event_id_for_executor(event_id).is_ok()
                    && receipt.fingerprint.len() == 64
                    && receipt
                        .fingerprint
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
                    && receipt.source_seq > 0
                    && receipt.source_seq <= state.highest_source_seq()
                    && executor_receipt_sequences.insert(receipt.source_seq)
            });
    command_sequences.sort_unstable();
    let command_cursors_are_valid = match (command_sequences.first(), command_sequences.last()) {
        (None, None) => state.compacted_through_controller_seq == state.last_controller_command_seq,
        (Some(first), Some(last)) => {
            state.compacted_through_controller_seq.checked_add(1) == Some(*first)
                && *last == state.last_controller_command_seq
                && command_sequences
                    .windows(2)
                    .all(|pair| pair[0].checked_add(1) == Some(pair[1]))
        }
        _ => false,
    };

    if state.next_source_seq == 0
        || state.acked_source_seq > state.highest_source_seq()
        || !outbox_cursors_are_valid
        || state
            .outbox
            .windows(2)
            .any(|pair| pair[0].source_seq.checked_add(1) != Some(pair[1].source_seq))
        || outbox_bytes > state.max_outbox_bytes
        || state.peak_outbox_bytes < outbox_bytes
        || state.compacted_through_controller_seq > state.last_controller_command_seq
        || !command_cursors_are_valid
        || !command_fingerprints_are_valid
        || !executor_event_receipts_are_valid
    {
        return Err(DurableRunnerError::invalid(
            "durable state cursors, bounds, or journals are inconsistent",
        ));
    }
    Ok(())
}

pub(crate) fn verify_private_directory(path: &Path) -> Result<(), DurableRunnerError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(DurableRunnerError::invalid(
            "durable state directory must not be a symlink",
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(DurableRunnerError::invalid(
            "durable state directory must not be accessible by group or other users",
        ));
    }
    Ok(())
}

pub(crate) fn open_private_regular_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(no_follow_flag());
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "durable state path is not a regular file",
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "durable state file is accessible by group or other users",
        ));
    }
    Ok(file)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
const fn no_follow_flag() -> i32 {
    0o400000
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
const fn no_follow_flag() -> i32 {
    0x00000100
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd"
    ))
))]
const fn no_follow_flag() -> i32 {
    0
}

pub(crate) fn create_private_temporary_file(
    path: &Path,
) -> Result<(PathBuf, File), DurableRunnerError> {
    let parent = path
        .parent()
        .ok_or_else(|| DurableRunnerError::invalid("durable state path has no parent"))?;
    let process_id = std::process::id();
    for attempt in 0..TEMP_FILE_ATTEMPTS {
        let temporary = parent.join(format!(".{STATE_FILE}.{process_id}.{attempt}.tmp"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(no_follow_flag());
        match options.open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(DurableRunnerError::invalid(format!(
                    "failed to create private durable state temporary file: {error}"
                )))
            }
        }
    }
    Err(DurableRunnerError::invalid(
        "failed to allocate a private durable state temporary file",
    ))
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
    if matches!(
        normalized.as_str(),
        "inputtokens"
            | "outputtokens"
            | "cachereadtokens"
            | "cachewritetokens"
            | "pretokens"
            | "posttokens"
    ) {
        return false;
    }
    [
        "authorization",
        "cookie",
        "password",
        "secret",
        "token",
        "ticket",
        "apikey",
        "credential",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if sensitive_key(key) {
                            Value::String("[REDACTED]".to_owned())
                        } else {
                            sanitize_value(value)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_value).collect()),
        Value::String(value) => Value::String(redact_text(value)),
        value => value.clone(),
    }
}

fn sanitize_event_payload(event_type: &str, payload: &Value) -> Value {
    let mut sanitized = sanitize_value(payload);
    if event_type == "semantic_tool.result" {
        let boundary = payload
            .pointer("/semantic_tool/authorizationBoundary")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "company"
                        | "actor"
                        | "active_task"
                        | "grant"
                        | "governed_action"
                        | "lock"
                        | "revision"
                )
            });
        if let (Some(boundary), Some(target)) = (
            boundary,
            sanitized.pointer_mut("/semantic_tool/authorizationBoundary"),
        ) {
            *target = Value::String(boundary.to_owned());
        }
    }
    sanitized
}

pub(crate) fn redact_text(input: &str) -> String {
    let (bounded, truncated) = if input.len() > 4096 {
        let boundary = input
            .char_indices()
            .map(|(index, _)| index)
            .take_while(|index| *index <= 4096)
            .last()
            .unwrap_or(0);
        (&input[..boundary], true)
    } else {
        (input, false)
    };
    let normalized = bounded.to_ascii_lowercase();
    if [
        "authorization",
        "bearer ",
        "api_key",
        "apikey",
        "password=",
        "secret=",
        "ticket=",
        "token=",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        "[REDACTED diagnostic containing a sensitive marker]".to_owned()
    } else if truncated {
        format!("{bounded}…[truncated]")
    } else {
        bounded.to_owned()
    }
}

fn current_timestamp() -> Result<String, DurableRunnerError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            DurableRunnerError::invalid(format!("system clock is invalid: {error}"))
        })?;
    let total_seconds = i64::try_from(duration.as_secs())
        .map_err(|_| DurableRunnerError::invalid("system clock value overflowed"))?;
    let days = total_seconds.div_euclid(86_400);
    let second_of_day = total_seconds.rem_euclid(86_400);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    if !(0..=9999).contains(&year) {
        return Err(DurableRunnerError::invalid(
            "system clock is outside the supported RFC 3339 range",
        ));
    }
    let hour = second_of_day / 3600;
    let minute = second_of_day % 3600 / 60;
    let second = second_of_day % 60;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        duration.subsec_millis()
    ))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn config(state_dir: PathBuf) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1:3000/api/runner/v1/connect/run_1".to_owned(),
            state_dir,
            runner_instance_id: "runner_1".to_owned(),
            environment_lease_id: "environment_1".to_owned(),
            run_id: "run_1".to_owned(),
            normalized_session_id: "session_1".to_owned(),
            turn_id: "turn_1".to_owned(),
            item_id: "item_1".to_owned(),
            runner_version: "0.0.0".to_owned(),
            runner_digest: "sha256:test".to_owned(),
            max_outbox_bytes: 16_384,
            p0_reserve_bytes: 4096,
            max_frame_bytes: 65_536,
            reconnect_delay: Duration::from_millis(1),
            max_runtime: Duration::from_secs(1),
        }
    }

    fn command(id: &str, sequence: u64) -> Command {
        Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: id.to_owned(),
            controller_seq: sequence,
            command_type: "session.open".to_owned(),
            issued_at: "2026-08-24T00:00:00.000Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload: json!({}),
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "paperclip-runner-durable-{label}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn cumulative_ack_is_monotonic_and_bounded() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        state
            .enqueue_event(&config, "runner.connected", EventPriority::P0, json!({}))
            .unwrap();
        state
            .enqueue_event(&config, "runner.reconnected", EventPriority::P1, json!({}))
            .unwrap();
        state.apply_ack(1).unwrap();
        assert_eq!(state.outbox.len(), 1);
        assert!(state.apply_ack(0).is_err());
        assert!(state.apply_ack(3).is_err());
    }

    #[test]
    fn duplicate_command_replays_without_executing() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        let command = command("command_1", 1);
        assert_eq!(
            state.begin_command(&command).unwrap(),
            CommandDisposition::Execute
        );
        state
            .complete_command(&command, json!({"ok": true}))
            .unwrap();
        assert!(matches!(
            state.begin_command(&command).unwrap(),
            CommandDisposition::Replay(result) if result.result == json!({"ok": true})
        ));
    }

    #[test]
    fn command_gaps_and_identifier_reuse_fail_closed() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        let mut unknown = command("command_unknown", 1);
        unknown.command_type = "future.required.command".to_owned();
        assert!(state.begin_command(&unknown).is_err());
        assert!(state.begin_command(&command("command_2", 2)).is_err());
        let first = command("command_1", 1);
        state.begin_command(&first).unwrap();
        state.complete_command(&first, json!({})).unwrap();
        assert!(state.begin_command(&command("command_1", 2)).is_err());
    }

    #[test]
    fn recovery_marks_ambiguous_effect_without_reexecution() {
        let directory = temporary_directory("ambiguous");
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let command = command("command_1", 1);
        state.begin_command(&command).unwrap();
        store.save(&state).unwrap();

        let (mut recovered, existed) = store.load_or_create(&config).unwrap();
        assert!(existed);
        assert!(matches!(
            recovered.begin_command(&command).unwrap(),
            CommandDisposition::Replay(result) if result.status == "indeterminate"
        ));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn state_binding_prevents_cross_run_reuse() {
        let directory = temporary_directory("binding");
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        store.load_or_create(&config).unwrap();
        let mut wrong = config.clone();
        wrong.run_id = "run_2".to_owned();
        assert!(store.load_or_create(&wrong).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn event_payloads_are_redacted_before_persistence() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        state
            .enqueue_event(
                &config,
                "runner.diagnostic",
                EventPriority::P1,
                json!({"nested": {"api_token": "secret-value", "inputTokens": 42}}),
            )
            .unwrap();
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/api_token"),
            Some(&Value::String("[REDACTED]".to_owned()))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/inputTokens"),
            Some(&json!(42))
        );
    }

    #[test]
    fn outbox_reserves_capacity_for_p0_and_bounds_frames() {
        let mut bounds_config = config(PathBuf::from("unused"));
        bounds_config.max_outbox_bytes = 1800;
        bounds_config.p0_reserve_bytes = 600;
        let mut state = DurableState::new(&bounds_config);
        while state
            .enqueue_event(
                &bounds_config,
                "item.delta",
                EventPriority::P1,
                json!({"text": "x".repeat(200)}),
            )
            .is_ok()
        {}
        assert!(state.backpressure);
        assert!(state
            .enqueue_event(
                &bounds_config,
                "runner.diagnostic",
                EventPriority::P0,
                json!({"message": "storage pressure"}),
            )
            .is_ok());

        let mut frame_limited = config(PathBuf::from("unused"));
        frame_limited.max_frame_bytes = 1024;
        let mut state = DurableState::new(&frame_limited);
        assert!(state
            .enqueue_event(
                &frame_limited,
                "item.delta",
                EventPriority::P1,
                json!({"text": "x".repeat(2048)}),
            )
            .is_err());
        assert!(state.outbox.is_empty());
    }
}
