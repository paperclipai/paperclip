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

use crate::provider_bridge::{semantic_value_digest, MAX_COMPLETION_SUMMARY_CHARS};

use super::{DurableRunnerConfig, DurableRunnerError, PROTOCOL, PROTOCOL_VERSION};

const STATE_SCHEMA: &str = "paperclip.runner.durable.state.v1";
pub(crate) const TRANSITION_STATE_SCHEMA: &str =
    "paperclip.runner.durable.state.warm-transition.v1";
const STATE_FILE: &str = "runner-state.json";
const MAX_RECENT_COMMANDS: usize = 128;
const MAX_DIAGNOSTICS: usize = 32;
const MAX_COMMAND_RESULT_BYTES: usize = 64 * 1024;
const MAX_EXECUTOR_EVENT_RECEIPTS: usize = 256;
const MAX_V2_REPLAY_EVENTS: usize = 2;
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

fn v2_replay_key(event_type: &str) -> Option<&'static str> {
    match event_type {
        "session.capabilities.updated" => Some("session.capabilities"),
        "session.goal.snapshot" | "session.goal.updated" | "session.goal.cleared" => {
            Some("session.goal")
        }
        _ => None,
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
        let schema_version = match self.schema.as_str() {
            "paperclip.prp.command.v1" => 1,
            "paperclip.prp.command.v2" => 2,
            _ => {
                return Err(DurableRunnerError::invalid(
                    "command requires a supported paperclip.prp.command schema",
                ));
            }
        };
        if schema_version == 1 && self.command_type.starts_with("session.goal.") {
            return Err(DurableRunnerError::invalid(
                "session goal commands require the paperclip.prp.command.v2 schema",
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
                | "session.goal.get"
                | "session.goal.set"
                | "session.goal.clear"
        ) {
            return Err(DurableRunnerError::invalid(format!(
                "command type is not supported by PRP v{schema_version}"
            )));
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
pub struct StoredV2ReplayEvent {
    pub source_seq: u64,
    pub priority: u8,
    pub event_type: String,
    pub payload: Value,
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WarmRunIdentity {
    pub runner_instance_id: String,
    pub environment_lease_id: String,
    pub run_id: String,
    pub normalized_session_id: String,
    pub turn_id: String,
    pub item_id: String,
}

impl WarmRunIdentity {
    pub(crate) fn from_config(config: &DurableRunnerConfig) -> Self {
        Self {
            runner_instance_id: config.runner_instance_id.clone(),
            environment_lease_id: config.environment_lease_id.clone(),
            run_id: config.run_id.clone(),
            normalized_session_id: config.normalized_session_id.clone(),
            turn_id: config.turn_id.clone(),
            item_id: config.item_id.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WarmRunTransition {
    pub schema: String,
    pub transition_id: String,
    pub old_identity: WarmRunIdentity,
    pub new_identity: WarmRunIdentity,
    pub command_id: String,
    pub controller_seq: u64,
    pub command_fingerprint: String,
    pub result_digest: String,
    pub old_acked_source_seq: u64,
    pub connection: Value,
    pub runner_version: String,
    pub runner_digest: String,
    pub lease_id: String,
    pub lease_expires_at_unix_ms: u64,
    pub lease_revocation_epoch: u64,
}

impl WarmRunTransition {
    pub(crate) fn new(
        config: &DurableRunnerConfig,
        next: &DurableRunnerConfig,
        command: &Command,
        result: &StoredCommandResult,
        ack: u64,
        lease_id: String,
        lease_expires_at_unix_ms: u64,
        lease_revocation_epoch: u64,
    ) -> Result<Self, DurableRunnerError> {
        let mut receipt = Self {
            schema: "paperclip.runner.warm-transition.v1".to_owned(),
            transition_id: String::new(),
            old_identity: WarmRunIdentity::from_config(config),
            new_identity: WarmRunIdentity::from_config(next),
            command_id: command.command_id.clone(),
            controller_seq: command.controller_seq,
            command_fingerprint: command_fingerprint(command)?,
            result_digest: canonical_digest(
                &serde_json::to_value(result)
                    .map_err(|error| DurableRunnerError::invalid(error.to_string()))?,
            ),
            old_acked_source_seq: ack,
            connection: command
                .payload
                .pointer("/paperclipNextAuthority/connection")
                .cloned()
                .ok_or_else(|| DurableRunnerError::invalid("warm transition connection missing"))?,
            runner_version: config.runner_version.clone(),
            runner_digest: config.runner_digest.clone(),
            lease_id,
            lease_expires_at_unix_ms,
            lease_revocation_epoch,
        };
        let mut body = serde_json::to_value(&receipt)
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        body.as_object_mut()
            .expect("receipt object")
            .remove("transitionId");
        receipt.transition_id = canonical_digest(&body);
        Ok(receipt)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingWarmRunTransition {
    pub receipt: WarmRunTransition,
    pub phase: String,
    pub command: Command,
    pub result: StoredCommandResult,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pending_provider_cleanup: Option<PendingTerminalDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) warm_transition: Option<PendingWarmRunTransition>,
    #[serde(default)]
    executor_event_receipts: BTreeMap<String, ExecutorEventReceipt>,
    #[serde(default)]
    v2_replay_events: BTreeMap<String, StoredV2ReplayEvent>,
    #[serde(default)]
    pub last_connection_protocol_version: Option<u64>,
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
            pending_provider_cleanup: None,
            warm_transition: None,
            executor_event_receipts: BTreeMap::new(),
            v2_replay_events: BTreeMap::new(),
            last_connection_protocol_version: None,
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
        validate_semantic_tool_input_digest(event_type, payload)?;
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
        validate_semantic_tool_input_digest(event_type.as_str(), &payload)?;

        let sanitized_payload = sanitize_value(&payload);
        if durable_semantics_changed_by_sanitization(&payload, &sanitized_payload) {
            return Err(DurableRunnerError::invalid(
                "durable identity or validation semantics contain credential-shaped material",
            ));
        }
        let sanitized_payload =
            finalize_semantic_tool_input_payload(event_type.as_str(), &payload, sanitized_payload)?;

        let source_seq = self.next_source_seq;
        let emitted_at = current_timestamp()?;
        let schema_version = if matches!(
            event_type.as_str(),
            "session.capabilities.updated"
                | "session.goal.snapshot"
                | "session.goal.updated"
                | "session.goal.cleared"
        ) {
            2
        } else {
            1
        };
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
                "schema": format!("paperclip.prp.event.v{schema_version}"),
                "sourceEventId": source_event_id,
                "sourceSeq": source_seq,
                "sourceInstanceId": self.runner_instance_id,
                "sourceKind": "runner",
                "runId": self.run_id,
                "normalizedSessionId": self.normalized_session_id,
                "turnId": self.turn_id,
                "itemId": self.item_id,
                "eventType": event_type,
                "schemaVersion": schema_version,
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
            event_type: event_type.clone(),
            envelope,
            byte_size,
        });
        if let Some(replay_key) = v2_replay_key(&event_type) {
            self.v2_replay_events.insert(
                replay_key.to_owned(),
                StoredV2ReplayEvent {
                    source_seq,
                    priority: priority.number(),
                    event_type,
                    payload: sanitize_value(&payload),
                },
            );
        }
        self.peak_outbox_bytes = self.peak_outbox_bytes.max(projected);
        Ok(source_seq)
    }

    pub fn apply_ack(
        &mut self,
        acked_source_seq: u64,
        protocol_version: u64,
    ) -> Result<(), DurableRunnerError> {
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
        if protocol_version >= 2 {
            self.v2_replay_events
                .retain(|_, event| event.source_seq > acked_source_seq);
        }
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

    pub(crate) fn has_unobserved_v2_session_state(&self) -> bool {
        !self.v2_replay_events.is_empty()
    }

    pub(crate) fn restore_v2_replay_events(
        &mut self,
        config: &DurableRunnerConfig,
    ) -> Result<(), DurableRunnerError> {
        let replay = self
            .v2_replay_events
            .values()
            .filter(|event| event.source_seq <= self.acked_source_seq)
            .cloned()
            .collect::<Vec<_>>();
        for event in replay {
            let priority = match event.priority {
                0 => EventPriority::P0,
                1 => EventPriority::P1,
                2 => EventPriority::P2,
                _ => {
                    return Err(DurableRunnerError::invalid(
                        "v2 replay event priority is invalid",
                    ));
                }
            };
            self.enqueue_event(config, event.event_type, priority, event.payload)?;
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

        if self.processed_commands.len() >= MAX_RECENT_COMMANDS
            && self
                .pending_provider_cleanup
                .as_ref()
                .is_some_and(|pending| {
                    self.processed_commands
                        .values()
                        .min_by_key(|result| result.controller_seq)
                        .is_some_and(|oldest| oldest.command_id == pending.command_id)
                })
        {
            // The marker's exact failed terminal receipt is still authority.
            // Refuse before journaling/effects instead of evicting that receipt
            // or allowing an unbounded sequence of unsuccessful cleanup stops.
            return Err(DurableRunnerError::invalid(
                "provider cleanup exhausted its bounded command journal; operator recovery is required",
            ));
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

pub(crate) fn command_fingerprint(command: &Command) -> Result<String, DurableRunnerError> {
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

pub(crate) fn canonical_digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical_json(value).as_bytes()))
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
    if (state.schema != STATE_SCHEMA && state.schema != TRANSITION_STATE_SCHEMA)
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
    match &state.warm_transition {
        None if state.schema == STATE_SCHEMA => {}
        Some(transition) if state.schema == TRANSITION_STATE_SCHEMA => {
            if !matches!(transition.phase.as_str(), "prepared" | "activating")
                || state.pending_terminal_delivery.is_some()
                || state.pending_provider_cleanup.is_some()
                || !state.outbox.is_empty()
                || transition.result.status != "completed"
                || transition.result.command_id != transition.command.command_id
                || transition.result.controller_seq != transition.command.controller_seq
                || transition.result.command_type != "run.attach"
            {
                return Err(DurableRunnerError::invalid(
                    "warm transition state is inconsistent",
                ));
            }
            transition.command.validate()?;
            let mut old = config.clone();
            let identity = &transition.receipt.old_identity;
            old.runner_instance_id = identity.runner_instance_id.clone();
            old.environment_lease_id = identity.environment_lease_id.clone();
            old.run_id = identity.run_id.clone();
            old.normalized_session_id = identity.normalized_session_id.clone();
            old.turn_id = identity.turn_id.clone();
            old.item_id = identity.item_id.clone();
            old.validate()?;
            let next = super::runner::next_authority_config(&transition.command, &old)?
                .ok_or_else(|| DurableRunnerError::invalid("warm transition has no target"))?;
            let expected = WarmRunTransition::new(
                &old,
                &next,
                &transition.command,
                &transition.result,
                transition.receipt.old_acked_source_seq,
                transition.receipt.lease_id.clone(),
                transition.receipt.lease_expires_at_unix_ms,
                transition.receipt.lease_revocation_epoch,
            )?;
            if expected != transition.receipt
                || WarmRunIdentity::from_config(config)
                    != if transition.phase == "prepared" {
                        expected.old_identity
                    } else {
                        expected.new_identity
                    }
                || (transition.phase == "prepared"
                    && (state.acked_source_seq != expected.old_acked_source_seq
                        || state.processed_commands.get(&transition.command.command_id)
                            != Some(&transition.result)))
            {
                return Err(DurableRunnerError::invalid(
                    "warm transition receipt binding is invalid",
                ));
            }
        }
        _ => {
            return Err(DurableRunnerError::invalid(
                "warm transition schema fence is invalid",
            ))
        }
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
    let v2_replay_events_are_valid = state.v2_replay_events.len() <= MAX_V2_REPLAY_EVENTS
        && state.v2_replay_events.iter().all(|(key, replay)| {
            v2_replay_key(&replay.event_type) == Some(key.as_str())
                && replay.source_seq > 0
                && replay.source_seq <= state.highest_source_seq()
                && replay.priority <= 2
                && replay.payload.is_object()
                && (replay.source_seq <= state.acked_source_seq
                    || state.outbox.iter().any(|event| {
                        event.source_seq == replay.source_seq
                            && event.priority == replay.priority
                            && event.event_type == replay.event_type
                            && event.envelope.pointer("/payload/payload") == Some(&replay.payload)
                    }))
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
    let pending_provider_cleanup_is_valid =
        state
            .pending_provider_cleanup
            .as_ref()
            .is_none_or(|pending| {
                let lifecycle = match pending.command_type.as_str() {
                    "runner.suspend" => "suspended",
                    "runner.shutdown" => "stopped",
                    _ => return false,
                };
                pending.lifecycle == lifecycle
                    && pending.controller_seq <= state.last_controller_command_seq
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
        || !v2_replay_events_are_valid
        || state
            .last_connection_protocol_version
            .is_some_and(|version| !(1..=PROTOCOL_VERSION).contains(&version))
        || !pending_terminal_delivery_is_valid
        || !pending_provider_cleanup_is_valid
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
    if normalized == "tokenbudgetcontrol" {
        return !value.is_boolean();
    }
    if normalized == "tokenbudget" {
        return !value.is_number() && !value.is_null();
    }
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
            | "tokensused"
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

pub(crate) fn sanitize_semantic_tool_input(
    operation_id: &str,
    input: &Value,
) -> Result<Value, DurableRunnerError> {
    let mut sanitized = sanitize_value(input);
    // Mutation prose is the user's intended work, not a diagnostic. Preserve
    // ordinary references to a token in these declared text fields; credential
    // syntax and high-confidence secret values are still scrubbed. All other
    // fields and operations retain the strict diagnostic policy.
    let prose_fields: &[&str] = match operation_id {
        "create_task" => &["title", "description", "initialPlan"],
        "create_project" => &["name", "description"],
        "write_document" => &["title", "body", "changeSummary"],
        _ => &[],
    };
    if let Some(sanitized_input) = sanitized.as_object_mut() {
        for field in prose_fields {
            if let Some(text) = input.get(*field).and_then(Value::as_str) {
                sanitized_input.insert(
                    (*field).to_owned(),
                    // The tool/API schema bounds business content. A diagnostic
                    // preview limit must never truncate a plan or document.
                    Value::String(redact_sensitive_text_values_with_context(text, true)),
                );
            }
        }
    }
    if !matches!(operation_id, "paperclip_finish" | "paperclip_block") {
        return Ok(sanitized);
    }
    let Some(summary) = input.get("summary").and_then(Value::as_str) else {
        return Ok(sanitized);
    };
    if summary.chars().count() > MAX_COMPLETION_SUMMARY_CHARS {
        return Err(DurableRunnerError::invalid(
            "semantic completion summary exceeds the 12,000 character limit",
        ));
    }
    let Some(sanitized_input) = sanitized.as_object_mut() else {
        return Ok(sanitized);
    };
    // Completion summary is the schema-bounded user-facing answer, not an
    // untrusted diagnostic snippet. Preserve it in full while applying the
    // same credential scrubber used by every durable string. All other fields
    // retain the generic 4 KiB diagnostic bound.
    sanitized_input.insert(
        "summary".to_owned(),
        Value::String(redact_sensitive_text_values(summary)),
    );
    Ok(sanitized)
}

fn finalize_semantic_tool_input_payload(
    event_type: &str,
    original: &Value,
    mut sanitized: Value,
) -> Result<Value, DurableRunnerError> {
    if event_type != "semantic_tool.input" {
        return Ok(sanitized);
    }
    let Some(original_tool) = original.get("semantic_tool") else {
        return Ok(sanitized);
    };
    if original_tool.get("schema").and_then(Value::as_str) != Some("paperclip.prp.semantic_tool.v1")
        || original_tool.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || original_tool.get("phase").and_then(Value::as_str) != Some("input")
    {
        return Ok(sanitized);
    }
    let Some(operation_id) = original_tool.get("operationId").and_then(Value::as_str) else {
        return Ok(sanitized);
    };
    let Some(original_input) = original_tool.get("input") else {
        return Ok(sanitized);
    };
    let finalized_input = sanitize_semantic_tool_input(operation_id, original_input)?;
    let Some(sanitized_tool) = sanitized
        .get_mut("semantic_tool")
        .and_then(Value::as_object_mut)
    else {
        return Ok(sanitized);
    };
    let Some(content) = sanitized_tool
        .get_mut("content")
        .and_then(Value::as_object_mut)
    else {
        return Ok(sanitized);
    };
    content.insert(
        "digest".to_owned(),
        Value::String(semantic_value_digest(&finalized_input)),
    );
    sanitized_tool.insert("input".to_owned(), finalized_input);
    Ok(sanitized)
}

fn validate_semantic_tool_input_digest(
    event_type: &str,
    payload: &Value,
) -> Result<(), DurableRunnerError> {
    if event_type != "semantic_tool.input" {
        return Ok(());
    }
    let Some(semantic_tool) = payload.get("semantic_tool") else {
        return Ok(());
    };
    if semantic_tool.get("schema").and_then(Value::as_str) != Some("paperclip.prp.semantic_tool.v1")
        || semantic_tool.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || semantic_tool.get("phase").and_then(Value::as_str) != Some("input")
    {
        return Ok(());
    }
    let input = semantic_tool.get("input").ok_or_else(|| {
        DurableRunnerError::invalid("semantic tool input event omitted its input")
    })?;
    let digest = semantic_tool
        .get("content")
        .and_then(|content| content.get("digest"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DurableRunnerError::invalid("semantic tool input event omitted its content digest")
        })?;
    if digest != semantic_value_digest(input) {
        return Err(DurableRunnerError::invalid(
            "semantic tool input content digest does not match its transmitted input",
        ));
    }
    Ok(())
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
    redact_sensitive_text_values_with_context(input, false)
}

fn redact_sensitive_text_values_with_context(input: &str, semantic_prose: bool) -> String {
    let normalized = input.to_ascii_lowercase();
    let bytes = normalized.as_bytes();
    let mut ranges: Vec<(usize, usize)> = Vec::new();

    let is_name_byte = |value: u8| value.is_ascii_alphanumeric() || value == b'_' || value == b'-';
    let is_value_end = |value: u8| {
        value.is_ascii_whitespace() || matches!(value, b',' | b';' | b'&' | b')' | b']' | b'}')
    };
    // Preserve one sentence-final period, never an embedded/repeated dot or
    // quoted value content. Even a credential ending here remains fully masked
    // apart from this punctuation character. JWT validation uses this same
    // boundary so a sentence period cannot hide an otherwise valid JWT.
    let without_sentence_period = |start: usize, end: usize| {
        if end > start + 1
            && bytes[end - 1] == b'.'
            && bytes[end - 2] != b'.'
            && bytes
                .get(end)
                .is_none_or(|value| value.is_ascii_whitespace())
        {
            end - 1
        } else {
            end
        }
    };
    let value_end = |start: usize| {
        let mut end = start;
        while end < bytes.len() && !is_value_end(bytes[end]) {
            end += 1;
        }
        without_sentence_period(start, end)
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
        ("github_pat_", 20),
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
        let candidate_end = without_sentence_period(jwt_start, jwt_end);
        if candidate_end > jwt_start {
            let candidate = &normalized[jwt_start..candidate_end];
            let segments = candidate.split('.').collect::<Vec<_>>();
            if matches!(segments.len(), 3 | 4)
                && segments.iter().all(|segment| {
                    segment.len() >= 8
                        && segment.bytes().all(|value| {
                            value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-')
                        })
                })
            {
                ranges.push((jwt_start, candidate_end));
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
        // A small closed set of grammatical noun/count phrases is prose, not
        // the diagnostic field/value pair "token opaque-value". Keep this
        // exception exact: assignments, quoted/compound/CLI keys or values,
        // and arbitrary words after token still use the ordinary scanners.
        let token_phrase_has_lead = |lead: &str| {
            normalized[..start]
                .strip_suffix(lead)
                .is_some_and(|before| {
                    before.is_empty()
                        || before
                            .as_bytes()
                            .last()
                            .is_some_and(|value| value.is_ascii_whitespace())
                })
        };
        let token_phrase_has_tail = |tail: &str| {
            normalized[separator..].starts_with(tail)
                && bytes.get(separator + tail.len()).is_none_or(|value| {
                    value.is_ascii_whitespace()
                        || (matches!(value, b'.' | b',' | b';' | b')')
                            && bytes
                                .get(separator + tail.len() + 1)
                                .is_none_or(|next| next.is_ascii_whitespace()))
                })
        };
        let token_phrase_follows_list_delimiter = || {
            let before = &normalized[..start];
            start == 0
                || [", ", "; ", ": ", "\n", "- "]
                    .iter()
                    .any(|delimiter| before.ends_with(delimiter))
        };
        let has_hyphenated_count_lead = token_phrase_has_lead("one-");
        // A bare token reference in declared mutation prose can be an output
        // requirement. Auth/access/session context, explicit assignment,
        // quoted credentials and CLI/compound names remain credential pairs.
        // Known key/JWT/Bearer values are independently scrubbed above.
        let is_semantic_token_reference = semantic_prose
            && key == "token"
            && !key_is_compound
            && whitespace_start == start + key.len()
            && separator > whitespace_start
            && !has_assignment_separator
            && bytes[whitespace_start..separator]
                .iter()
                .all(|value| matches!(value, b' ' | b'\t'))
            && quoted_value_start(separator).1.is_none()
            && ![
                "auth ",
                "authentication ",
                "authorization ",
                "access ",
                "refresh ",
                "session ",
                "api ",
                "security ",
                "secret ",
                "credential ",
                "bearer ",
            ]
            .iter()
            .any(|lead| token_phrase_has_lead(lead));
        let is_benign_token_noun_phrase = key == "token"
            && (!key_is_compound || has_hyphenated_count_lead)
            && whitespace_start == start + key.len()
            && !has_assignment_separator
            && bytes[whitespace_start..separator]
                .iter()
                .all(|value| matches!(value, b' ' | b'\t'))
            && ((token_phrase_has_tail("system")
                && [
                    "a ",
                    "the ",
                    "a simple ",
                    "the simple ",
                    "a balanced ",
                    "the balanced ",
                    "a transparent ",
                    "the transparent ",
                ]
                .iter()
                .any(|lead| token_phrase_has_lead(lead)))
                || (token_phrase_has_tail("economy")
                    && ["a balanced ", "the balanced ", "the "]
                        .iter()
                        .any(|lead| token_phrase_has_lead(lead)))
                || (["station", "rules"]
                    .iter()
                    .any(|tail| token_phrase_has_tail(tail))
                    && token_phrase_has_lead("the "))
                || (["design", "values"]
                    .iter()
                    .any(|tail| token_phrase_has_tail(tail))
                    && ["a jade ", "the "]
                        .iter()
                        .any(|lead| token_phrase_has_lead(lead)))
                || (token_phrase_has_tail("exchanges") && token_phrase_has_lead("standard "))
                || (["count", "limits"]
                    .iter()
                    .any(|tail| token_phrase_has_tail(tail))
                    && token_phrase_has_lead("and "))
                || (["limit", "rule"]
                    .iter()
                    .any(|tail| token_phrase_has_tail(tail))
                    && has_hyphenated_count_lead)
                || (token_phrase_has_tail("reconciliation, and cleanup")
                    && token_phrase_follows_list_delimiter())
                || (["for", "per"]
                    .iter()
                    .any(|tail| token_phrase_has_tail(tail))
                    && [
                        "one ",
                        "two ",
                        "first ",
                        "second ",
                        "each ",
                        "another ",
                        "additional ",
                    ]
                    .iter()
                    .any(|lead| token_phrase_has_lead(lead)))
                || (token_phrase_has_tail("can equal") && token_phrase_has_lead("one ")));
        let has_whitespace_separator = separator > whitespace_start
            && (key != "authorization" || key_is_compound || has_authorization_scheme)
            && !is_benign_token_noun_phrase
            && !is_semantic_token_reference;
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
            without_sentence_period(value_start, end)
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

    #[test]
    fn session_goal_commands_require_and_accept_the_v2_schema() {
        let mut goal = command("goal-command", 1);
        goal.command_type = "session.goal.set".to_owned();
        assert!(goal.validate().is_err());
        goal.schema = "paperclip.prp.command.v2".to_owned();
        assert!(goal.validate().is_ok());
    }

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "paperclip-runner-durable-{label}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn warm_transition_snapshot_is_exact_and_never_a_legacy_state() {
        let directory = temporary_directory("warm-transition-binding");
        let _ = fs::remove_dir_all(&directory);
        let mut old = config(directory.clone());
        old.runner_digest = format!("sha256:{}", "a".repeat(64));
        let mut next = old.clone();
        next.run_id = "run_2".to_owned();
        next.turn_id = "turn_2".to_owned();
        next.item_id = "item_2".to_owned();
        let mut attach = command("attach_exact", 1);
        attach.command_type = "run.attach".to_owned();
        attach.payload = json!({"paperclipNextAuthority": {
            "identity": WarmRunIdentity::from_config(&next),
            "connection": {"mode": "connect", "connectUrl": next.connect_url},
        }});
        let mut state = DurableState::new(&old);
        state.begin_command(&attach).unwrap();
        let result = state
            .complete_command(&attach, json!({"status": "attached"}))
            .unwrap();
        let receipt = WarmRunTransition::new(
            &old,
            &next,
            &attach,
            &result,
            0,
            "lease_exact".to_owned(),
            1_800_000_000_000,
            0,
        )
        .unwrap();
        state.schema = TRANSITION_STATE_SCHEMA.to_owned();
        state.warm_transition = Some(PendingWarmRunTransition {
            receipt,
            phase: "prepared".to_owned(),
            command: attach,
            result,
        });
        let store = DurableStateStore::new(&directory).unwrap();
        store.save(&state).unwrap();
        let (loaded, recovered) = store.load_or_create(&old).unwrap();
        assert!(recovered);
        assert_eq!(loaded.warm_transition, state.warm_transition);
        assert!(
            store.load_or_create(&next).is_err(),
            "prepared state is old authority only"
        );
        let original = serde_json::to_value(&state).unwrap();
        for (pointer, replacement) in [
            ("/schema", json!(STATE_SCHEMA)),
            ("/warmTransition/phase", json!("confirmed")),
            (
                "/warmTransition/receipt/transitionId",
                json!("f".repeat(64)),
            ),
            (
                "/warmTransition/receipt/newIdentity/runId",
                json!("foreign_run"),
            ),
            ("/warmTransition/receipt/leaseExpiresAtUnixMs", json!(1)),
            (
                "/warmTransition/receipt/runnerDigest",
                json!(format!("sha256:{}", "b".repeat(64))),
            ),
            (
                "/warmTransition/receipt/connection/connectUrl",
                json!("ws://127.0.0.1:9999/foreign"),
            ),
            ("/warmTransition/result/status", json!("failed")),
            (
                "/warmTransition/command/payload/paperclipNextAuthority/identity/itemId",
                json!("foreign_item"),
            ),
            ("/ackedSourceSeq", json!(1)),
        ] {
            let mut changed = original.clone();
            *changed.pointer_mut(pointer).unwrap() = replacement;
            let changed: DurableState = serde_json::from_value(changed).unwrap();
            store.save(&changed).unwrap();
            assert!(
                store.load_or_create(&old).is_err(),
                "mutated {pointer} must be rejected"
            );
        }
        let mut activating = DurableState::new(&next);
        activating.schema = TRANSITION_STATE_SCHEMA.to_owned();
        let mut pending = state.warm_transition.clone().unwrap();
        pending.phase = "activating".to_owned();
        activating.warm_transition = Some(pending);
        store.save(&activating).unwrap();
        store.load_or_create(&next).unwrap();
        assert!(
            store.load_or_create(&old).is_err(),
            "activating state is new authority only"
        );
        fs::remove_dir_all(directory).unwrap();
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
        state.apply_ack(1, 2).unwrap();
        assert_eq!(state.outbox.len(), 1);
        assert!(state.apply_ack(0, 2).is_err());
        assert!(state.apply_ack(3, 2).is_err());
    }

    #[test]
    fn session_goal_events_use_the_prp_v2_event_schema() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        state
            .enqueue_event(
                &config,
                "session.goal.snapshot",
                EventPriority::P0,
                json!({"goal": null}),
            )
            .unwrap();
        assert_eq!(
            state.outbox[0].envelope.pointer("/payload/schema"),
            Some(&json!("paperclip.prp.event.v2")),
        );
        assert_eq!(
            state.outbox[0].envelope.pointer("/payload/schemaVersion"),
            Some(&json!(2)),
        );
    }

    #[test]
    fn v1_acknowledgement_replays_latest_goal_state_for_v2() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        state
            .enqueue_event(
                &config,
                "session.goal.updated",
                EventPriority::P0,
                json!({"goal": {"objective": "durable objective", "status": "active"}}),
            )
            .unwrap();

        state.apply_ack(1, 1).unwrap();
        assert!(state.outbox.is_empty());
        assert_eq!(state.v2_replay_events["session.goal"].source_seq, 1);
        validate_binding(&state, &config, false).unwrap();

        state.restore_v2_replay_events(&config).unwrap();
        assert_eq!(state.outbox.len(), 1);
        assert_eq!(state.outbox[0].source_seq, 2);
        assert_eq!(
            state.outbox[0].envelope.pointer("/payload/eventType"),
            Some(&json!("session.goal.updated")),
        );
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/goal/objective"),
            Some(&json!("durable objective")),
        );

        state.apply_ack(2, 2).unwrap();
        assert!(state.outbox.is_empty());
        assert!(state.v2_replay_events.is_empty());
        validate_binding(&state, &config, false).unwrap();
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
    fn cleanup_marker_prevents_compacting_its_original_terminal_receipt() {
        let directory = temporary_directory("cleanup-command-capacity");
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut terminal = command("original-terminal", 1);
        terminal.command_type = "runner.suspend".to_owned();
        state.begin_command(&terminal).unwrap();
        let failed = state
            .fail_command(&terminal, json!({"code": "original_failure"}))
            .unwrap();
        state.lifecycle = "suspended".to_owned();
        state.pending_provider_cleanup = Some(PendingTerminalDelivery {
            command_id: terminal.command_id.clone(),
            controller_seq: terminal.controller_seq,
            command_type: terminal.command_type.clone(),
            lifecycle: "suspended".to_owned(),
        });
        for sequence in 2..=MAX_RECENT_COMMANDS as u64 {
            let mut stop = command(&format!("failed-stop-{sequence}"), sequence);
            stop.command_type = "turn.stop".to_owned();
            assert_eq!(
                state.begin_command(&stop).unwrap(),
                CommandDisposition::Execute
            );
            state
                .fail_command(&stop, json!({"code": "stop_failed"}))
                .unwrap();
        }
        let unchanged = serde_json::to_value(&state).unwrap();
        let mut overflow = command("one-stop-too-many", MAX_RECENT_COMMANDS as u64 + 1);
        overflow.command_type = "turn.stop".to_owned();
        state
            .begin_command(&overflow)
            .expect_err("a new command cannot compact the active cleanup authority");
        assert_eq!(serde_json::to_value(&state).unwrap(), unchanged);
        assert_eq!(state.processed_commands.len(), MAX_RECENT_COMMANDS);
        assert_eq!(
            state.processed_commands.get(&terminal.command_id),
            Some(&failed)
        );
        assert!(
            matches!(state.begin_command(&terminal).unwrap(), CommandDisposition::Replay(result) if result == failed)
        );
        store.save(&state).unwrap();
        let (restored, _) = store.load_or_create(&config).unwrap();
        assert_eq!(
            restored.pending_provider_cleanup,
            state.pending_provider_cleanup
        );
        assert_eq!(
            restored.processed_commands.get(&terminal.command_id),
            Some(&failed)
        );
        fs::remove_dir_all(directory).unwrap();
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
    fn semantic_finish_digest_covers_the_exact_finally_persisted_long_summary() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        let summary = format!(
            "token=do-not-persist {} Authorization: Bearer late-provider-secret COMPLETE-DURABLE-SUMMARY",
            "A complete paragraph for the user. ".repeat(180)
        );
        let input = json!({"summary": summary});
        let once_sanitized_input =
            sanitize_semantic_tool_input("paperclip_finish", &input).unwrap();
        let payload = json!({
            "semantic_tool": {
                "schema": "paperclip.prp.semantic_tool.v1",
                "schemaVersion": 1,
                "phase": "input",
                "operationId": "paperclip_finish",
                "callId": "call-1",
                "correlation": {
                    "runId": "run_1",
                    "normalizedSessionId": "session_1",
                    "turnId": "turn_1",
                    "itemId": "item_1",
                },
                "idempotencyKey": null,
                "content": {
                    "digest": crate::provider_bridge::semantic_value_digest(&once_sanitized_input),
                    "redactionDisposition": "digest_only",
                    "references": [],
                },
                "input": once_sanitized_input,
            },
        });

        state
            .enqueue_executor_event(
                &config,
                "provider-event-1".to_owned(),
                "semantic_tool.input".to_owned(),
                EventPriority::P0,
                payload.clone(),
            )
            .unwrap();

        let transmitted = state.outbox[0]
            .envelope
            .pointer("/payload/payload/semantic_tool/input")
            .unwrap();
        let transmitted_summary = transmitted["summary"].as_str().unwrap();
        assert!(transmitted_summary.starts_with("token=[REDACTED] "));
        assert!(transmitted_summary.ends_with(" COMPLETE-DURABLE-SUMMARY"));
        assert!(!transmitted_summary.contains("do-not-persist"));
        assert!(!transmitted_summary.contains("late-provider-secret"));
        assert!(transmitted_summary.contains("Authorization: Bearer [REDACTED]"));
        assert!(!transmitted_summary.contains("…[truncated]"));
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/semantic_tool/content/digest"),
            Some(&Value::String(
                crate::provider_bridge::semantic_value_digest(transmitted)
            ))
        );
        assert!(state
            .has_executor_event_receipt(
                "provider-event-1",
                "semantic_tool.input",
                EventPriority::P0,
                &payload,
            )
            .unwrap());

        let mut changed_tail = payload.clone();
        changed_tail["semantic_tool"]["input"]["summary"] = Value::String(format!(
            "token=[REDACTED] {} CHANGED-DURABLE-SUMMARY",
            "A complete paragraph for the user. ".repeat(180)
        ));
        assert!(state
            .has_executor_event_receipt(
                "provider-event-1",
                "semantic_tool.input",
                EventPriority::P0,
                &changed_tail,
            )
            .unwrap_err()
            .to_string()
            .contains("content digest does not match"));

        let generic = sanitize_value(&json!({"summary": "B".repeat(5_000)}));
        assert!(generic["summary"]
            .as_str()
            .unwrap()
            .ends_with("…[truncated]"));
    }

    #[test]
    fn semantic_summary_capacity_and_digest_resealing_fail_closed_outside_exact_finish_input() {
        let mut small_frame = config(PathBuf::from("unused"));
        small_frame.max_frame_bytes = 8_000;
        let mut state = DurableState::new(&small_frame);
        let long_input = json!({"summary": "C".repeat(12_000)});
        let safe_input = sanitize_semantic_tool_input("paperclip_finish", &long_input).unwrap();
        let exact_payload = json!({
            "semantic_tool": {
                "schema": "paperclip.prp.semantic_tool.v1",
                "schemaVersion": 1,
                "phase": "input",
                "operationId": "paperclip_finish",
                "content": {
                    "digest": semantic_value_digest(&safe_input),
                },
                "input": safe_input,
            },
        });
        assert!(state
            .enqueue_event(
                &small_frame,
                "semantic_tool.input",
                EventPriority::P0,
                exact_payload,
            )
            .unwrap_err()
            .to_string()
            .contains("transport frame limit"));
        assert!(sanitize_semantic_tool_input(
            "paperclip_finish",
            &json!({"summary": "C".repeat(MAX_COMPLETION_SUMMARY_CHARS + 1)}),
        )
        .unwrap_err()
        .to_string()
        .contains("12,000 character limit"));

        let config = config(PathBuf::from("unused"));
        let mut tampered_state = DurableState::new(&config);
        let once_sanitized = sanitize_value(&json!({"summary": "D".repeat(5_000)}));
        let original_digest = semantic_value_digest(&once_sanitized);
        let tampered_schema_payload = json!({
            "semantic_tool": {
                "schema": "paperclip.prp.semantic_tool.tampered",
                "phase": "input",
                "operationId": "paperclip_finish",
                "content": {"digest": original_digest.clone()},
                "input": once_sanitized,
            },
        });
        tampered_state
            .enqueue_event(
                &config,
                "semantic_tool.input",
                EventPriority::P0,
                tampered_schema_payload,
            )
            .unwrap();
        let transmitted = tampered_state.outbox[0]
            .envelope
            .pointer("/payload/payload/semantic_tool/input")
            .unwrap();
        assert!(transmitted["summary"]
            .as_str()
            .unwrap()
            .ends_with("…[truncated]"));
        assert_eq!(
            tampered_state.outbox[0]
                .envelope
                .pointer("/payload/payload/semantic_tool/content/digest"),
            Some(&Value::String(original_digest))
        );

        let mut generic_state = DurableState::new(&config);
        let generic_once_sanitized = sanitize_value(&json!({
            "query": "E".repeat(5_000),
        }));
        let generic_payload = json!({
            "semantic_tool": {
                "schema": "paperclip.prp.semantic_tool.v1",
                "schemaVersion": 1,
                "phase": "input",
                "operationId": "search_context",
                "content": {"digest": semantic_value_digest(&generic_once_sanitized)},
                "input": generic_once_sanitized,
            },
        });
        generic_state
            .enqueue_event(
                &config,
                "semantic_tool.input",
                EventPriority::P0,
                generic_payload,
            )
            .unwrap();
        let transmitted = generic_state.outbox[0]
            .envelope
            .pointer("/payload/payload/semantic_tool/input")
            .unwrap();
        assert!(transmitted["query"]
            .as_str()
            .unwrap()
            .ends_with("…[truncated]"));
        assert_eq!(
            generic_state.outbox[0]
                .envelope
                .pointer("/payload/payload/semantic_tool/content/digest"),
            Some(&Value::String(semantic_value_digest(transmitted)))
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
    fn goal_usage_fields_are_not_mistaken_for_credentials() {
        let sanitized = sanitize_value(&json!({
            "tokenBudgetControl": true,
            "tokenBudget": 4096,
            "tokensUsed": 128,
            "accessToken": "secret-value",
        }));
        assert_eq!(sanitized["tokenBudgetControl"], json!(true));
        assert_eq!(sanitized["tokenBudget"], json!(4096));
        assert_eq!(sanitized["tokensUsed"], json!(128));
        assert_eq!(sanitized["accessToken"], json!("[REDACTED]"));
    }

    #[test]
    fn semantic_handoff_preserves_acceptance_identifiers_in_declared_prose() {
        let description =
            "The document body must contain the token CHAT250ed7e4dc071. No code changes needed.";
        let plan = format!(
            "## Plan\n{}\n- The token CHAT250ed7e4dc071 included somewhere in the body.\n- Save the output document.",
            "Relevant task context. ".repeat(300),
        );
        assert!(plan.len() > 4096);
        let input = json!({
            "title": "Write project description",
            "description": description,
            "initialPlan": plan,
            "idempotencyKey": "write-description-1",
        });
        assert_eq!(
            sanitize_semantic_tool_input("create_task", &input).unwrap(),
            input
        );
        for text in [
            description,
            plan.as_str(),
            "Must include the literal token `CHAT66e7813a4f9d1` somewhere in the text.",
            "Include the exact token ACCEPTANCE-42 in the final output.",
        ] {
            assert_eq!(
                sanitize_semantic_tool_input("write_document", &json!({"body": text})).unwrap(),
                json!({"body": text})
            );
            assert_ne!(
                redact_text(text),
                text,
                "diagnostics keep their strict policy"
            );
        }
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        state
            .enqueue_executor_event(
                &config,
                "provider-create-task".to_owned(),
                "semantic_tool.input".to_owned(),
                EventPriority::P0,
                json!({"semantic_tool": {
                    "schema": "paperclip.prp.semantic_tool.v1",
                    "schemaVersion": 1,
                    "phase": "input",
                    "operationId": "create_task",
                    "content": {"digest": semantic_value_digest(&input)},
                    "input": input,
                }}),
            )
            .unwrap();
        let transmitted = state.outbox[0]
            .envelope
            .pointer("/payload/payload/semantic_tool/input")
            .unwrap();
        assert_eq!(transmitted, &input);
        assert_eq!(
            state.outbox[0]
                .envelope
                .pointer("/payload/payload/semantic_tool/content/digest"),
            Some(&json!(semantic_value_digest(transmitted))),
        );
        let document = format!(
            "{}\nAuthorization: Bearer late-credential\nFINAL-ACCEPTANCE-42",
            "Document content. ".repeat(400)
        );
        let safe =
            sanitize_semantic_tool_input("write_document", &json!({"body": document})).unwrap();
        let body = safe["body"].as_str().unwrap();
        assert!(body.len() > 4096);
        assert!(body.ends_with("FINAL-ACCEPTANCE-42"));
        assert!(!body.contains("late-credential"));
    }

    #[test]
    fn semantic_prose_does_not_exempt_credential_syntax_or_shapes() {
        for text in [
            "auth token opaque-credential",
            "access token opaque-credential",
            "session token opaque-credential",
            "refresh token opaque-credential",
            "authentication token opaque-credential",
            "literal token=opaque-credential",
            "literal token:opaque-credential",
            "literal --token opaque-credential",
            "literal access_token opaque-credential",
            "literal \"token\" opaque-credential",
            "literal token \"opaque-credential\"",
        ] {
            assert!(!redact_text(text).contains("opaque-credential"), "{text}");
            let input = json!({"description": text, "initialPlan": text});
            assert!(
                !sanitize_semantic_tool_input("create_task", &input)
                    .unwrap()
                    .to_string()
                    .contains("opaque-credential"),
                "{text}"
            );
        }
        for secret in [
            "sk-proj-secretvalue123456",
            "ghp_secretvalue12345678901234567890",
            "github_pat_secretvalue12345678901234567890",
            "eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LWNsYWlt.signaturesecret",
        ] {
            let text = format!("Include the literal token {secret} in the document.");
            assert!(!redact_text(&text).contains(secret), "{text}");
            assert!(
                !sanitize_semantic_tool_input("write_document", &json!({"body": text}))
                    .unwrap()
                    .to_string()
                    .contains(secret)
            );
        }
        let input = json!({
            "description": "Include the literal token ACCEPTANCE-42. Authorization: Bearer opaque-credential",
            "token": "opaque-credential",
        });
        let safe = sanitize_semantic_tool_input("create_task", &input).unwrap();
        assert!(safe["description"]
            .as_str()
            .unwrap()
            .contains("ACCEPTANCE-42"));
        assert!(!safe.to_string().contains("opaque-credential"));
        let diagnostic = json!({"description": "the token opaque-credential"});
        assert!(
            !sanitize_semantic_tool_input("get_task_context", &diagnostic)
                .unwrap()
                .to_string()
                .contains("opaque-credential")
        );
        assert!(!sanitize_semantic_tool_input(
            "create_task",
            &json!({"diagnostic": "token opaque-credential"})
        )
        .unwrap()
        .to_string()
        .contains("opaque-credential"));
    }

    #[test]
    fn semantic_redaction_preserves_benign_token_system_prose() {
        let prose = "Offer a simple token system so guests can exchange items even when their contributions differ in quantity.";
        let game_prose = "Use a balanced token economy. Award one token for each accepted game, with an optional second token for especially large or complex games.";
        let observed_prose = "The token economy. Name the token station the Cobalt Counter. Close with a last selection round, token reconciliation, and cleanup. Collect suggestions about accessibility, and token limits without changing the token rules. A jade token design can include a large printed symbol. Ask whether the token values felt fair. Plan standard token exchanges. Record each participant’s name and token count. Set a one-token limit per household and ask whether the one-token rule felt fair.";
        for text in [
            prose,
            game_prose,
            observed_prose,
            "Use a token system.",
            "Describe the token system clearly.",
            "The simple token system is fair.",
            "Use a simple TOKEN SYSTEM",
            "Use a balanced token system.",
            "Use a transparent token system to keep exchanges fair.",
            "Describe the transparent token system clearly.",
            "One token can equal one standard game.",
            "Award one token per accepted game.",
            "The token economy",
            "Name the token station the Cobalt Counter and provide tokens in unusual titles.",
            "Close with a last selection round, token reconciliation, and cleanup.",
            "Collect suggestions about accessibility, and token limits.",
            "Avoid changing the token rules.",
            "A jade token design can include a large printed symbol and a serial number.",
            "Ask whether the token values felt fair.",
            "Plan standard token exchanges.",
            "The token design should be difficult to copy.",
            "Record each participant’s name and token count on a simple public tally sheet.",
            "Set a one-token limit per household.",
            "Ask whether the one-token rule felt fair.",
        ] {
            assert_eq!(redact_text(text), text);
            assert_eq!(
                sanitize_value(&json!({"summary": text})),
                json!({"summary": text})
            );
        }
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        let command = command("command_token_prose", 1);
        state.begin_command(&command).unwrap();
        let result = json!({
            "result": {"schema": "paperclip.prp.run_result.v1", "summary": observed_prose},
            "nested": {"token": "system", "diagnostic": "token=system"},
        });
        state.complete_command(&command, result).unwrap();
        let completed = state.processed_commands.get(&command.command_id).unwrap();
        assert_eq!(completed.result["result"]["summary"], json!(observed_prose));
        assert_eq!(completed.result["nested"]["token"], json!("[REDACTED]"));
        assert_eq!(
            completed.result["nested"]["diagnostic"],
            json!("token=[REDACTED]")
        );
    }

    #[test]
    fn token_system_prose_exception_preserves_credential_redaction() {
        for (input, expected) in [
            ("token system", "token [REDACTED]"),
            (
                "request failed token system",
                "request failed token [REDACTED]",
            ),
            ("a token=system", "a token=[REDACTED]"),
            ("a token:system", "a token:[REDACTED]"),
            ("a token \"system\"", "a token \"[REDACTED]\""),
            ("a token 'system'", "a token '[REDACTED]'"),
            ("a \"token\" system", "a \"token\" [REDACTED]"),
            ("a access_token system", "a access_token [REDACTED]"),
            ("a --token system", "a --token [REDACTED]"),
            ("a token system-secret", "a token [REDACTED]"),
            ("a token system.signed-value", "a token [REDACTED]"),
            ("a token system,secret", "a token [REDACTED],secret"),
            ("a token system;secret", "a token [REDACTED];secret"),
            ("a token system)secret", "a token [REDACTED])secret"),
            ("a token system=secret", "a token [REDACTED]"),
            ("a token system:secret", "a token [REDACTED]"),
            ("a token secret-value", "a token [REDACTED]"),
            (
                "a balanced token economy-secret",
                "a balanced token [REDACTED]",
            ),
            ("the token economy-secret", "the token [REDACTED]"),
            ("the token station-secret", "the token [REDACTED]"),
            ("the token rules-secret", "the token [REDACTED]"),
            ("and token limits-secret", "and token [REDACTED]"),
            ("a jade token design-secret", "a jade token [REDACTED]"),
            ("the token values-secret", "the token [REDACTED]"),
            (
                "standard token exchanges-secret",
                "standard token [REDACTED]",
            ),
            ("and token count-secret", "and token [REDACTED]"),
            ("one-token limit-secret", "one-token [REDACTED]"),
            ("one-token rule-secret", "one-token [REDACTED]"),
            ("one-token secret-value", "one-token [REDACTED]"),
            ("the token design=secret", "the token [REDACTED]"),
            ("token design", "token [REDACTED]"),
            (
                "token reconciliation-secret, and cleanup",
                "token [REDACTED], and cleanup",
            ),
            (
                "after token reconciliation, and cleanup-secret",
                "after token [REDACTED], and cleanup-secret",
            ),
            ("token rules", "token [REDACTED]"),
            ("token limits", "token [REDACTED]"),
            ("the token=rules", "the token=[REDACTED]"),
            ("the token \"rules\"", "the token \"[REDACTED]\""),
            ("the --token rules", "the --token [REDACTED]"),
            ("the access_token rules", "the access_token [REDACTED]"),
            (
                "a balanced token system-secret",
                "a balanced token [REDACTED]",
            ),
            (
                "a balanced token ghp_abcdefghijklmnopqrstuvwxyz",
                "a balanced token [REDACTED]",
            ),
            ("one token bearer-secret", "one token [REDACTED]"),
            (
                "second token sk-abcdefghijklmnop",
                "second token [REDACTED]",
            ),
            ("one token for-secret", "one token [REDACTED]"),
            ("second token per.secret", "second token [REDACTED]"),
            ("one token can rotate", "one token [REDACTED] rotate"),
            ("one token can-equal-secret", "one token [REDACTED]"),
            (
                "one token can equal-secret",
                "one token [REDACTED] equal-secret",
            ),
            ("one token can=secret-value", "one token [REDACTED]"),
            ("stone token for", "stone token [REDACTED]"),
            ("one-time token for", "one-time token [REDACTED]"),
            ("one access_token for", "one access_token [REDACTED]"),
            ("one --token can equal", "one --token [REDACTED] equal"),
            ("one \"token\" can equal", "one \"token\" [REDACTED] equal"),
            ("one token \"for\"", "one token \"[REDACTED]\""),
            ("one token for=secret", "one token [REDACTED]"),
            ("a token\nsystem", "a token\n[REDACTED]"),
            ("meta token system", "meta token [REDACTED]"),
            (
                "a token system; token=secret-value",
                "a token system; token=[REDACTED]",
            ),
            (
                "a token system; Bearer secret-value",
                "a token system; Bearer [REDACTED]",
            ),
            (
                "a token system; sk-abcdefghijklmnop",
                "a token system; [REDACTED]",
            ),
            (
                "a token system; ghp_abcdefghijklmnopqrstuvwxyz",
                "a token system; [REDACTED]",
            ),
            (
                "a token system; eyJabcdefghi.abcdefghijk.lmnopqrstuv",
                "a token system; [REDACTED]",
            ),
        ] {
            let redacted = redact_text(input);
            assert_eq!(redacted, expected, "{input}");
            assert_eq!(redact_text(&redacted), redacted);
        }
    }

    #[test]
    fn transparent_token_system_requires_exact_prose_boundaries() {
        for lead in ["a transparent ", "the transparent "] {
            for (tail, redacted_tail) in [
                ("token=system", "token=[REDACTED]"),
                ("token:system", "token:[REDACTED]"),
                ("token \"system\"", "token \"[REDACTED]\""),
                ("token 'system'", "token '[REDACTED]'"),
                ("\"token\" system", "\"token\" [REDACTED]"),
                ("access_token system", "access_token [REDACTED]"),
                ("--token system", "--token [REDACTED]"),
                ("token\nsystem", "token\n[REDACTED]"),
                ("token system-secret", "token [REDACTED]"),
                ("token system.signed-value", "token [REDACTED]"),
                ("token system=secret", "token [REDACTED]"),
                ("token system:secret", "token [REDACTED]"),
                ("token system,secret", "token [REDACTED],secret"),
                ("token system;secret", "token [REDACTED];secret"),
                ("token system)secret", "token [REDACTED])secret"),
                ("token arbitrary", "token [REDACTED]"),
                ("token ghp_abcdefghijklmnopqrstuvwxyz", "token [REDACTED]"),
                ("token sk-abcdefghijklmnop", "token [REDACTED]"),
            ] {
                let input = format!("{lead}{tail}");
                assert_eq!(redact_text(&input), format!("{lead}{redacted_tail}"));
            }
        }
        for input in [
            "meta-transparent token system",
            "a very transparent token system",
            "a transparent token economy",
            "one token clerk, one demonstration host",
        ] {
            assert!(redact_text(input).contains("[REDACTED]"), "{input}");
        }
        assert_eq!(
            sanitize_value(&json!({
                "summary": "Use a transparent token system; Bearer fixture-secret.",
                "token": "system.",
            })),
            json!({
                "summary": "Use a transparent token system; Bearer [REDACTED].",
                "token": "[REDACTED]",
            })
        );
    }

    #[test]
    fn sentence_period_redaction_keeps_credentials_and_embedded_dots_private() {
        for (input, expected) in [
            ("token=fixture-secret. Next.", "token=[REDACTED]. Next."),
            ("token fixture-secret.", "token [REDACTED]."),
            (
                "token fixture.secret.suffix. Next.",
                "token [REDACTED]. Next.",
            ),
            ("token fixture.secret.suffix", "token [REDACTED]"),
            ("token fixture-secret..", "token [REDACTED]"),
            ("token .", "token [REDACTED]"),
            ("token=fixture-secret.\nRetry.", "token=[REDACTED].\nRetry."),
            ("token=fixture-secret., Next.", "token=[REDACTED], Next."),
            (
                "token \"fixture-secret.\" Next.",
                "token \"[REDACTED]\" Next.",
            ),
            ("token 'fixture-secret.' Next.", "token '[REDACTED]' Next."),
            ("Bearer fixture-secret. Next.", "Bearer [REDACTED]. Next."),
            (
                "Authorization: Bearer fixture-secret. Next.",
                "Authorization: Bearer [REDACTED]. Next.",
            ),
            (
                "eyJabcdefghi.abcdefghijk.lmnopqrstuv. Next.",
                "[REDACTED]. Next.",
            ),
            (
                "eyJabcdefghi.abcdefghijk.lmnopqrstuv.wxyzabcdefg.",
                "[REDACTED].",
            ),
            (
                "token=eyJabcdefghi.abcdefghijk.lmnopqrstuv.",
                "token=[REDACTED].",
            ),
            (
                "Review token rules. Send a thank-you.",
                "Review token [REDACTED]. Send a thank-you.",
            ),
        ] {
            let redacted = redact_text(input);
            assert_eq!(redacted, expected, "{input}");
            assert_eq!(redact_text(&redacted), expected, "{input}");
        }
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        let command = command("command_token_sentence_prose", 1);
        state.begin_command(&command).unwrap();
        state.complete_command(&command, json!({
            "result": {
                "schema": "paperclip.prp.run_result.v1",
                "summary": "Use a transparent token system. Remove token=fixture-secret. Next.",
            },
            "nested": {"token": "fixture-secret."},
        })).unwrap();
        let completed = state.processed_commands.get(&command.command_id).unwrap();
        assert_eq!(
            completed.result["result"]["summary"],
            json!("Use a transparent token system. Remove token=[REDACTED]. Next.")
        );
        assert_eq!(completed.result["nested"]["token"], json!("[REDACTED]"));
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
