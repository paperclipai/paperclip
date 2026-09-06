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
pub(crate) struct PendingTerminalDelivery {
    pub(crate) command_id: String,
    pub(crate) controller_seq: u64,
    pub(crate) command_type: String,
    pub(crate) lifecycle: String,
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
    pub(crate) pending_terminal_delivery: Option<PendingTerminalDelivery>,
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
            pending_terminal_delivery: None,
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

        let sanitized_payload = sanitize_value(&payload);
        if durable_semantics_changed_by_sanitization(&payload, &sanitized_payload) {
            return Err(DurableRunnerError::invalid(
                "durable identity or validation semantics contain credential-shaped material",
            ));
        }

        let source_seq = self.next_source_seq;
        let emitted_at = current_timestamp()?;
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
        self.finish_command(command, "completed", result)
    }

    pub fn fail_command(
        &mut self,
        command: &Command,
        result: Value,
    ) -> Result<StoredCommandResult, DurableRunnerError> {
        self.finish_command(command, "failed", result)
    }

    fn finish_command(
        &mut self,
        command: &Command,
        status: &str,
        result: Value,
    ) -> Result<StoredCommandResult, DurableRunnerError> {
        if status != "completed" && status != "failed" {
            return Err(DurableRunnerError::invalid(
                "durable command terminal status is unsupported",
            ));
        }
        {
            let stored = self
                .processed_commands
                .get(&command.command_id)
                .ok_or_else(|| {
                    DurableRunnerError::invalid("command was not journaled before completion")
                })?;
            if stored.controller_seq != command.controller_seq || stored.status != "pending" {
                return Err(DurableRunnerError::invalid(
                    "command completion does not match a pending journal entry",
                ));
            }
        }
        let sanitized_result = sanitize_value(&result);
        if durable_semantics_changed_by_sanitization(&result, &sanitized_result) {
            return Err(DurableRunnerError::invalid(
                "durable command result identity or validation semantics contain credential-shaped material",
            ));
        }
        let result_bytes = serde_json::to_vec(&sanitized_result)
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?
            .len();
        if result_bytes > MAX_COMMAND_RESULT_BYTES {
            return Err(DurableRunnerError::invalid(
                "command result exceeds the 64 KiB durable journal limit",
            ));
        }
        let stored = self
            .processed_commands
            .get_mut(&command.command_id)
            .expect("pending command was checked above");
        stored.status = status.to_owned();
        stored.result = sanitized_result;
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
                    "pending" | "completed" | "failed" | "indeterminate"
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
    let pending_terminal_delivery_is_valid =
        state
            .pending_terminal_delivery
            .as_ref()
            .map_or(true, |pending| {
                let expected_lifecycle = match pending.command_type.as_str() {
                    "runner.suspend" => "suspended",
                    "runner.shutdown" => "stopped",
                    _ => return false,
                };
                pending.lifecycle == expected_lifecycle
                    && state.lifecycle == expected_lifecycle
                    && pending.controller_seq == state.last_controller_command_seq
                    && state
                        .processed_commands
                        .get(&pending.command_id)
                        .is_some_and(|result| {
                            result.command_id == pending.command_id
                                && result.controller_seq == pending.controller_seq
                                && result.command_type == pending.command_type
                                && result.status != "pending"
                        })
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
        || !pending_terminal_delivery_is_valid
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

fn sensitive_key(key: &str, value: &Value) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
    if matches!(
        normalized.as_str(),
        "inputtokens"
            | "outputtokens"
            | "cachereadtokens"
            | "cachewritetokens"
            // The qualified ACPX sidecar uses these numeric billing aliases.
            // Strings under the same names remain credentials, not counters.
            | "cachedreadtokens"
            | "cachedwritetokens"
            | "thoughttokens"
            | "totaltokens"
            | "pretokens"
            | "posttokens"
    ) {
        return !value.is_number();
    }
    [
        "authorization",
        "bearer",
        "browsercode",
        "cookie",
        "connectionstring",
        "jwt",
        "loginurl",
        "password",
        "passwd",
        "privatekey",
        "secret",
        "token",
        "ticket",
        "apikey",
        "credential",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn protocol_authorization_boundary(key: &str, value: &Value) -> bool {
    key.eq_ignore_ascii_case("authorizationBoundary")
        && value.as_str().is_some_and(|boundary| {
            matches!(
                boundary,
                "company"
                    | "actor"
                    | "active_task"
                    | "grant"
                    | "governed_action"
                    | "lock"
                    | "revision"
            )
        })
}

fn sanitized_object_field(key: &str, value: &Value) -> Value {
    if protocol_authorization_boundary(key, value) {
        value.clone()
    } else if sensitive_key(key, value) {
        Value::String("[REDACTED]".to_owned())
    } else {
        sanitize_value(value)
    }
}

fn durable_semantics_changed_by_sanitization(original: &Value, sanitized: &Value) -> bool {
    match (original, sanitized) {
        (Value::Object(original), Value::Object(sanitized)) => {
            original.iter().any(|(key, value)| {
                let Some(sanitized_value) = sanitized.get(key) else {
                    return true;
                };
                let identity_or_validation_field = key == "id"
                    || key.ends_with("Id")
                    || key.ends_with("Ids")
                    || key.ends_with("Ref")
                    || key.ends_with("Refs")
                    || matches!(
                        key.as_str(),
                        "channel"
                            | "eventType"
                            | "idempotencyKey"
                            | "kind"
                            | "requestKind"
                            | "revision"
                            | "schema"
                            | "schemaVersion"
                            | "status"
                            | "textValidation"
                            | "type"
                    );
                if identity_or_validation_field && value != sanitized_value {
                    return true;
                }
                durable_semantics_changed_by_sanitization(value, sanitized_value)
            })
        }
        (Value::Array(original), Value::Array(sanitized)) => {
            original.len() != sanitized.len()
                || original.iter().zip(sanitized).any(|(original, sanitized)| {
                    durable_semantics_changed_by_sanitization(original, sanitized)
                })
        }
        _ => false,
    }
}

pub(crate) fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), sanitized_object_field(key, value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_value).collect()),
        Value::String(value) => Value::String(redact_text(value)),
        value => value.clone(),
    }
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
    let mut redacted = redact_sensitive_text_values(bounded);
    if truncated {
        redacted.push_str("…[truncated]");
    }
    redacted
}

fn redact_sensitive_text_values(input: &str) -> String {
    let normalized = input.to_ascii_lowercase();
    let bytes = normalized.as_bytes();
    let mut ranges: Vec<(usize, usize)> = Vec::new();

    let is_name_byte = |value: u8| value.is_ascii_alphanumeric() || value == b'_' || value == b'-';
    let is_value_end = |value: u8| {
        value.is_ascii_whitespace() || matches!(value, b',' | b';' | b'&' | b')' | b']' | b'}')
    };
    let value_end = |start: usize| {
        let mut end = start;
        while end < bytes.len() && !is_value_end(bytes[end]) {
            end += 1;
        }
        end
    };
    let quoted_value_start = |start: usize| {
        let mut quote_index = start;
        while quote_index < bytes.len() && bytes[quote_index] == b'\\' {
            quote_index += 1;
        }
        if quote_index < bytes.len() && matches!(bytes[quote_index], b'\'' | b'"') {
            (
                quote_index + 1,
                Some((bytes[quote_index], quote_index - start)),
            )
        } else {
            (start, None)
        }
    };
    let quoted_value_end = |start: usize, quote: (u8, usize)| {
        let (quote, delimiter_backslashes) = quote;
        let scan_end = bytes.len();
        let starts_independent_credential_line = |index: usize| {
            if !bytes
                .get(index)
                .is_some_and(|value| matches!(value, b'\r' | b'\n'))
            {
                return false;
            }
            let mut line_start = index + 1;
            if bytes[index] == b'\r' && bytes.get(line_start) == Some(&b'\n') {
                line_start += 1;
            }
            let line_end = (line_start..scan_end)
                .find(|candidate| matches!(bytes[*candidate], b'\r' | b'\n'))
                .unwrap_or(scan_end);
            let words = normalized[line_start..line_end]
                .split_ascii_whitespace()
                .collect::<Vec<_>>();
            (words.first() == Some(&"bearer") && words.len() >= 2)
                || (words.first() == Some(&"request")
                    && words.get(1) == Some(&"failed")
                    && words.get(2) == Some(&"with")
                    && words.get(3) == Some(&"bearer")
                    && words.len() >= 5)
        };
        let mut end = start;
        let mut provisional_end = None;
        let mut unsafe_after_provisional = false;
        while end < scan_end {
            if bytes[end] == quote {
                let preceding_backslashes = bytes[..end]
                    .iter()
                    .rev()
                    .take_while(|value| **value == b'\\')
                    .count();
                let after_delimiter = end.saturating_add(1);
                if preceding_backslashes == delimiter_backslashes {
                    let candidate_end = end - delimiter_backslashes;
                    if after_delimiter >= scan_end
                        || matches!(
                            bytes[after_delimiter],
                            b',' | b';' | b'&' | b')' | b']' | b'}'
                        )
                    {
                        return candidate_end;
                    }
                    if starts_independent_credential_line(after_delimiter) {
                        return candidate_end;
                    }
                    if matches!(bytes[after_delimiter], b'\r' | b'\n') {
                        // A quote immediately before a literal newline can be
                        // an embedded fragment rather than the true delimiter.
                        // Keep scanning for a later same-depth close and fail
                        // closed through the bounded diagnostic if none exists.
                        provisional_end = None;
                        unsafe_after_provisional = true;
                    } else if bytes[after_delimiter].is_ascii_whitespace() {
                        provisional_end = Some(candidate_end);
                        unsafe_after_provisional = false;
                    } else {
                        unsafe_after_provisional = true;
                    }
                }
            }
            end += 1;
        }
        // A quote followed by whitespace normally closes a value and preserves
        // useful trailing context. Keep it only when no later same-depth quote
        // contradicts it. Literal newlines can occur inside provider-controlled
        // credentials, so an unterminated malformed value fails closed through
        // the complete bounded diagnostic rather than exposing a later line.
        provisional_end
            .filter(|_| !unsafe_after_provisional)
            .unwrap_or(scan_end)
    };
    let is_redaction_marker = |start: usize| {
        normalized[start..].starts_with("[redacted]")
            || normalized[start..].starts_with("***redacted***")
    };

    // PEM private keys are multiline values, so the ordinary assignment scanner
    // cannot safely stop at whitespace. Redact the complete block, including an
    // unterminated block whose remaining bytes must be treated as key material.
    let mut pem_search_start = 0;
    while let Some(relative_start) = normalized[pem_search_start..].find("-----begin ") {
        let begin = pem_search_start + relative_start;
        let header_end = (begin..bytes.len())
            .find(|index| {
                matches!(bytes[*index], b'\n' | b'\r')
                    || (bytes[*index] == b'\\'
                        && bytes
                            .get((*index).saturating_add(1))
                            .is_some_and(|value| matches!(value, b'n' | b'r')))
            })
            .unwrap_or(bytes.len());
        let label_start = begin + "-----begin ".len();
        let Some(label) = normalized[label_start..header_end]
            .trim_end()
            .strip_suffix("-----")
            .map(str::trim)
            .filter(|label| label.contains("private key"))
        else {
            pem_search_start = header_end.saturating_add(1).min(bytes.len());
            continue;
        };
        let end_marker = format!("-----end {label}-----");
        let end = normalized[header_end..]
            .find(&end_marker)
            .map(|offset| header_end + offset + end_marker.len())
            .unwrap_or(bytes.len());
        ranges.push((begin, end));
        pem_search_start = end;
    }

    // Provider errors sometimes echo a credential without a field name.
    // Retain only high-confidence public token prefixes here; generic dotted
    // strings are handled schema-aware at the server boundary so PRP
    // discriminators are never mistaken for credentials in durable state.
    for (prefix, minimum_suffix_length) in [
        ("sk-", 12),
        ("ghp_", 20),
        ("gho_", 20),
        ("ghu_", 20),
        ("ghs_", 20),
        ("ghr_", 20),
    ] {
        for (start, _) in normalized.match_indices(prefix) {
            if start > 0 && is_name_byte(bytes[start - 1]) {
                continue;
            }
            let mut end = start + prefix.len();
            while end < bytes.len() && is_name_byte(bytes[end]) {
                end += 1;
            }
            if end - (start + prefix.len()) >= minimum_suffix_length {
                ranges.push((start, end));
            }
        }
    }

    let is_jwt_byte = |value: u8| is_name_byte(value) || value == b'.';
    let mut jwt_start = 0;
    while jwt_start < bytes.len() {
        while jwt_start < bytes.len() && !is_jwt_byte(bytes[jwt_start]) {
            jwt_start += 1;
        }
        let mut jwt_end = jwt_start;
        while jwt_end < bytes.len() && is_jwt_byte(bytes[jwt_end]) {
            jwt_end += 1;
        }
        if jwt_end > jwt_start {
            let candidate = &normalized[jwt_start..jwt_end];
            let segments = candidate.split('.').collect::<Vec<_>>();
            if matches!(segments.len(), 3 | 4)
                && segments.iter().all(|segment| {
                    segment.len() >= 8
                        && segment.bytes().all(|value| {
                            value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-')
                        })
                })
            {
                ranges.push((jwt_start, jwt_end));
            }
        }
        jwt_start = jwt_end.saturating_add(1);
    }

    // Bearer credentials can appear outside a named header in provider errors.
    for (start, _) in normalized.match_indices("bearer") {
        let before_is_name = start > 0 && is_name_byte(bytes[start - 1]);
        let mut value_start = start + "bearer".len();
        if before_is_name || value_start >= bytes.len() || !bytes[value_start].is_ascii_whitespace()
        {
            continue;
        }
        while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
            value_start += 1;
        }
        let (value_start, quote) = quoted_value_start(value_start);
        if is_redaction_marker(value_start) {
            continue;
        }
        let end = quote.map_or_else(
            || {
                let end = value_end(value_start);
                if end > value_start && matches!(bytes[end - 1], b'\'' | b'"') {
                    let mut delimiter_start = end - 1;
                    while delimiter_start > value_start && bytes[delimiter_start - 1] == b'\\' {
                        delimiter_start -= 1;
                    }
                    delimiter_start
                } else {
                    end
                }
            },
            |quote| quoted_value_end(value_start, quote),
        );
        if end > value_start {
            ranges.push((value_start, end));
        }
    }

    // Redact only assignment values. Words such as "authorization" in a
    // provider diagnostic are useful context and are not secrets by themselves.
    let sensitive_keys = [
        "authorization",
        "api key",
        "api-key",
        "api_key",
        "apikey",
        "browser code",
        "browser-code",
        "browser_code",
        "browsercode",
        "connection string",
        "connection-string",
        "connection_string",
        "connectionstring",
        "cookie",
        "credential",
        "jwt",
        "login url",
        "login-url",
        "login_url",
        "loginurl",
        "password",
        "passwd",
        "private key",
        "private-key",
        "private_key",
        "privatekey",
        "secret",
        "ticket",
        "token",
    ];
    let mut sensitive_key_matches = Vec::new();
    for key in sensitive_keys {
        for (start, _) in normalized.match_indices(key) {
            sensitive_key_matches.push((start, key));
        }
    }
    // Process candidates in diagnostic order rather than key-list order. Once
    // an earlier field claims its value range, credential-shaped text inside
    // that value cannot be reinterpreted as another field on this pass.
    sensitive_key_matches.sort_unstable_by(|(left_start, left_key), (right_start, right_key)| {
        left_start
            .cmp(right_start)
            .then_with(|| right_key.len().cmp(&left_key.len()))
    });
    for (start, key) in sensitive_key_matches {
        if ranges
            .iter()
            .any(|(range_start, range_end)| start >= *range_start && start < *range_end)
        {
            continue;
        }
        let key_is_compound = start > 0 && is_name_byte(bytes[start - 1]);
        let mut separator = start + key.len();
        // Match the full sensitive name or a compound identifier that ends
        // with it (for example OPENAI_API_KEY or proxyAuthorization).
        if separator < bytes.len() && is_name_byte(bytes[separator]) {
            continue;
        }
        // Serialized diagnostics commonly quote object keys before the
        // assignment separator: {"access_token":"..."}.
        while separator < bytes.len() && bytes[separator] == b'\\' {
            separator += 1;
        }
        if separator < bytes.len() && matches!(bytes[separator], b'\'' | b'"') {
            separator += 1;
        }
        let whitespace_start = separator;
        while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
            separator += 1;
        }
        let has_assignment_separator =
            separator < bytes.len() && matches!(bytes[separator], b':' | b'=');
        // Provider diagnostics also use shell-style `token value` pairs.
        // Keep free-form authorization prose visible; only explicit Bearer
        // and Basic scheme/value pairs use whitespace as their separator.
        let authorization_scheme_start = quoted_value_start(separator).0;
        let has_authorization_scheme = ["bearer", "basic"].iter().any(|scheme| {
            normalized[authorization_scheme_start..].starts_with(scheme)
                && authorization_scheme_start + scheme.len() < bytes.len()
                && bytes[authorization_scheme_start + scheme.len()].is_ascii_whitespace()
        });
        let has_whitespace_separator = separator > whitespace_start
            && (key != "authorization" || key_is_compound || has_authorization_scheme);
        if !has_assignment_separator && !has_whitespace_separator {
            continue;
        }
        let mut value_start = if has_assignment_separator {
            separator + 1
        } else {
            separator
        };
        while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
            value_start += 1;
        }
        let (next_value_start, mut quote) = quoted_value_start(value_start);
        value_start = next_value_start;
        let mut recognized_authorization_scheme = false;
        if key == "authorization" {
            for scheme in ["bearer", "basic"] {
                if !normalized[value_start..].starts_with(scheme) {
                    continue;
                }
                let after_scheme = value_start + scheme.len();
                if after_scheme >= bytes.len() || !bytes[after_scheme].is_ascii_whitespace() {
                    continue;
                }
                recognized_authorization_scheme = true;
                value_start = after_scheme;
                while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
                    value_start += 1;
                }
                if quote.is_none() {
                    (value_start, quote) = quoted_value_start(value_start);
                }
                break;
            }
        }
        if is_redaction_marker(value_start) {
            continue;
        }
        let end = if let Some(quote) = quote {
            quoted_value_end(value_start, quote)
        } else if key == "authorization"
            && has_assignment_separator
            && !recognized_authorization_scheme
        {
            let mut end = value_start;
            while end < bytes.len() && !matches!(bytes[end], b'\n' | b'\r' | b',' | b';' | b'&') {
                end += 1;
            }
            end
        } else {
            value_end(value_start)
        };
        if end > value_start {
            ranges.push((value_start, end));
        }
    }

    if ranges.is_empty() {
        return input.to_owned();
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        if let Some((_, previous_end)) = merged.last_mut() {
            if start <= *previous_end {
                *previous_end = (*previous_end).max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    for (start, end) in merged {
        output.push_str(&input[cursor..start]);
        output.push_str("[REDACTED]");
        cursor = end;
    }
    output.push_str(&input[cursor..]);
    output
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
            ca_bundle_path: None,
            state_dir,
            runner_instance_id: "runner_1".to_owned(),
            environment_lease_id: "environment_1".to_owned(),
            run_id: "run_1".to_owned(),
            normalized_session_id: "session_1".to_owned(),
            turn_id: "turn_1".to_owned(),
            item_id: "item_1".to_owned(),
            runner_version: "0.0.0".to_owned(),
            runner_digest: "sha256:test".to_owned(),
            acpx_launch_profile: None,
            opencode_launch_profile: None,
            max_outbox_bytes: 16_384,
            p0_reserve_bytes: 4096,
            max_frame_bytes: 65_536,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
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
    fn command_results_redact_display_text_but_reject_mutated_identity() {
        let config = config(PathBuf::from("unused"));
        let mut safe_state = DurableState::new(&config);
        let safe_command = command("command_safe", 1);
        safe_state.begin_command(&safe_command).unwrap();
        let completed = safe_state
            .complete_command(
                &safe_command,
                json!({"message": "token=command-result-secret", "inputTokens": 12}),
            )
            .unwrap();
        assert_eq!(completed.result["message"], "token=[REDACTED]");
        assert_eq!(completed.result["inputTokens"], 12);

        let mut unsafe_state = DurableState::new(&config);
        let unsafe_command = command("command_unsafe", 1);
        unsafe_state.begin_command(&unsafe_command).unwrap();
        let error = unsafe_state
            .complete_command(
                &unsafe_command,
                json!({"receiptId": "token=identity-secret"}),
            )
            .expect_err("replay-critical command identities must not be rewritten");
        assert!(error.to_string().contains(
            "command result identity or validation semantics contain credential-shaped material"
        ));
        assert_eq!(
            unsafe_state.processed_commands["command_unsafe"].status,
            "pending"
        );
    }

    #[test]
    fn usage_count_keys_only_bypass_redaction_for_numbers() {
        assert_eq!(
            sanitize_value(&json!({"inputTokens": 12, "outputTokens": 3})),
            json!({"inputTokens": 12, "outputTokens": 3})
        );
        assert_eq!(
            sanitize_value(&json!({"inputTokens": "plain-provider-secret"})),
            json!({"inputTokens": "[REDACTED]"})
        );
        for key in [
            "cachedReadTokens",
            "cachedWriteTokens",
            "thoughtTokens",
            "totalTokens",
        ] {
            assert_eq!(sanitize_value(&json!({key: 12})), json!({key: 12}));
            for value in [
                json!("plain-provider-secret"),
                json!({"value":"secret"}),
                json!(["secret"]),
            ] {
                assert_eq!(
                    sanitize_value(&json!({key: value})),
                    json!({key: "[REDACTED]"})
                );
            }
        }
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
                json!({"nested": {
                    "api_token": "secret-value",
                    "private_key": "private-provider-key",
                    "connectionString": "postgres://provider-secret/database",
                    "inputTokens": 42,
                    "eventType": "item.completed",
                    "channel": "final",
                    "kind": "message",
                    "diagnostic": r#"provider said Bearer \\"nested-secret\\" status=401"#,
                    "nestedAuthorizationDiagnostic": r#"{\"authorization\":\"CustomScheme \\"credential-tail\\"\"}"#,
                    "embeddedQuoteDiagnostic": r#"password=abc"defg status=403"#,
                    "multilineProviderDiagnostic": "authorization=\\\"Bearer first-line\nsecond-line\\\" status=401",
                    "newlineQuoteProviderDiagnostic": "authorization=\\\"Bearer first-line\\\"\nsecond-line\\\" status=401",
                    "providerApiKeyDiagnostic": "Invalid API key: sk-proj-provider-secret; request rejected",
                    "compoundWhitespaceDiagnostic": "OPENAI_API_KEY first-secret; proxyAuthorization Basic dXNlcjpwYXNz",
                }}),
            )
            .unwrap();
        assert_eq!(state.outbox[0].event_type, "runner.diagnostic");
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/api_token"),
            Some(&Value::String("[REDACTED]".to_owned()))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/private_key"),
            Some(&Value::String("[REDACTED]".to_owned()))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/connectionString"),
            Some(&Value::String("[REDACTED]".to_owned()))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/inputTokens"),
            Some(&json!(42))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/eventType"),
            Some(&json!("item.completed"))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/channel"),
            Some(&json!("final"))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/kind"),
            Some(&json!("message"))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/diagnostic"),
            Some(&json!(
                r#"provider said Bearer \\"[REDACTED]\\" status=401"#
            ))
        );
        let persisted_nested = state.outbox[0]
            .envelope
            .pointer("/payload/payload/nested/nestedAuthorizationDiagnostic")
            .and_then(Value::as_str)
            .unwrap();
        assert!(persisted_nested.contains("[REDACTED]"));
        assert!(!persisted_nested.contains("credential-tail"));
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/embeddedQuoteDiagnostic"),
            Some(&json!("password=[REDACTED] status=403"))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/multilineProviderDiagnostic"),
            Some(&json!(r#"authorization=\"Bearer [REDACTED]\" status=401"#))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/newlineQuoteProviderDiagnostic"),
            Some(&json!(r#"authorization=\"Bearer [REDACTED]\" status=401"#))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/providerApiKeyDiagnostic"),
            Some(&json!("[REDACTED]"))
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/nested/compoundWhitespaceDiagnostic"),
            Some(&json!(
                "OPENAI_API_KEY [REDACTED]; proxyAuthorization Basic [REDACTED]"
            ))
        );
    }

    #[test]
    fn durable_question_sets_preserve_safe_identity_and_redact_display_text() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        state
            .enqueue_event(
                &config,
                "runtime_request.created",
                EventPriority::P0,
                json!({
                    "request": {
                        "schema": "paperclip.runtime_request.v2",
                        "requestKind": "runtime",
                        "requestId": "request-1",
                        "type": "input",
                        "status": "pending",
                        "prompt": "Choose one.",
                        "input": {
                            "schema": "paperclip.question_set.v1",
                            "title": "token=question-set-secret",
                            "questions": [{
                                "id": "stable-question-id",
                                "prompt": "password=question-prompt-secret",
                                "required": true,
                                "answerMode": "single_select",
                                "options": [{
                                    "id": "stable-option-id",
                                    "label": "secret=option-label-secret"
                                }],
                                "textValidation": {
                                    "pattern": "^[a-z]+$"
                                },
                                "helpText": "api_key=validation-message-secret"
                            }]
                        }
                    },
                    "diagnostic": "token=outside-secret"
                }),
            )
            .unwrap();

        let payload = state.outbox[0]
            .envelope
            .pointer("/payload/payload")
            .unwrap();
        assert_eq!(
            payload.pointer("/request/input/questions/0/id"),
            Some(&json!("stable-question-id"))
        );
        assert_eq!(
            payload.pointer("/request/input/questions/0/options/0/id"),
            Some(&json!("stable-option-id"))
        );
        assert_eq!(
            payload.pointer("/request/input/questions/0/textValidation/pattern"),
            Some(&json!("^[a-z]+$"))
        );
        assert_eq!(
            payload.pointer("/request/input/title"),
            Some(&json!("token=[REDACTED]"))
        );
        assert_eq!(
            payload.pointer("/request/input/questions/0/prompt"),
            Some(&json!("password=[REDACTED]"))
        );
        assert_eq!(
            payload.pointer("/request/input/questions/0/options/0/label"),
            Some(&json!("secret=[REDACTED]"))
        );
        assert_eq!(
            payload.pointer("/request/input/questions/0/helpText"),
            Some(&json!("api_key=[REDACTED]"))
        );
        assert_eq!(payload["diagnostic"], json!("token=[REDACTED]"));
    }

    #[test]
    fn credential_shaped_question_identity_and_validation_fail_closed() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        let error = state
            .enqueue_event(
                &config,
                "runtime_request.created",
                EventPriority::P0,
                json!({
                    "request": {
                        "schema": "paperclip.runtime_request.v2",
                        "requestKind": "runtime",
                        "requestId": "request-1",
                        "type": "input",
                        "status": "pending",
                        "prompt": "Choose one.",
                        "input": {
                            "schema": "paperclip.question_set.v1",
                            "questions": [{
                                "id": "token=question-secret",
                                "prompt": "Choose one.",
                                "required": true,
                                "answerMode": "single_select",
                                "options": [{
                                    "id": "abcdefgh.ijklmnop.qrstuvwx",
                                    "label": "Yes"
                                }],
                                "textValidation": {"pattern": "^token=pattern-secret$"}
                            }]
                        }
                    }
                }),
            )
            .expect_err("identity-bearing question fields must not be rewritten");
        assert!(error
            .to_string()
            .contains("identity or validation semantics contain credential-shaped material"));
        assert!(state.outbox.is_empty());
    }

    #[test]
    fn protocol_authorization_boundary_is_not_redacted_as_a_credential() {
        let sanitized = sanitize_value(&json!({
            "authorizationBoundary": "active_task",
            "nested": {"authorizationBoundary": "Bearer secret-value"},
            "authorization": "Bearer secret-value",
        }));
        assert_eq!(sanitized["authorizationBoundary"], json!("active_task"));
        assert_eq!(sanitized["authorization"], json!("[REDACTED]"));
        assert_eq!(
            sanitized["nested"]["authorizationBoundary"],
            json!("[REDACTED]")
        );
    }

    #[test]
    fn diagnostic_redaction_preserves_context_and_removes_only_secret_values() {
        assert_eq!(
            redact_text("request failed: authorization service returned 401 Unauthorized"),
            "request failed: authorization service returned 401 Unauthorized"
        );
        assert_eq!(
            redact_text("401 Unauthorized: Authorization: Bearer secret-value; retry over HTTPS"),
            "401 Unauthorized: Authorization: Bearer [REDACTED]; retry over HTTPS"
        );
        for delimiter_backslashes in 0..=4 {
            let delimiter = format!("{}\"", "\\".repeat(delimiter_backslashes));
            let input =
                format!("provider said Bearer {delimiter}secret-value{delimiter} status=401");
            let expected =
                format!("provider said Bearer {delimiter}[REDACTED]{delimiter} status=401");
            assert_eq!(redact_text(&input), expected);
            assert_eq!(redact_text(&expected), expected);
        }
        let unmatched = r#"provider said Bearer \\\"secret-value status=401"#;
        let redacted_unmatched = redact_text(unmatched);
        assert!(!redacted_unmatched.contains("secret-value"));
        let nested_quote = r#"{\"authorization\":\"CustomScheme \\\\"secret\\\\\"\"}"#;
        let redacted_nested_quote = redact_text(nested_quote);
        assert!(redacted_nested_quote.contains("[REDACTED]"));
        assert!(!redacted_nested_quote.contains("secret"));
        assert_eq!(redact_text(&redacted_nested_quote), redacted_nested_quote);
        for nested_depth in [2, 4] {
            let nested = format!("{}\"", "\\".repeat(nested_depth));
            let input = format!(
                "authorization:\"CustomScheme {nested}credential-tail{nested}\" status=401"
            );
            let expected = "authorization:\"[REDACTED]\" status=401";
            assert_eq!(redact_text(&input), expected);
            assert_eq!(redact_text(expected), expected);
        }
        assert_eq!(
            redact_text("request failed token=secret-value&reason=expired"),
            "request failed token=[REDACTED]&reason=expired"
        );
        assert_eq!(
            redact_text("request failed token secret-value; reason=expired"),
            "request failed token [REDACTED]; reason=expired"
        );
        assert_eq!(
            redact_text("provider rejected API key\tsecret-value retry"),
            "provider rejected API key\t[REDACTED] retry"
        );
        assert_eq!(
            redact_text("Authorization: Basic dXNlcjpwYXNz retry"),
            "Authorization: Basic [REDACTED] retry"
        );
        assert_eq!(
            redact_text("Authorization Basic dXNlcjpwYXNz retry"),
            "Authorization Basic [REDACTED] retry"
        );
        assert_eq!(
            redact_text("Authorization Bearer bearer-secret retry"),
            "Authorization Bearer [REDACTED] retry"
        );
        assert_eq!(
            redact_text(r#"Authorization "Basic dXNlcjpwYXNz" retry"#),
            r#"Authorization "Basic [REDACTED]" retry"#
        );
        assert_eq!(
            redact_text(r#"Authorization: "Bearer bearer-secret" retry"#),
            r#"Authorization: "Bearer [REDACTED]" retry"#
        );
        assert_eq!(
            redact_text("login failed password=\"two word secret\" status=403"),
            "login failed password=\"[REDACTED]\" status=403"
        );
        for (input, expected) in [
            (
                r#"login failed password=abc"defg status=403"#,
                "login failed password=[REDACTED] status=403",
            ),
            (
                "login failed password=abc'defg status=403",
                "login failed password=[REDACTED] status=403",
            ),
            (
                "login failed password=abc`defg status=403",
                "login failed password=[REDACTED] status=403",
            ),
            (
                r#"Authorization: Bearer abc"defg; retry"#,
                "Authorization: Bearer [REDACTED]; retry",
            ),
            (
                r#"OPENAI_API_KEY \"abc\"defg retry"#,
                r#"OPENAI_API_KEY \"[REDACTED]"#,
            ),
            (
                r#"proxyAuthorization Basic \"abc\"defg retry"#,
                r#"proxyAuthorization Basic \"[REDACTED]"#,
            ),
            (
                r#"OPENAI_API_KEY "abc"defg retry"#,
                r#"OPENAI_API_KEY "[REDACTED]"#,
            ),
            (
                "OPENAI_API_KEY \\\"abc\\\"defg retry\nsafe context",
                "OPENAI_API_KEY \\\"[REDACTED]",
            ),
            (
                "OPENAI_API_KEY \"abc\"defg retry\nsafe context",
                "OPENAI_API_KEY \"[REDACTED]",
            ),
            (
                "authorization=\\\"Bearer abc\ndef\\\" status=401",
                r#"authorization=\"Bearer [REDACTED]\" status=401"#,
            ),
            (
                "authorization=\"Bearer abc\ndef\" status=401",
                r#"authorization="Bearer [REDACTED]" status=401"#,
            ),
            (
                "authorization=\\\"Bearer abc\\\"\ndef\\\" status=401",
                r#"authorization=\"Bearer [REDACTED]\" status=401"#,
            ),
            (
                "authorization=\"Bearer abc\"\ndef\" status=401",
                r#"authorization="Bearer [REDACTED]" status=401"#,
            ),
            (
                "authorization=\\\"Bearer abc\\\"\ndef status=401",
                r#"authorization=\"Bearer [REDACTED]"#,
            ),
            (
                "authorization=\"Bearer abc\"\ndef status=401",
                r#"authorization="Bearer [REDACTED]"#,
            ),
            (
                "authorization=\\\"Bearer first-line\\\"\nrequest failed with Bearer standalone\\\"embedded-tail",
                "authorization=\\\"Bearer [REDACTED]\\\"\nrequest failed with Bearer [REDACTED]",
            ),
            (
                "authorization=\"Bearer first-line\"\nrequest failed with Bearer standalone\"embedded-tail",
                "authorization=\"Bearer [REDACTED]\"\nrequest failed with Bearer [REDACTED]",
            ),
            (
                r#"{\"authorization\":\"Bearer a\"b c\"} status=401"#,
                r#"{\"authorization\":\"Bearer [REDACTED]\"} status=401"#,
            ),
            (
                r#"{"authorization":"Bearer a"b c"} status=401"#,
                r#"{"authorization":"Bearer [REDACTED]"} status=401"#,
            ),
            (
                r#"{\"authorization\":\"Bearer a\" b c\"} status=401"#,
                r#"{\"authorization\":\"Bearer [REDACTED]\"} status=401"#,
            ),
            (
                r#"{"authorization":"Bearer a" b c"} status=401"#,
                r#"{"authorization":"Bearer [REDACTED]"} status=401"#,
            ),
        ] {
            assert_eq!(redact_text(input), expected);
            assert_eq!(redact_text(expected), expected);
        }
        assert_eq!(
            redact_text("OPENAI_API_KEY=secret-value access_token=other-secret"),
            "OPENAI_API_KEY=[REDACTED] access_token=[REDACTED]"
        );
        for (input, expected) in [
            (
                "OPENAI_API_KEY secret-value retry",
                "OPENAI_API_KEY [REDACTED] retry",
            ),
            (
                "access_token other-secret retry",
                "access_token [REDACTED] retry",
            ),
            (
                "clientSecret third-secret retry",
                "clientSecret [REDACTED] retry",
            ),
            (
                "proxyAuthorization Basic dXNlcjpwYXNz retry",
                "proxyAuthorization Basic [REDACTED] retry",
            ),
            (
                "proxyAuthorization proxy-secret retry",
                "proxyAuthorization [REDACTED] retry",
            ),
        ] {
            assert_eq!(redact_text(input), expected);
            assert_eq!(redact_text(expected), expected);
        }
        assert_eq!(
            redact_text(
                "openai_api_key=first-secret openaiApiKey=second-secret clientSecret=third-secret refreshToken=fourth-secret"
            ),
            "openai_api_key=[REDACTED] openaiApiKey=[REDACTED] clientSecret=[REDACTED] refreshToken=[REDACTED]"
        );
        assert_eq!(
            redact_text(
                "Proxy-Authorization: Basic dXNlcjpwYXNz; proxy_authorization=Bearer other-secret"
            ),
            "Proxy-Authorization: Basic [REDACTED]; proxy_authorization=Bearer [REDACTED]"
        );
        assert_eq!(
            redact_text(
                "proxyAuthorization: Bearer first-secret; ProxyAuthorization: Basic second-secret"
            ),
            "proxyAuthorization: Bearer [REDACTED]; ProxyAuthorization: Basic [REDACTED]"
        );
        assert_eq!(
            redact_text(
                r#"{"proxyAuthorization":"Bearer first-secret","access_token":"second-secret"}"#
            ),
            r#"{"proxyAuthorization":"Bearer [REDACTED]","access_token":"[REDACTED]"}"#
        );
        for (input, expected) in [
            (
                "Invalid API key: sk-proj-provider-secret; request rejected",
                "Invalid API key: [REDACTED]; request rejected",
            ),
            (
                "cookie=session-provider-secret; retry=false",
                "cookie=[REDACTED]; retry=false",
            ),
            (
                "credential=provider-secret connectionString=postgres://private-host/db",
                "credential=[REDACTED] connectionString=[REDACTED]",
            ),
            (
                "private_key=provider-secret loginUrl=https://secret.example.test/login",
                "private_key=[REDACTED] loginUrl=[REDACTED]",
            ),
            (
                "provider rejected sk-proj-abcdefghijklmnop before startup",
                "provider rejected [REDACTED] before startup",
            ),
            (
                "remote rejected ghp_abcdefghijklmnopqrstuvwx before startup",
                "remote rejected [REDACTED] before startup",
            ),
            (
                "provider rejected abcdefgh.ijklmnop.qrstuvwx before startup",
                "provider rejected [REDACTED] before startup",
            ),
        ] {
            assert_eq!(redact_text(input), expected);
            assert_eq!(redact_text(expected), expected);
        }
    }

    #[test]
    fn diagnostic_redaction_removes_complete_private_key_pem_blocks() {
        let complete = concat!(
            "provider rejected private key: -----BEGIN PRIVATE KEY-----\n",
            "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=\n",
            "-----END PRIVATE KEY-----\n",
            "status=401",
        );
        assert_eq!(
            redact_text(complete),
            "provider rejected private key: [REDACTED]\nstatus=401"
        );

        let escaped = concat!(
            "provider rejected -----BEGIN RSA PRIVATE KEY-----\\n",
            "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=\\n",
            "-----END RSA PRIVATE KEY----- status=401",
        );
        assert_eq!(
            redact_text(escaped),
            "provider rejected [REDACTED] status=401"
        );

        let padded_header = concat!(
            "provider rejected -----BEGIN PRIVATE KEY----- \t\n",
            "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=\n",
            "-----END PRIVATE KEY----- status=401",
        );
        assert_eq!(
            redact_text(padded_header),
            "provider rejected [REDACTED] status=401"
        );

        let escaped_padded_header = concat!(
            "provider rejected -----BEGIN RSA PRIVATE KEY----- \t\\n",
            "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=\\n",
            "-----END RSA PRIVATE KEY----- status=401",
        );
        assert_eq!(
            redact_text(escaped_padded_header),
            "provider rejected [REDACTED] status=401"
        );

        let unterminated = concat!(
            "provider rejected -----BEGIN OPENSSH PRIVATE KEY-----\n",
            "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
        );
        assert_eq!(redact_text(unterminated), "provider rejected [REDACTED]");
    }

    #[test]
    fn diagnostic_redaction_is_idempotent() {
        for input in [
            "Missing bearer secret-value",
            "Authorization: Bearer secret-value; retry",
            "token=secret-value&reason=expired",
            "token secret-value; reason=expired",
            "password=\"two word secret\" status=403",
        ] {
            let once = redact_text(input);
            assert_eq!(redact_text(&once), once);
        }
        assert_eq!(
            redact_text("Missing bearer [REDACTED]"),
            "Missing bearer [REDACTED]"
        );
    }

    #[test]
    fn diagnostic_redaction_still_bounds_retained_text() {
        let output = redact_text(&format!("token=secret-value {}", "x".repeat(4_096)));
        assert!(output.starts_with("token=[REDACTED] "));
        assert!(output.ends_with("…[truncated]"));
        assert!(!output.contains("secret-value"));
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
