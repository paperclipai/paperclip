use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::codex_provider::{
    CodexProvider, CodexProviderConfig, CodexProviderEvent, RejectedAcceptedTurn,
    MAX_SETTLED_PROVIDER_TURN_IDS,
};
use crate::durable::{
    create_private_temporary_file, current_unix_ms, open_private_regular_file, sanitize_value,
    verify_private_directory, Command, CommandExecution, CommandExecutor, DurableRunnerConfig,
    DurableRunnerError, EventPriority, PolledEvent,
};
use crate::provider_bridge::{
    authorized_tool_catalog_digest, semantic_value_digest, AuthorizedToolSet, DurableReplayFilter,
    PendingToolCall, ProviderBridgeError, ProviderToolBridge, ToolResult, MAX_PENDING_CALLS,
    TOOL_SET_SCHEMA,
};
use crate::provider_events::{
    normalize_codex_notification, normalized_codex_terminal_event_type, NormalizedProviderEvent,
};

const PROVIDER_STATE_SCHEMA: &str = "paperclip.runner.codex-provider-state.v1";
const PROVIDER_STATE_FILE: &str = "codex-provider-state.json";
const MAX_PROVIDER_STATE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EVENTS_PER_POLL: usize = 128;
// One accepted semantic call can produce an input and a result event. Normal
// traffic cannot consume the additional capacity required to diagnose a
// receipt-limit stop, settle every retained call, and record the provider plus
// run terminal events.
const MAX_REGULAR_QUEUED_PROVIDER_EVENTS: usize = 2 * MAX_PENDING_CALLS + 3;
const MAX_RECEIPT_LIMIT_TERMINAL_RESERVE: usize = MAX_PENDING_CALLS + 4;
// During a receipt-limit stop, provider polling continues even when older
// events remain unacknowledged so an already-buffered authoritative terminal
// wins over the deadline fallback. Reserve one complete poll of cleanup events
// in addition to the semantic-result and terminal envelopes.
const MAX_TERMINAL_SETTLEMENT_EVENTS: usize = MAX_PENDING_CALLS + MAX_EVENTS_PER_POLL + 4;
const MAX_QUEUED_PROVIDER_EVENTS: usize =
    MAX_REGULAR_QUEUED_PROVIDER_EVENTS + MAX_TERMINAL_SETTLEMENT_EVENTS;
const MAX_RECEIPT_LIMIT_INTERRUPT_ATTEMPTS: u8 = 3;
const RECEIPT_LIMIT_INTERRUPT_TERMINAL_DEADLINE_MS: u64 = 2_000;
const RECEIPT_LIMIT_ACCEPTED_TERMINAL_DEADLINE_MS: u64 = 30_000;

fn receipt_limit_deadline_after(timeout_ms: u64) -> Result<u64, DurableRunnerError> {
    current_unix_ms()?.checked_add(timeout_ms).ok_or_else(|| {
        DurableRunnerError::invalid("Codex receipt-limit interruption deadline overflowed")
    })
}

#[derive(Clone, Debug)]
struct ProviderEventIdentity {
    runner_instance_id: String,
    run_id: String,
    normalized_session_id: String,
    turn_id: String,
    item_id: String,
}

impl ProviderEventIdentity {
    fn from_config(config: &DurableRunnerConfig) -> Self {
        Self {
            runner_instance_id: config.runner_instance_id.clone(),
            run_id: config.run_id.clone(),
            normalized_session_id: config.normalized_session_id.clone(),
            turn_id: config.turn_id.clone(),
            item_id: config.item_id.clone(),
        }
    }

    fn source_event_id(&self, executor_event_id: &str) -> String {
        use sha2::{Digest, Sha256};

        let mut hasher = Sha256::new();
        hasher.update(b"paperclip.executor-event.v1\0");
        hasher.update(self.runner_instance_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(executor_event_id.as_bytes());
        format!("event_executor_{:x}", hasher.finalize())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CompletionContractBinding {
    revision: String,
    criterion_ids: Vec<String>,
}

fn initial_provider_event_seq() -> u64 {
    1
}

fn provider_event_id(sequence: u64) -> String {
    format!("codex_provider_{sequence:016}")
}

fn provider_event_sequence(event_id: &str) -> Option<u64> {
    let sequence = event_id.strip_prefix("codex_provider_")?.parse().ok()?;
    (provider_event_id(sequence) == event_id).then_some(sequence)
}

fn completion_contract(
    payload: &Value,
) -> Result<Option<CompletionContractBinding>, DurableRunnerError> {
    let Some(value) = payload.get("completionContract") else {
        return Ok(None);
    };
    let binding: CompletionContractBinding =
        serde_json::from_value(value.clone()).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "run.prepare completionContract is invalid: {error}"
            ))
        })?;
    if binding.revision.is_empty()
        || binding.revision.len() > 120
        || binding.criterion_ids.is_empty()
        || binding.criterion_ids.len() > 256
        || binding.criterion_ids.iter().any(|criterion| {
            criterion.is_empty() || criterion.len() > 240 || criterion.chars().any(char::is_control)
        })
    {
        return Err(DurableRunnerError::invalid(
            "run.prepare completionContract is malformed or oversized",
        ));
    }
    Ok(Some(binding))
}

fn authorized_tool_set(payload: &Value) -> Result<AuthorizedToolSet, DurableRunnerError> {
    if let Some(value) = payload.get("authorizedTools") {
        return serde_json::from_value(value.clone()).map_err(|error| {
            DurableRunnerError::invalid(format!("run.prepare authorizedTools is invalid: {error}"))
        });
    }
    let operations = Vec::new();
    let catalog_digest = authorized_tool_catalog_digest(&operations).map_err(|error| {
        DurableRunnerError::invalid(format!("empty authorized tool set is invalid: {error}"))
    })?;
    Ok(AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest,
        operations,
    })
}

fn semantic_correlation(identity: &ProviderEventIdentity) -> Value {
    json!({
        "runId": identity.run_id,
        "normalizedSessionId": identity.normalized_session_id,
        "turnId": identity.turn_id,
        "itemId": identity.item_id,
    })
}

fn semantic_input_event(
    identity: &ProviderEventIdentity,
    call: &PendingToolCall,
) -> NormalizedProviderEvent {
    let safe_input = sanitize_value(&call.input);
    NormalizedProviderEvent {
        event_type: "semantic_tool.input".to_owned(),
        priority: EventPriority::P0,
        payload: json!({
            "semantic_tool": {
                "schema": "paperclip.prp.semantic_tool.v1",
                "schemaVersion": 1,
                "phase": "input",
                "operationId": call.operation_id,
                "callId": call.call_id,
                "correlation": semantic_correlation(identity),
                "idempotencyKey": Value::Null,
                "content": {
                    "digest": semantic_value_digest(&safe_input),
                    "redactionDisposition": "digest_only",
                    "references": [],
                },
                "input": safe_input,
            },
        }),
    }
}

fn semantic_result_event(
    identity: &ProviderEventIdentity,
    result: &ToolResult,
) -> NormalizedProviderEvent {
    let safe_result = sanitize_value(&result.result);
    let envelope = safe_result
        .get("resultReceipt")
        .filter(|receipt| {
            receipt.get("schema").and_then(Value::as_str)
                == Some("paperclip.prp.semantic_tool.v1")
                && receipt.get("phase").and_then(Value::as_str) == Some("result")
                && receipt.get("operationId").and_then(Value::as_str)
                    == Some(result.operation_id.as_str())
                && receipt.get("callId").and_then(Value::as_str) == Some(result.call_id.as_str())
                && receipt.get("correlation") == Some(&semantic_correlation(identity))
        })
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "schema": "paperclip.prp.semantic_tool.v1",
                "schemaVersion": 1,
                "phase": "result",
                "operationId": result.operation_id,
                "callId": result.call_id,
                "correlation": semantic_correlation(identity),
                "idempotencyKey": Value::Null,
                "content": {
                    "digest": semantic_value_digest(&safe_result),
                    "redactionDisposition": "digest_only",
                    "references": [],
                },
                "outcome": if result.is_error { "failed" } else { "succeeded" },
                "code": if result.is_error { "semantic_tool_failed" } else { "semantic_tool_succeeded" },
                "retryable": false,
                "authorizationBoundary": "active_task",
                "operationReceiptId": format!("operation_{}", result.call_id),
            })
        });
    NormalizedProviderEvent {
        event_type: "semantic_tool.result".to_owned(),
        priority: EventPriority::P0,
        payload: json!({"semantic_tool": envelope}),
    }
}

fn terminal_events(state: &CodexProviderState, event_type: &str) -> Vec<NormalizedProviderEvent> {
    let Some(contract) = state.completion_contract.as_ref() else {
        return Vec::new();
    };
    let succeeded = event_type == "turn.completed";
    let cancelled = matches!(event_type, "turn.cancelled" | "turn.interrupted");
    let disposition = if succeeded { "done" } else { "needs_review" };
    let summary = state.last_agent_message.clone().unwrap_or_else(|| {
        if succeeded {
            "Codex completed the requested work.".to_owned()
        } else if cancelled {
            "The Codex run stopped before it completed.".to_owned()
        } else {
            "The Codex run failed before it completed.".to_owned()
        }
    });
    let evidence_ref = "provider:codex:agent-message";
    let criteria = contract
        .criterion_ids
        .iter()
        .map(|criterion_id| {
            json!({
                "criterionId": criterion_id,
                "status": if succeeded { "satisfied" } else { "unknown" },
                "evidenceRefs": if succeeded { vec![evidence_ref] } else { Vec::<&str>::new() },
            })
        })
        .collect::<Vec<_>>();
    let result = json!({
        "schema": "paperclip.run_result.v1",
        "reportedWorkDisposition": disposition,
        "summary": summary,
        "completionClaim": {
            "contractRevision": contract.revision,
            "objectiveSatisfied": succeeded,
            "criteria": criteria,
            "remainingWork": if succeeded { Vec::<Value>::new() } else { vec![json!({
                "description": "Review the stopped Codex run and continue the task.",
                "blocksCompletion": true,
            })] },
        },
        "evidence": if succeeded { vec![json!({ "ref": evidence_ref })] } else { Vec::<Value>::new() },
        "verification": [],
        "attentionRequests": if succeeded { Vec::<Value>::new() } else { vec![json!({
            "kind": "review",
            "summary": "Review the stopped Codex run before continuing.",
            "ownerClass": "human",
        })] },
        "artifacts": [],
    });
    let turn_terminal_state = if succeeded {
        "completed"
    } else if event_type == "turn.interrupted" {
        "interrupted"
    } else if cancelled {
        "cancelled"
    } else {
        "failed"
    };
    let terminal = json!({
        "schema": "paperclip.prp.terminal.v1",
        "turnTerminalState": turn_terminal_state,
        "runTerminalState": if succeeded { "succeeded" } else if cancelled { "cancelled" } else { "failed" },
        "reportedWorkDisposition": disposition,
    });
    vec![
        NormalizedProviderEvent {
            event_type: "run.result.proposed".to_owned(),
            priority: EventPriority::P0,
            payload: result,
        },
        NormalizedProviderEvent {
            event_type: "run.terminal".to_owned(),
            priority: EventPriority::P0,
            payload: terminal,
        },
    ]
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CodexProviderState {
    schema: String,
    lifecycle: String,
    config: CodexProviderConfig,
    #[serde(default)]
    completion_contract: Option<CompletionContractBinding>,
    #[serde(default)]
    tool_bridge: ProviderToolBridge,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    provider_session_id: Option<String>,
    #[serde(default)]
    active_provider_turn_id: Option<String>,
    #[serde(default)]
    ambiguous_turn_start_pending: bool,
    #[serde(default)]
    completed_turn_authoritative: bool,
    #[serde(default)]
    provider_process_generation: u64,
    #[serde(default)]
    completed_turn_process_generation: Option<u64>,
    #[serde(default)]
    completed_provider_turn_id: Option<String>,
    // Unlike the live provider process, the durable run survives restarts.
    // Terminal identities stay exact for one process-generation epoch. At the
    // bound, an idle process is reaped before this epoch is rotated.
    #[serde(default)]
    settled_provider_turn_ids: std::collections::BTreeSet<String>,
    #[serde(default)]
    settled_provider_turn_filter: DurableReplayFilter,
    #[serde(default)]
    receipt_limit_diagnostic_emitted: bool,
    #[serde(default)]
    receipt_limit_interrupt_pending: bool,
    #[serde(default)]
    receipt_limit_interrupt_accepted: bool,
    #[serde(default)]
    receipt_limit_interrupt_attempts: u8,
    #[serde(default)]
    receipt_limit_interrupt_deadline_unix_ms: Option<u64>,
    last_agent_message: Option<String>,
    #[serde(default)]
    pending_events: VecDeque<PolledEvent>,
    #[serde(default)]
    queued_events: VecDeque<PolledEvent>,
    #[serde(default = "initial_provider_event_seq")]
    next_provider_event_seq: u64,
}

#[derive(Debug, PartialEq)]
enum ToolCallAdmission {
    CompletedReplay(ToolResult),
    PendingReplay,
    Pending(PendingToolCall),
}

fn settled_provider_turn_contains(
    identities: &std::collections::BTreeSet<String>,
    _filter: &DurableReplayFilter,
    provider_turn_id: &str,
) -> bool {
    identities.contains(provider_turn_id)
}

fn remember_settled_provider_turn(
    identities: &mut std::collections::BTreeSet<String>,
    _filter: &mut DurableReplayFilter,
    provider_turn_id: String,
) -> Result<(), DurableRunnerError> {
    if identities.contains(&provider_turn_id) {
        return Ok(());
    }
    if identities.len() >= MAX_SETTLED_PROVIDER_TURN_IDS {
        return Err(DurableRunnerError::invalid(
            "Codex provider turn identity epoch reached its exact capacity",
        ));
    }
    identities.insert(provider_turn_id);
    Ok(())
}

impl CodexProviderState {
    fn new(
        config: CodexProviderConfig,
        completion_contract: Option<CompletionContractBinding>,
        tool_bridge: ProviderToolBridge,
    ) -> Self {
        let thread_id = config.provider_session_id.clone();
        Self {
            schema: PROVIDER_STATE_SCHEMA.to_owned(),
            lifecycle: "prepared".to_owned(),
            config,
            completion_contract,
            tool_bridge,
            thread_id,
            provider_session_id: None,
            active_provider_turn_id: None,
            ambiguous_turn_start_pending: false,
            completed_turn_authoritative: false,
            provider_process_generation: 0,
            completed_turn_process_generation: None,
            completed_provider_turn_id: None,
            settled_provider_turn_ids: std::collections::BTreeSet::new(),
            settled_provider_turn_filter: DurableReplayFilter::default(),
            receipt_limit_diagnostic_emitted: false,
            receipt_limit_interrupt_pending: false,
            receipt_limit_interrupt_accepted: false,
            receipt_limit_interrupt_attempts: 0,
            receipt_limit_interrupt_deadline_unix_ms: None,
            last_agent_message: None,
            pending_events: VecDeque::new(),
            queued_events: VecDeque::new(),
            next_provider_event_seq: initial_provider_event_seq(),
        }
    }

    fn validate(&self) -> Result<(), DurableRunnerError> {
        self.config
            .validate()
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        self.tool_bridge.validate_recovered().map_err(|error| {
            DurableRunnerError::invalid(format!("Codex semantic tool state is invalid: {error}"))
        })?;
        let mut pending_event_ids = HashSet::new();
        if self.schema != PROVIDER_STATE_SCHEMA
            || !matches!(
                self.lifecycle.as_str(),
                "prepared" | "session_open" | "turn_active" | "provider_exited" | "closed"
            )
            || self
                .thread_id
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 240)
            || self
                .provider_session_id
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 240)
            || self
                .active_provider_turn_id
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 240)
            || self
                .completed_provider_turn_id
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 240)
            || self.completion_contract.as_ref().is_some_and(|contract| {
                contract.revision.is_empty()
                    || contract.revision.len() > 120
                    || contract.criterion_ids.is_empty()
                    || contract.criterion_ids.len() > 256
                    || contract.criterion_ids.iter().any(|criterion| {
                        criterion.is_empty()
                            || criterion.len() > 240
                            || criterion.chars().any(char::is_control)
                    })
            })
            || self
                .last_agent_message
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 1_000_000)
            || (self.thread_id.is_none()
                && (self.provider_session_id.is_some()
                    || self.active_provider_turn_id.is_some()
                    || matches!(self.lifecycle.as_str(), "session_open" | "turn_active")))
            || (self.lifecycle == "turn_active" && self.active_provider_turn_id.is_none())
            || (self.ambiguous_turn_start_pending
                && (self.thread_id.is_none()
                    || self.active_provider_turn_id.is_some()
                    || matches!(
                        self.lifecycle.as_str(),
                        "prepared" | "turn_active" | "closed"
                    )))
            || (self.completed_turn_authoritative && self.active_provider_turn_id.is_some())
            || (!self.completed_turn_authoritative
                && (self.completed_turn_process_generation.is_some()
                    || self.completed_provider_turn_id.is_some()))
            || self.settled_provider_turn_ids.len() > MAX_SETTLED_PROVIDER_TURN_IDS
            || self.settled_provider_turn_filter.validate().is_err()
            || self
                .settled_provider_turn_ids
                .iter()
                .any(|provider_turn_id| {
                    provider_turn_id.is_empty()
                        || provider_turn_id.len() > 240
                        || provider_turn_id.chars().any(char::is_control)
                })
            || self
                .active_provider_turn_id
                .as_ref()
                .is_some_and(|provider_turn_id| {
                    settled_provider_turn_contains(
                        &self.settled_provider_turn_ids,
                        &self.settled_provider_turn_filter,
                        provider_turn_id,
                    )
                })
            || self
                .completed_turn_process_generation
                .is_some_and(|generation| generation > self.provider_process_generation)
            || (self.receipt_limit_diagnostic_emitted && self.active_provider_turn_id.is_none())
            || (self.receipt_limit_interrupt_pending
                && (!self.receipt_limit_diagnostic_emitted
                    || self.active_provider_turn_id.is_none()))
            || (self.receipt_limit_interrupt_accepted && !self.receipt_limit_interrupt_pending)
            || self.receipt_limit_interrupt_attempts > MAX_RECEIPT_LIMIT_INTERRUPT_ATTEMPTS
            || (!self.receipt_limit_interrupt_pending && self.receipt_limit_interrupt_attempts != 0)
            || self
                .receipt_limit_interrupt_deadline_unix_ms
                .is_some_and(|deadline| deadline == 0 || !self.receipt_limit_interrupt_pending)
            || (matches!(
                self.lifecycle.as_str(),
                "prepared" | "session_open" | "closed"
            ) && self.active_provider_turn_id.is_some())
            || self.next_provider_event_seq == 0
            || self.pending_events.len() > MAX_EVENTS_PER_POLL + 3
            || self.queued_events.len() > MAX_QUEUED_PROVIDER_EVENTS
            || self
                .pending_events
                .iter()
                .chain(self.queued_events.iter())
                .any(|event| {
                    provider_event_sequence(&event.executor_event_id)
                        .is_none_or(|sequence| sequence >= self.next_provider_event_seq)
                        || !pending_event_ids.insert(event.executor_event_id.as_str())
                        || event.event_type.is_empty()
                        || event.event_type.len() > 160
                        || event.event_type.chars().any(char::is_control)
                        || !event.payload.is_object()
                })
        {
            return Err(DurableRunnerError::invalid(
                "Codex provider state is malformed or inconsistent",
            ));
        }
        Ok(())
    }

    fn push_event_with_limit(
        &mut self,
        event: NormalizedProviderEvent,
        max_queued_events: usize,
    ) -> Result<(), DurableRunnerError> {
        let queue_event =
            !self.queued_events.is_empty() || self.pending_events.len() >= MAX_EVENTS_PER_POLL;
        if queue_event && self.queued_events.len() >= max_queued_events {
            return Err(DurableRunnerError::invalid(
                "Codex provider event backlog exceeds its durable limit",
            ));
        }
        let sequence = self.next_provider_event_seq;
        self.next_provider_event_seq = sequence
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("provider event sequence exhausted"))?;
        let event = PolledEvent {
            executor_event_id: provider_event_id(sequence),
            event_type: event.event_type,
            priority: event.priority,
            payload: event.payload,
        };
        if queue_event {
            self.queued_events.push_back(event);
        } else {
            self.pending_events.push_back(event);
        }
        Ok(())
    }

    fn begin_receipt_limit_stop(
        &mut self,
        call_id: String,
        operation_id: String,
        deadline_unix_ms: u64,
    ) -> Result<bool, DurableRunnerError> {
        if self.receipt_limit_diagnostic_emitted {
            return Ok(self.receipt_limit_interrupt_pending);
        }
        self.push_terminal_event(NormalizedProviderEvent {
            event_type: "harness.diagnostic".to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "provider": "codex",
                "code": "semantic_tool_turn_receipt_limit",
                "operationId": operation_id,
                "callId": call_id,
                "message": "The active provider turn reached its durable semantic-tool receipt limit and was interrupted",
                "paperclipExecuted": false,
            }),
        })?;
        self.receipt_limit_diagnostic_emitted = true;
        self.receipt_limit_interrupt_pending = true;
        self.receipt_limit_interrupt_attempts = 0;
        self.receipt_limit_interrupt_deadline_unix_ms = Some(deadline_unix_ms);
        Ok(true)
    }

    fn record_receipt_limit_interrupt_attempt(&mut self) -> Result<(), DurableRunnerError> {
        if self.receipt_limit_interrupt_attempts >= MAX_RECEIPT_LIMIT_INTERRUPT_ATTEMPTS {
            return Err(DurableRunnerError::invalid(
                "Codex receipt-limit interruption exceeded its durable retry bound",
            ));
        }
        self.receipt_limit_interrupt_attempts += 1;
        Ok(())
    }

    fn mark_receipt_limit_interrupt_accepted(&mut self, accepted_deadline_unix_ms: u64) {
        // Provider restoration can reconcile the active turn as already
        // settled while an interruption command is in flight. In that case
        // `interrupt_turn` returns `already_settled` and recovery has already
        // cleared the durable retry marker. Do not recreate an accepted state
        // without a pending interruption or active turn.
        if !self.receipt_limit_interrupt_pending || self.active_provider_turn_id.is_none() {
            return;
        }
        if !self.receipt_limit_interrupt_accepted {
            self.receipt_limit_interrupt_deadline_unix_ms = Some(
                self.receipt_limit_interrupt_deadline_unix_ms
                    .unwrap_or_default()
                    .max(accepted_deadline_unix_ms),
            );
        }
        self.receipt_limit_interrupt_accepted = true;
    }

    fn push_event(&mut self, event: NormalizedProviderEvent) -> Result<(), DurableRunnerError> {
        self.push_event_with_limit(event, MAX_REGULAR_QUEUED_PROVIDER_EVENTS)
    }

    fn push_terminal_event(
        &mut self,
        event: NormalizedProviderEvent,
    ) -> Result<(), DurableRunnerError> {
        self.push_event_with_limit(event, MAX_QUEUED_PROVIDER_EVENTS)
    }

    fn push_receipt_limit_cleanup_event(
        &mut self,
        event: NormalizedProviderEvent,
    ) -> Result<(), DurableRunnerError> {
        let queue_event =
            !self.queued_events.is_empty() || self.pending_events.len() >= MAX_EVENTS_PER_POLL;
        if queue_event
            && self.queued_events.len()
                >= MAX_QUEUED_PROVIDER_EVENTS - MAX_RECEIPT_LIMIT_TERMINAL_RESERVE
        {
            // Continue draining the provider so an authoritative terminal can
            // still be observed, but never let cleanup chatter consume the
            // semantic-result and terminal-event reserve.
            return Ok(());
        }
        self.push_terminal_event(event)
    }

    fn refill_pending_events(&mut self) {
        while self.pending_events.len() < MAX_EVENTS_PER_POLL {
            let Some(event) = self.queued_events.pop_front() else {
                break;
            };
            self.pending_events.push_back(event);
        }
    }

    fn extend_events(
        &mut self,
        events: impl IntoIterator<Item = NormalizedProviderEvent>,
    ) -> Result<(), DurableRunnerError> {
        for event in events {
            self.push_event(event)?;
        }
        Ok(())
    }

    fn admit_tool_call(
        &mut self,
        call_id: &str,
        operation_id: &str,
        input: &Value,
    ) -> Result<ToolCallAdmission, ProviderBridgeError> {
        if let Some(result) = self
            .tool_bridge
            .replay_result(call_id, operation_id, input)?
        {
            // An exact completed replay is a transport retry. Its input and
            // result receipts are already durable, so recording another event
            // would make an otherwise idempotent replay consume bounded event
            // capacity and could prevent returning the stored result.
            return Ok(ToolCallAdmission::CompletedReplay(result));
        }

        let pending_replay = self
            .tool_bridge
            .pending_calls()
            .any(|pending| pending.call_id == call_id);
        let call = self.tool_bridge.begin_call(
            call_id.to_owned(),
            operation_id.to_owned(),
            input.clone(),
        )?;
        if pending_replay {
            // The first input receipt is already durable. An exact pending
            // replay is only the provider re-establishing its request after a
            // process restart; appending another event would make the retry
            // consume bounded backlog capacity without adding information.
            Ok(ToolCallAdmission::PendingReplay)
        } else {
            Ok(ToolCallAdmission::Pending(call))
        }
    }

    fn reconcile_active_provider_turn(&mut self, active_provider_turn_id: Option<String>) {
        self.active_provider_turn_id = active_provider_turn_id;
        if self.active_provider_turn_id.is_some() {
            // A newly discovered turn supersedes completion authority from the
            // prior turn. Persisting both would make the recovered state
            // invalid and could misclassify a later provider exit.
            self.completed_turn_authoritative = false;
            self.completed_turn_process_generation = None;
            self.completed_provider_turn_id = None;
            self.ambiguous_turn_start_pending = false;
            self.last_agent_message = None;
        }
        self.lifecycle = if self.active_provider_turn_id.is_some() {
            "turn_active".to_owned()
        } else {
            "session_open".to_owned()
        };
    }

    fn settle_active_provider_turn_identity(&mut self) -> Result<(), DurableRunnerError> {
        let provider_turn_id = self.active_provider_turn_id.clone().ok_or_else(|| {
            DurableRunnerError::invalid("Codex terminal omitted its active provider turn identity")
        })?;
        remember_settled_provider_turn(
            &mut self.settled_provider_turn_ids,
            &mut self.settled_provider_turn_filter,
            provider_turn_id,
        )?;
        Ok(())
    }

    fn recovered_settled_provider_turn_ids(
        &self,
    ) -> Result<(std::collections::BTreeSet<String>, DurableReplayFilter), DurableRunnerError> {
        let mut settled_provider_turn_ids = self.settled_provider_turn_ids.clone();
        let mut settled_provider_turn_filter = self.settled_provider_turn_filter.clone();
        // State written before the durable set was introduced retained only
        // the latest completed identity. Fold that legacy authority into the
        // new ledger before the provider is allowed to accept replacement work.
        if let Some(provider_turn_id) = self.completed_provider_turn_id.clone() {
            remember_settled_provider_turn(
                &mut settled_provider_turn_ids,
                &mut settled_provider_turn_filter,
                provider_turn_id,
            )?;
        }
        Ok((settled_provider_turn_ids, settled_provider_turn_filter))
    }

    fn extend_terminal_events(
        &mut self,
        events: impl IntoIterator<Item = NormalizedProviderEvent>,
    ) -> Result<(), DurableRunnerError> {
        for event in events {
            self.push_terminal_event(event)?;
        }
        Ok(())
    }
}

pub struct CodexCommandExecutor {
    state_dir: PathBuf,
    state: Option<CodexProviderState>,
    provider: Option<CodexProvider>,
    event_identity: Option<ProviderEventIdentity>,
    restore_checked: bool,
}

impl CodexCommandExecutor {
    pub fn new(state_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
            state: None,
            provider: None,
            event_identity: None,
            restore_checked: false,
        }
    }

    pub fn with_runner_config(state_dir: impl Into<PathBuf>, config: &DurableRunnerConfig) -> Self {
        let mut executor = Self::new(state_dir);
        executor.event_identity = Some(ProviderEventIdentity::from_config(config));
        executor
    }

    fn state_path(&self) -> PathBuf {
        self.state_dir.join(PROVIDER_STATE_FILE)
    }

    fn restore(&mut self) -> Result<(), DurableRunnerError> {
        if self.restore_checked {
            return Ok(());
        }
        self.restore_checked = true;
        let path = self.state_path();
        let mut file = match open_private_regular_file(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(DurableRunnerError::invalid(format!(
                    "failed to open private Codex provider state: {error}"
                )))
            }
        };
        let metadata = file.metadata().map_err(|error| {
            DurableRunnerError::invalid(format!("failed to inspect Codex provider state: {error}"))
        })?;
        if metadata.len() > MAX_PROVIDER_STATE_BYTES {
            return Err(DurableRunnerError::invalid(
                "Codex provider state must be a bounded regular file",
            ));
        }
        let mut input = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut input).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to read Codex provider state: {error}"))
        })?;
        let mut state: CodexProviderState = serde_json::from_slice(&input).map_err(|error| {
            DurableRunnerError::invalid(format!("Codex provider state is malformed: {error}"))
        })?;
        state.tool_bridge.attach_existing_run().map_err(|error| {
            DurableRunnerError::invalid(format!(
                "Codex semantic tool state could not be reattached: {error}"
            ))
        })?;
        state.validate()?;
        self.state = Some(state);
        self.restore_provider_if_needed()
    }

    fn restore_provider_if_needed(&mut self) -> Result<(), DurableRunnerError> {
        let Some(state) = self.state.as_ref() else {
            return Ok(());
        };
        if self.provider.is_some()
            || !matches!(
                state.lifecycle.as_str(),
                "session_open" | "turn_active" | "provider_exited"
            )
        {
            return Ok(());
        }
        let provider_had_exited = state.lifecycle == "provider_exited";
        let thread_id = state.thread_id.clone().ok_or_else(|| {
            DurableRunnerError::invalid("recoverable Codex state omitted its thread id")
        })?;
        let previous_active_turn_id = state.active_provider_turn_id.clone();
        let process_generation = state
            .provider_process_generation
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("Codex process generation exhausted"))?;
        let completed_turn_authoritative = state.completed_turn_authoritative;
        let completed_turn_process_generation = state.completed_turn_process_generation;
        let completed_provider_turn_id = state.completed_provider_turn_id.clone();
        let ambiguous_turn_start_pending = state.ambiguous_turn_start_pending;
        let tool_replay_history_blocks_admission =
            state.tool_bridge.replay_history_blocks_admission();
        let tool_receipt_epoch_has_active_receipts = state.tool_bridge.has_active_receipts();
        let (settled_provider_turn_ids, settled_provider_turn_filter) =
            state.recovered_settled_provider_turn_ids()?;
        let provider_epoch_requires_rollover = settled_provider_turn_ids.len()
            >= MAX_SETTLED_PROVIDER_TURN_IDS
            || !settled_provider_turn_filter.is_empty();
        let mut provider = CodexProvider::start_with_tools_for_generation(
            &state.config,
            state.tool_bridge.authorized_tools().cloned(),
            Some(&thread_id),
            process_generation,
        )
        .map_err(|error| {
            DurableRunnerError::invalid(format!("failed to resume Codex provider: {error}"))
        })?;
        provider.enable_durable_tool_call_replays();
        provider
            .restore_settled_turn_identities(
                settled_provider_turn_ids.iter().cloned(),
                settled_provider_turn_filter.clone(),
            )
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to restore Codex provider turn identities: {error}"
                ))
            })?;
        let recovered_active_turn_id = provider.active_provider_turn_id().map(str::to_owned);
        let legacy_epoch_is_ambiguous = (provider_epoch_requires_rollover
            && (ambiguous_turn_start_pending || recovered_active_turn_id.is_some()))
            || (tool_replay_history_blocks_admission
                && (ambiguous_turn_start_pending
                    || recovered_active_turn_id.is_some()
                    || (previous_active_turn_id.is_some()
                        && tool_receipt_epoch_has_active_receipts)));
        if legacy_epoch_is_ambiguous {
            // A saturated legacy epoch cannot prove that recovered work can
            // be identified and settled exactly. Reap the resumed process
            // generation and close the run instead of risking duplicate work.
            let provider_reported_active = recovered_active_turn_id.is_some();
            let provider_shutdown_failed = provider.shutdown().is_err();
            drop(provider);
            let state = self
                .state
                .as_mut()
                .expect("Codex state remains available during legacy recovery");
            state.provider_process_generation = process_generation;
            state.settled_provider_turn_ids = settled_provider_turn_ids;
            state.settled_provider_turn_filter = settled_provider_turn_filter;
            state.active_provider_turn_id = None;
            state.ambiguous_turn_start_pending = false;
            state.completed_turn_authoritative = false;
            state.completed_turn_process_generation = None;
            state.completed_provider_turn_id = None;
            state.receipt_limit_diagnostic_emitted = false;
            state.receipt_limit_interrupt_pending = false;
            state.receipt_limit_interrupt_accepted = false;
            state.receipt_limit_interrupt_attempts = 0;
            state.receipt_limit_interrupt_deadline_unix_ms = None;
            state.last_agent_message = None;
            state.lifecycle = "closed".to_owned();
            let _ = state.push_terminal_event(NormalizedProviderEvent {
                event_type: "harness.diagnostic".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": "codex",
                    "code": "legacy_provider_turn_epoch_ambiguous",
                    "message": "Codex recovery could not safely identify and settle active work from a saturated legacy replay epoch; Paperclip terminated the provider and closed the durable run",
                    "paperclipAccepted": false,
                    "providerReportedActive": provider_reported_active,
                    "ambiguousStartPending": ambiguous_turn_start_pending,
                    "providerShutdownFailed": provider_shutdown_failed,
                }),
            });
            self.save_state()?;
            return Ok(());
        }
        if let Some(reused_provider_turn_id) = recovered_active_turn_id
            .as_ref()
            .filter(|provider_turn_id| {
                settled_provider_turn_contains(
                    &settled_provider_turn_ids,
                    &settled_provider_turn_filter,
                    provider_turn_id,
                )
            })
            .cloned()
        {
            // The durable terminal ledger is authoritative. A resumed provider
            // that reports one of those identities as active is contradictory
            // and may still be mutating the workspace. Terminate that process
            // generation and persist the run closed before exposing recovery
            // to the controller; otherwise this path would reopen settled work.
            let provider_shutdown_failed = provider.shutdown().is_err();
            let state = self
                .state
                .as_mut()
                .expect("Codex state remains available during recovery");
            state.provider_process_generation = process_generation;
            state.settled_provider_turn_ids = settled_provider_turn_ids;
            state.settled_provider_turn_filter = settled_provider_turn_filter;
            state.active_provider_turn_id = None;
            state.ambiguous_turn_start_pending = false;
            state.completed_turn_authoritative = false;
            state.completed_turn_process_generation = None;
            state.completed_provider_turn_id = None;
            state.receipt_limit_diagnostic_emitted = false;
            state.receipt_limit_interrupt_pending = false;
            state.receipt_limit_interrupt_accepted = false;
            state.receipt_limit_interrupt_attempts = 0;
            state.receipt_limit_interrupt_deadline_unix_ms = None;
            state.last_agent_message = None;
            state.lifecycle = "closed".to_owned();
            // Closing the provider is the safety boundary. Preserve that
            // durable transition even when an already-full event backlog has
            // no room for an additional diagnostic.
            let _ = state.push_terminal_event(NormalizedProviderEvent {
                event_type: "harness.diagnostic".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": "codex",
                    "code": "provider_turn_identity_reused",
                    "providerTurnId": reused_provider_turn_id,
                    "message": "Codex recovery reported a previously settled turn identity as active; Paperclip terminated the provider and closed the durable run",
                    "paperclipAccepted": false,
                    "providerReportedActive": true,
                    "providerShutdownFailed": provider_shutdown_failed,
                }),
            });
            self.save_state()?;
            return Ok(());
        }
        if ambiguous_turn_start_pending {
            let recovered_turn_id = recovered_active_turn_id.as_deref().ok_or_else(|| {
                DurableRunnerError::invalid(
                    "cannot safely recover an ambiguous Codex turn start without an active replacement turn",
                )
            })?;
            if completed_provider_turn_id.as_deref() == Some(recovered_turn_id) {
                return Err(DurableRunnerError::invalid(
                    "ambiguous Codex turn recovery reused the previously completed turn identity",
                ));
            }
        }
        provider
            .restore_completed_turn_authority(
                completed_turn_authoritative
                    && recovered_active_turn_id.is_none()
                    && !ambiguous_turn_start_pending,
                completed_turn_process_generation,
                completed_provider_turn_id.as_deref(),
            )
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to restore Codex completion authority: {error}"
                ))
            })?;
        let resumed_provider_session_id = provider.provider_session_id().map(str::to_owned);
        let resumed_process_id = provider.process_id();
        {
            let state = self
                .state
                .as_mut()
                .expect("Codex state remains available during recovery");
            state.provider_process_generation = process_generation;
            state.provider_session_id = resumed_provider_session_id.clone();
            state.settled_provider_turn_ids = settled_provider_turn_ids;
            state.settled_provider_turn_filter = settled_provider_turn_filter;
            state.push_terminal_event(NormalizedProviderEvent {
                event_type: "session.resumed".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": "codex",
                    "providerSessionId": thread_id.clone(),
                    "providerAccountSessionId": resumed_provider_session_id,
                    "processId": resumed_process_id,
                }),
            })?;
        }
        self.provider = Some(provider);
        if provider_had_exited
            || ambiguous_turn_start_pending
            || recovered_active_turn_id != previous_active_turn_id
        {
            let recovered_turn_ended =
                previous_active_turn_id.is_some() && recovered_active_turn_id.is_none();
            let identity = self.event_identity.clone();
            let state = self
                .state
                .as_mut()
                .expect("Codex state remains available during recovery");
            if recovered_turn_ended {
                if !provider_epoch_requires_rollover {
                    state.settle_active_provider_turn_identity()?;
                }
                let settled = state
                    .tool_bridge
                    .settle_turn("provider_turn_terminated")
                    .map_err(|error| {
                        DurableRunnerError::invalid(format!(
                            "failed to settle semantic tools during recovery: {error}"
                        ))
                    })?;
                if !settled.is_empty() {
                    let identity = identity.as_ref().ok_or_else(|| {
                        DurableRunnerError::invalid(
                            "Codex semantic tool events require the durable runner identity",
                        )
                    })?;
                    for result in settled {
                        state.push_terminal_event(semantic_result_event(identity, &result))?;
                    }
                }
                state.receipt_limit_diagnostic_emitted = false;
                state.receipt_limit_interrupt_pending = false;
                state.receipt_limit_interrupt_accepted = false;
                state.receipt_limit_interrupt_attempts = 0;
                state.receipt_limit_interrupt_deadline_unix_ms = None;
            }
            state.reconcile_active_provider_turn(recovered_active_turn_id.clone());
            let reconciled = NormalizedProviderEvent {
                event_type: "session.reconciled".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": "codex",
                    "providerSessionId": thread_id,
                    "previousProviderTurnId": previous_active_turn_id.clone(),
                    "activeProviderTurnId": recovered_active_turn_id.clone(),
                }),
            };
            if recovered_turn_ended {
                state.push_terminal_event(reconciled)?;
                // A turn that disappeared while runnerd was offline has no
                // trustworthy success notification to replay. Terminate it
                // conservatively so the controller cannot wait forever or
                // mistake an unknown outcome for success.
                state.push_terminal_event(NormalizedProviderEvent {
                    event_type: "turn.failed".to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({
                        "provider": "codex",
                        "providerTurnId": previous_active_turn_id,
                        "status": "failed",
                        "providerTerminalObserved": false,
                    }),
                })?;
                state.extend_terminal_events(terminal_events(state, "turn.failed"))?;
            } else {
                state.push_event(reconciled)?;
            }
        }
        self.save_state()?;
        Ok(())
    }

    fn save_state(&self) -> Result<(), DurableRunnerError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider state is unavailable"))?;
        self.persist_state(state)
    }

    fn persist_state(&self, state: &CodexProviderState) -> Result<(), DurableRunnerError> {
        state.validate()?;
        fs::create_dir_all(&self.state_dir).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to create provider state directory: {error}"
            ))
        })?;
        #[cfg(unix)]
        fs::set_permissions(&self.state_dir, fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                DurableRunnerError::invalid(format!(
                    "failed to protect provider state directory: {error}"
                ))
            },
        )?;
        verify_private_directory(&self.state_dir)?;
        let path = self.state_path();
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to serialize Codex provider state: {error}"
            ))
        })?;
        if bytes.len() as u64 > MAX_PROVIDER_STATE_BYTES {
            return Err(DurableRunnerError::invalid(
                "Codex provider state exceeds the 16 MiB limit",
            ));
        }
        let (temporary, mut file) = create_private_temporary_file(&path)?;
        let result = (|| -> std::io::Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &path)?;
            #[cfg(unix)]
            File::open(&self.state_dir)?.sync_all()?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(DurableRunnerError::invalid(format!(
                "failed to replace provider state atomically: {error}"
            )));
        }
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to protect provider state: {error}"))
        })?;
        Ok(())
    }

    fn prepare(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let config: CodexProviderConfig = serde_json::from_value(
            payload
                .get("provider")
                .cloned()
                .ok_or_else(|| DurableRunnerError::invalid("run.prepare requires provider"))?,
        )
        .map_err(|error| {
            DurableRunnerError::invalid(format!("run.prepare provider is invalid: {error}"))
        })?;
        config
            .validate()
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        let completion_contract = completion_contract(payload)?;
        let tool_set = authorized_tool_set(payload)?;
        if let Some(state) = self.state.as_mut() {
            if state.config != config || state.completion_contract != completion_contract {
                return Err(DurableRunnerError::invalid(
                    "Codex provider or completion contract changed across the durable run",
                ));
            }
            if state.lifecycle == "closed" {
                return Err(DurableRunnerError::invalid(
                    "Codex provider session is already closed",
                ));
            }
            if state.tool_bridge.has_catalog() {
                state
                    .tool_bridge
                    .verify_tool_set(&tool_set)
                    .map_err(|error| {
                        DurableRunnerError::invalid(format!(
                            "run.prepare tool contract changed: {error}"
                        ))
                    })?;
            } else {
                state.tool_bridge.prepare(tool_set).map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "run.prepare tool contract rejected: {error}"
                    ))
                })?;
                self.save_state()?;
            }
        } else {
            let mut tool_bridge = ProviderToolBridge::default();
            tool_bridge.prepare(tool_set).map_err(|error| {
                DurableRunnerError::invalid(format!("run.prepare tool contract rejected: {error}"))
            })?;
            self.state = Some(CodexProviderState::new(
                config,
                completion_contract,
                tool_bridge,
            ));
            self.save_state()?;
        }
        Ok(CommandExecution::result(json!({
            "status": "prepared",
            "provider": "codex",
            "driver": "codex_app_server",
        })))
    }

    fn ensure_provider(&mut self) -> Result<&mut CodexProvider, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        if self.provider.is_none() {
            let state = self.state.as_ref().ok_or_else(|| {
                DurableRunnerError::invalid("Codex provider has not been prepared")
            })?;
            if state.lifecycle == "closed" {
                return Err(DurableRunnerError::invalid(
                    "Codex provider session is closed",
                ));
            }
            let process_generation = state
                .provider_process_generation
                .checked_add(1)
                .ok_or_else(|| DurableRunnerError::invalid("Codex process generation exhausted"))?;
            let (settled_provider_turn_ids, settled_provider_turn_filter) =
                state.recovered_settled_provider_turn_ids()?;
            let mut provider = CodexProvider::start_with_tools_for_generation(
                &state.config,
                state.tool_bridge.authorized_tools().cloned(),
                state.thread_id.as_deref(),
                process_generation,
            )
            .map_err(|error| {
                DurableRunnerError::invalid(format!("failed to start Codex provider: {error}"))
            })?;
            provider.enable_durable_tool_call_replays();
            provider
                .restore_settled_turn_identities(
                    settled_provider_turn_ids.iter().cloned(),
                    settled_provider_turn_filter.clone(),
                )
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to restore Codex provider turn identities: {error}"
                    ))
                })?;
            provider
                .restore_completed_turn_authority(
                    state.completed_turn_authoritative
                        && provider.active_provider_turn_id().is_none(),
                    state.completed_turn_process_generation,
                    state.completed_provider_turn_id.as_deref(),
                )
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to restore Codex completion authority: {error}"
                    ))
                })?;
            self.provider = Some(provider);
            {
                let state = self
                    .state
                    .as_mut()
                    .expect("Codex state remains available after provider start");
                state.provider_process_generation = process_generation;
                state.settled_provider_turn_ids = settled_provider_turn_ids;
                state.settled_provider_turn_filter = settled_provider_turn_filter;
            }
            self.save_state()?;
        }
        self.provider
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is unavailable"))
    }

    fn verify_attached_tools(&self, payload: &Value) -> Result<(), DurableRunnerError> {
        if payload.get("authorizedTools").is_none() {
            return Ok(());
        }
        let tool_set = authorized_tool_set(payload)?;
        self.state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider has not been prepared"))?
            .tool_bridge
            .verify_tool_set(&tool_set)
            .map_err(|error| {
                DurableRunnerError::invalid(format!("run.attach tool contract changed: {error}"))
            })
    }

    fn open_session(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.lifecycle == "turn_active")
        {
            return Err(DurableRunnerError::invalid(
                "cannot open a new Codex session while a provider turn is active",
            ));
        }
        let resumed = self
            .state
            .as_ref()
            .and_then(|state| state.thread_id.as_ref())
            .is_some();
        let (thread_id, provider_session_id, process_id) = {
            let provider = self.ensure_provider()?;
            (
                provider.thread_id().to_owned(),
                provider.provider_session_id().map(str::to_owned),
                provider.process_id(),
            )
        };
        let provider_version = {
            let state = self
                .state
                .as_mut()
                .expect("Codex state exists after provider start");
            state.thread_id = Some(thread_id.clone());
            state.provider_session_id = provider_session_id.clone();
            state.active_provider_turn_id = None;
            state.receipt_limit_diagnostic_emitted = false;
            state.receipt_limit_interrupt_pending = false;
            state.receipt_limit_interrupt_accepted = false;
            state.receipt_limit_interrupt_attempts = 0;
            state.receipt_limit_interrupt_deadline_unix_ms = None;
            state.lifecycle = "session_open".to_owned();
            state.config.provider_version.clone()
        };
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({
                "status": if resumed { "resumed" } else { "started" },
                "provider": "codex",
                "driver": "codex_app_server",
                "providerVersion": provider_version,
                "providerSessionId": thread_id,
                "processId": process_id,
            }),
            events: vec![(
                if resumed {
                    "session.resumed"
                } else {
                    "session.started"
                }
                .to_owned(),
                EventPriority::P0,
                json!({
                    "provider": "codex",
                    "providerSessionId": thread_id,
                    "providerAccountSessionId": provider_session_id,
                    "processId": process_id,
                }),
            )],
        })
    }

    fn close_after_rejected_provider_acceptance(
        &mut self,
        rejected_accepted_turn: &RejectedAcceptedTurn,
    ) -> Result<(), DurableRunnerError> {
        let provider_process_generation = self
            .provider
            .as_ref()
            .map(CodexProvider::process_generation);
        // The provider has already been terminated. Drop its quarantined
        // handle before persisting the closure so recovery can never resume
        // work that Codex accepted without Paperclip accepting its identity.
        self.provider = None;
        let state = self
            .state
            .as_mut()
            .expect("Codex state remains available after rejected provider acceptance");
        if let Some(provider_process_generation) = provider_process_generation {
            state.provider_process_generation = provider_process_generation;
        }
        state.active_provider_turn_id = None;
        state.ambiguous_turn_start_pending = false;
        state.completed_turn_authoritative = false;
        state.completed_turn_process_generation = None;
        state.completed_provider_turn_id = None;
        state.receipt_limit_diagnostic_emitted = false;
        state.receipt_limit_interrupt_pending = false;
        state.receipt_limit_interrupt_accepted = false;
        state.receipt_limit_interrupt_attempts = 0;
        state.receipt_limit_interrupt_deadline_unix_ms = None;
        state.last_agent_message = None;
        state.lifecycle = "closed".to_owned();
        // Closure is the safety boundary. Preserve it even if a saturated
        // event queue cannot retain this additional diagnostic.
        let _ = state.push_terminal_event(NormalizedProviderEvent {
            event_type: "harness.diagnostic".to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "provider": "codex",
                "code": match rejected_accepted_turn {
                    RejectedAcceptedTurn::ReusedIdentity(_) => "provider_turn_identity_reused",
                    RejectedAcceptedTurn::InvalidIdentity => "provider_turn_identity_invalid",
                },
                "providerTurnId": match rejected_accepted_turn {
                    RejectedAcceptedTurn::ReusedIdentity(provider_turn_id) => json!(provider_turn_id),
                    RejectedAcceptedTurn::InvalidIdentity => Value::Null,
                },
                "message": match rejected_accepted_turn {
                    RejectedAcceptedTurn::ReusedIdentity(_) => "Codex accepted work with a previously settled turn identity; Paperclip terminated the provider and closed the durable run",
                    RejectedAcceptedTurn::InvalidIdentity => "Codex accepted work without a valid bounded turn identity; Paperclip terminated the provider and closed the durable run",
                },
                "paperclipAccepted": false,
                "providerAccepted": true,
            }),
        });
        self.save_state()
    }

    fn rollover_provider_identity_epochs_if_needed(&mut self) -> Result<(), DurableRunnerError> {
        let tool_rollover_required = self
            .state
            .as_ref()
            .is_some_and(|state| state.tool_bridge.replay_history_blocks_admission());
        let rollover_required = self.state.as_ref().is_some_and(|state| {
            state.settled_provider_turn_ids.len() >= MAX_SETTLED_PROVIDER_TURN_IDS
                || !state.settled_provider_turn_filter.is_empty()
                || tool_rollover_required
        });
        if !rollover_required {
            return Ok(());
        }
        let rollover_is_safe = self.state.as_ref().is_some_and(|state| {
            state.active_provider_turn_id.is_none()
                && !state.ambiguous_turn_start_pending
                && state.lifecycle == "session_open"
        });
        if !rollover_is_safe {
            return Err(DurableRunnerError::invalid(
                "Codex provider identity epoch cannot rotate while work is active",
            ));
        }

        let (restart_result, process_generation, rejected_accepted_turn) = {
            let provider = self.provider.as_mut().ok_or_else(|| {
                DurableRunnerError::invalid(
                    "Codex provider identity epoch cannot rotate without an attached process",
                )
            })?;
            let restart_result = provider.restart_idle_identity_epoch();
            (
                restart_result,
                provider.process_generation(),
                provider.take_rejected_accepted_turn(),
            )
        };
        if let Err(error) = restart_result {
            if let Some(rejected_accepted_turn) = rejected_accepted_turn {
                let failure_kind = match &rejected_accepted_turn {
                    RejectedAcceptedTurn::ReusedIdentity(_) => "accepted identity reuse",
                    RejectedAcceptedTurn::InvalidIdentity => "an invalid accepted identity",
                };
                self.close_after_rejected_provider_acceptance(&rejected_accepted_turn)?;
                return Err(DurableRunnerError::invalid(format!(
                    "Codex identity epoch rollover failed closed after {failure_kind}: {error}"
                )));
            }
            return Err(DurableRunnerError::invalid(format!(
                "failed to rotate the completed Codex identity epoch: {error}"
            )));
        };
        let state = self
            .state
            .as_mut()
            .expect("Codex state remains available during identity epoch rollover");
        state.provider_process_generation = process_generation;
        state.settled_provider_turn_ids.clear();
        if let Some(completed_provider_turn_id) = state.completed_provider_turn_id.clone() {
            // The replacement process restored this still-authoritative
            // terminal into its fresh epoch. Mirror that one tombstone in the
            // durable ledger until accepting replacement work revokes the
            // completion authority.
            state
                .settled_provider_turn_ids
                .insert(completed_provider_turn_id);
        }
        state.settled_provider_turn_filter = DurableReplayFilter::default();
        if tool_rollover_required {
            state
                .tool_bridge
                .rollover_replay_epoch_after_provider_restart()
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to rotate Codex semantic tool replay authority: {error}"
                    ))
                })?;
        }
        self.save_state()?;
        Ok(())
    }

    fn start_turn(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.lifecycle == "closed")
        {
            return Err(DurableRunnerError::invalid(
                "Codex provider session is closed",
            ));
        }
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.active_provider_turn_id.is_some())
        {
            return Err(DurableRunnerError::invalid(
                "Codex already has an active provider turn",
            ));
        }
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.ambiguous_turn_start_pending)
        {
            return Err(DurableRunnerError::invalid(
                "Codex has an unresolved ambiguous provider turn start",
            ));
        }
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.queued_events.len() >= MAX_REGULAR_QUEUED_PROVIDER_EVENTS)
        {
            return Err(DurableRunnerError::invalid(
                "cannot start a new Codex turn until terminal events are acknowledged",
            ));
        }
        self.state
            .as_mut()
            .expect("Codex state remains available before turn receipt preparation")
            .tool_bridge
            .prepare_turn()
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "Codex semantic tool receipts could not prepare the next turn: {error}"
                ))
            })?;
        self.rollover_provider_identity_epochs_if_needed()?;
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("turn.start payload.text is required"))?;
        let cwd = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is not prepared"))?
            .config
            .cwd
            .clone();
        self.ensure_provider()?;
        {
            let state = self
                .state
                .as_mut()
                .expect("Codex state remains available before turn/start dispatch");
            state.ambiguous_turn_start_pending = true;
        }
        self.save_state()?;
        let (
            start_result,
            completion_authority_retained,
            ambiguous_turn_start_pending,
            rejected_accepted_turn,
        ) = {
            let provider = self.ensure_provider()?;
            let result = provider.start_turn(text, &cwd);
            (
                result,
                provider.completed_turn_authority().is_some(),
                provider.ambiguous_turn_start_pending(),
                provider.take_rejected_accepted_turn(),
            )
        };
        if let Err(error) = start_result {
            if let Some(rejected_accepted_turn) = rejected_accepted_turn {
                // Codex accepted this work before disclosing a usable durable
                // identity. The provider has already been terminated; close
                // this run before returning so recovery cannot resume the
                // untracked turn from the provider's thread snapshot.
                self.close_after_rejected_provider_acceptance(&rejected_accepted_turn)?;
                let failure_kind = match &rejected_accepted_turn {
                    RejectedAcceptedTurn::ReusedIdentity(_) => "accepted identity reuse",
                    RejectedAcceptedTurn::InvalidIdentity => "an invalid accepted identity",
                };
                return Err(DurableRunnerError::invalid(format!(
                    "Codex turn/start failed closed after {failure_kind}: {error}"
                )));
            }
            let state = self
                .state
                .as_mut()
                .expect("Codex state remains available after turn/start failure");
            state.ambiguous_turn_start_pending = ambiguous_turn_start_pending;
            if !completion_authority_retained && !ambiguous_turn_start_pending {
                state.completed_turn_authoritative = false;
                state.completed_turn_process_generation = None;
                state.completed_provider_turn_id = None;
                state.last_agent_message = None;
            }
            self.save_state()?;
            return Err(DurableRunnerError::invalid(format!(
                "Codex turn/start failed: {error}"
            )));
        }
        let (provider_turn_id, thread_id) = {
            let provider = self
                .provider
                .as_ref()
                .expect("Codex provider remains available after turn/start acceptance");
            (
                provider
                    .active_provider_turn_id()
                    .ok_or_else(|| {
                        DurableRunnerError::invalid("Codex turn/start omitted its turn identity")
                    })?
                    .to_owned(),
                provider.thread_id().to_owned(),
            )
        };
        let state = self
            .state
            .as_mut()
            .expect("Codex state exists after turn start");
        state.active_provider_turn_id = Some(provider_turn_id.clone());
        state.ambiguous_turn_start_pending = false;
        state.completed_turn_authoritative = false;
        state.completed_turn_process_generation = None;
        state.completed_provider_turn_id = None;
        state.receipt_limit_diagnostic_emitted = false;
        state.receipt_limit_interrupt_pending = false;
        state.receipt_limit_interrupt_accepted = false;
        state.receipt_limit_interrupt_attempts = 0;
        state.receipt_limit_interrupt_deadline_unix_ms = None;
        state.last_agent_message = None;
        state.lifecycle = "turn_active".to_owned();
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({"status": "accepted", "providerTurnId": provider_turn_id}),
            events: vec![(
                "turn.accepted".to_owned(),
                EventPriority::P0,
                json!({"provider": "codex", "providerSessionId": thread_id, "providerTurnId": provider_turn_id}),
            )],
        })
    }

    fn interrupt_turn(&mut self, reason: &str) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        let provider_turn_id = self
            .state
            .as_ref()
            .and_then(|state| state.active_provider_turn_id.clone());
        if provider_turn_id.is_none() {
            return Ok(CommandExecution::result(json!({
                "status": "already_settled",
                "reason": reason,
            })));
        }
        let has_pending_tools = self
            .state
            .as_ref()
            .is_some_and(|state| state.tool_bridge.pending_calls().next().is_some());
        if has_pending_tools {
            let identity = self.event_identity()?;
            let mut next_state = self
                .state
                .clone()
                .expect("Codex state remains available during interruption");
            let cancelled = next_state
                .tool_bridge
                .cancel_pending_calls("provider_turn_stopped")
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to cancel pending semantic tools: {error}"
                    ))
                })?;
            for result in cancelled {
                next_state.push_terminal_event(semantic_result_event(&identity, &result))?;
            }
            self.persist_state(&next_state)?;
            self.state = Some(next_state);
        }
        self.ensure_provider()?.interrupt_turn().map_err(|error| {
            DurableRunnerError::invalid(format!("Codex turn interrupt failed: {error}"))
        })?;
        Ok(CommandExecution::result(json!({
            "status": "interrupt_requested",
            "reason": reason,
            "providerTurnId": provider_turn_id,
        })))
    }

    fn steer_turn(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("turn.steer payload.text is required"))?;
        self.ensure_provider()?.steer_turn(text).map_err(|error| {
            DurableRunnerError::invalid(format!("Codex turn steer failed: {error}"))
        })?;
        Ok(CommandExecution::result(json!({"status": "steered"})))
    }

    fn resolve_request(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let request_id = payload
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires requestId"))?;
        if self
            .state
            .as_ref()
            .is_none_or(|state| state.active_provider_turn_id.is_none())
        {
            return Err(DurableRunnerError::invalid(
                "cannot resolve a Codex runtime request outside an active turn",
            ));
        }
        let response = payload
            .get("response")
            .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires response"))?;
        self.ensure_provider()?
            .resolve_runtime_request(request_id, response)
            .map_err(|error| {
                DurableRunnerError::invalid(format!("Codex runtime response failed: {error}"))
            })?;
        Ok(CommandExecution {
            result: json!({"status": "delivered", "requestId": request_id}),
            events: vec![(
                "runtime_request.resolved".to_owned(),
                EventPriority::P0,
                json!({"provider": "codex", "requestId": request_id, "status": "delivered"}),
            )],
        })
    }

    fn event_identity(&self) -> Result<ProviderEventIdentity, DurableRunnerError> {
        self.event_identity.clone().ok_or_else(|| {
            DurableRunnerError::invalid(
                "Codex semantic tool events require the durable runner identity",
            )
        })
    }

    fn reject_tool_call(
        &mut self,
        call_id: String,
        operation_id: String,
        reason: String,
    ) -> Result<(), DurableRunnerError> {
        let state = self
            .state
            .as_mut()
            .expect("Codex state remains available for a rejected tool call");
        let event = NormalizedProviderEvent {
            event_type: "harness.diagnostic".to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "provider": "codex",
                "code": "semantic_tool_denied",
                "operationId": operation_id,
                "callId": call_id,
                "message": reason,
                "paperclipExecuted": false,
            }),
        };
        if state.receipt_limit_interrupt_pending {
            state.push_receipt_limit_cleanup_event(event)?;
        } else {
            state.push_event(event)?;
        }
        self.save_state()?;
        let rejection = ToolResult {
            call_id,
            operation_id,
            result: json!({
                "error": {
                    "code": "invalid_tool_call",
                    "message": "Paperclip rejected this semantic tool call",
                    "retryable": false,
                },
            }),
            is_error: true,
        };
        self.provider
            .as_mut()
            .expect("provider remains present while rejecting its tool call")
            .deliver_tool_result(&rejection)
            .map_err(|delivery_error| {
                DurableRunnerError::invalid(format!(
                    "failed to return the semantic tool rejection: {delivery_error}"
                ))
            })
    }

    fn stop_turn_at_tool_receipt_limit(
        &mut self,
        call_id: String,
        operation_id: String,
    ) -> Result<(), DurableRunnerError> {
        let deadline_unix_ms =
            receipt_limit_deadline_after(RECEIPT_LIMIT_INTERRUPT_TERMINAL_DEADLINE_MS)?;
        let state = self
            .state
            .as_mut()
            .expect("Codex state remains available at its tool receipt limit");
        let interrupt_pending = state.begin_receipt_limit_stop(
            call_id.clone(),
            operation_id.clone(),
            deadline_unix_ms,
        )?;
        let first_interrupt_attempt =
            interrupt_pending && state.receipt_limit_interrupt_attempts == 0;
        if interrupt_pending {
            self.save_state()?;
        }
        // The durable diagnostic owns the turn-level failure, while every
        // buffered JSON-RPC call still receives an explicit provider error.
        // Deliver the rejection before requesting interruption: Codex may
        // close the transport as part of the interrupt, and a failed courtesy
        // RPC must never abort runnerd's terminal polling loop.
        let rejection = ToolResult {
            call_id,
            operation_id,
            result: json!({
                "error": {
                    "code": "semantic_tool_turn_receipt_limit",
                    "message": "Paperclip stopped this turn at its durable semantic-tool receipt limit",
                    "retryable": false,
                },
            }),
            is_error: true,
        };
        if let Some(provider) = self.provider.as_mut() {
            let _ = provider.deliver_tool_result(&rejection);
        }
        if first_interrupt_attempt {
            // Keep the durable retry marker until a terminal notification is
            // observed. Provider acceptance acknowledges only this RPC; it
            // does not prove that the turn stopped. Later buffered calls may
            // therefore retry the idempotent interruption instead of leaving
            // a still-active receipt-exhausted turn permanently unstopped.
            self.state
                .as_mut()
                .expect("Codex state remains available before receipt-limit interruption")
                .record_receipt_limit_interrupt_attempt()?;
            self.save_state()?;
            match self.interrupt_turn("semantic_tool_turn_receipt_limit") {
                Ok(_) => {
                    let accepted_deadline_unix_ms =
                        receipt_limit_deadline_after(RECEIPT_LIMIT_ACCEPTED_TERMINAL_DEADLINE_MS)?;
                    self.state
                        .as_mut()
                        .expect("Codex state remains available after receipt-limit interruption")
                        .mark_receipt_limit_interrupt_accepted(accepted_deadline_unix_ms);
                    self.save_state()?;
                }
                // The first interruption attempt is also best-effort. Its
                // durable retry marker is already saved, and propagating the
                // transport error here would terminate runnerd before it can
                // poll the provider's terminal notification.
                Err(_) => {}
            }
        }
        Ok(())
    }

    fn settle_receipt_limit_interrupt_after_deadline(&mut self) -> Result<(), DurableRunnerError> {
        let interrupt_accepted = self
            .state
            .as_ref()
            .is_some_and(|state| state.receipt_limit_interrupt_accepted);
        let provider_shutdown_failed = self
            .provider
            .as_mut()
            .is_some_and(|provider| provider.shutdown().is_err());
        self.provider = None;
        let identity = self.event_identity()?;
        let state = self
            .state
            .as_mut()
            .expect("Codex state remains available at its receipt-limit retry bound");
        state.settle_active_provider_turn_identity()?;
        let settled = state
            .tool_bridge
            .settle_turn("semantic_tool_turn_receipt_limit")
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to settle semantic tools at the receipt-limit retry bound: {error}"
                ))
            })?;
        for result in settled {
            state.push_terminal_event(semantic_result_event(&identity, &result))?;
        }
        state.active_provider_turn_id = None;
        state.completed_turn_authoritative = false;
        state.receipt_limit_diagnostic_emitted = false;
        state.receipt_limit_interrupt_pending = false;
        state.receipt_limit_interrupt_accepted = false;
        state.receipt_limit_interrupt_attempts = 0;
        state.receipt_limit_interrupt_deadline_unix_ms = None;
        state.lifecycle = "provider_exited".to_owned();
        let terminal_event_type = if interrupt_accepted {
            "turn.interrupted"
        } else {
            "turn.failed"
        };
        state.push_terminal_event(NormalizedProviderEvent {
            event_type: terminal_event_type.to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "provider": "codex",
                "code": if interrupt_accepted {
                    "semantic_tool_turn_receipt_limit_interrupt_deadline"
                } else {
                    "semantic_tool_turn_receipt_limit_interrupt_unconfirmed"
                },
                "message": if interrupt_accepted {
                    "Codex accepted the receipt-limit interruption but did not emit its terminal before the bounded shutdown deadline"
                } else {
                    "Codex did not confirm terminal state after the bounded receipt-limit interruption attempts"
                },
                "interruptAccepted": interrupt_accepted,
                "providerTerminalObserved": false,
                "providerShutdownFailed": provider_shutdown_failed,
            }),
        })?;
        let terminal = terminal_events(state, terminal_event_type);
        state.extend_terminal_events(terminal)?;
        self.save_state()
    }

    fn retry_receipt_limit_interrupt(&mut self) -> Result<(), DurableRunnerError> {
        let (should_retry, attempts, persisted_deadline) =
            self.state.as_ref().map_or((false, 0, None), |state| {
                (
                    state.receipt_limit_interrupt_pending
                        && state.active_provider_turn_id.is_some(),
                    state.receipt_limit_interrupt_attempts,
                    state.receipt_limit_interrupt_deadline_unix_ms,
                )
            });
        if !should_retry {
            return Ok(());
        }
        let now_unix_ms = current_unix_ms()?;
        let deadline_unix_ms = match persisted_deadline {
            Some(deadline) => deadline,
            None => {
                // Older durable state did not record this additive field. Give
                // an already-pending interruption one complete bounded window
                // after recovery rather than falling back on poll count alone.
                let timeout_ms = if self
                    .state
                    .as_ref()
                    .is_some_and(|state| state.receipt_limit_interrupt_accepted)
                {
                    RECEIPT_LIMIT_ACCEPTED_TERMINAL_DEADLINE_MS
                } else {
                    RECEIPT_LIMIT_INTERRUPT_TERMINAL_DEADLINE_MS
                };
                let deadline = receipt_limit_deadline_after(timeout_ms)?;
                self.state
                    .as_mut()
                    .expect("Codex state remains available while adding its receipt-limit deadline")
                    .receipt_limit_interrupt_deadline_unix_ms = Some(deadline);
                self.save_state()?;
                deadline
            }
        };
        // Attempts bound network traffic, while the durable wall-clock deadline
        // gives an accepted asynchronous interruption time to deliver its
        // authoritative terminal. The provider is always polled once more below
        // before an elapsed deadline is converted into the conservative fallback.
        if attempts >= MAX_RECEIPT_LIMIT_INTERRUPT_ATTEMPTS || now_unix_ms >= deadline_unix_ms {
            return Ok(());
        }
        // Polling is the autonomous recovery path until a terminal notification
        // clears the durable marker. RPC acceptance alone does not establish
        // that Codex stopped the turn, so accepted-but-unsettled interruptions
        // remain idempotently retryable across polls and process restarts.
        self.state
            .as_mut()
            .expect("Codex state remains available before receipt-limit retry")
            .record_receipt_limit_interrupt_attempt()?;
        self.save_state()?;
        if self
            .interrupt_turn("semantic_tool_turn_receipt_limit_retry")
            .is_ok()
            && self.state.as_ref().is_some_and(|state| {
                state.receipt_limit_interrupt_pending && state.active_provider_turn_id.is_some()
            })
        {
            let accepted_deadline_unix_ms =
                receipt_limit_deadline_after(RECEIPT_LIMIT_ACCEPTED_TERMINAL_DEADLINE_MS)?;
            self.state
                .as_mut()
                .expect("Codex state remains available after receipt-limit retry")
                .mark_receipt_limit_interrupt_accepted(accepted_deadline_unix_ms);
            self.save_state()?;
        }
        Ok(())
    }

    fn settle_receipt_limit_interrupt_if_deadline_elapsed(
        &mut self,
    ) -> Result<(), DurableRunnerError> {
        let deadline = self.state.as_ref().and_then(|state| {
            (state.receipt_limit_interrupt_pending && state.active_provider_turn_id.is_some())
                .then_some(state.receipt_limit_interrupt_deadline_unix_ms)
                .flatten()
        });
        let Some(deadline) = deadline else {
            return Ok(());
        };
        if current_unix_ms()? >= deadline {
            self.settle_receipt_limit_interrupt_after_deadline()?;
        }
        Ok(())
    }

    fn handle_tool_call(
        &mut self,
        call_id: String,
        operation_id: String,
        input: Value,
    ) -> Result<(), DurableRunnerError> {
        let identity = self.event_identity()?;
        let admission = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is not prepared"))?
            .admit_tool_call(&call_id, &operation_id, &input);
        match admission {
            Ok(ToolCallAdmission::CompletedReplay(result)) => {
                self.provider
                    .as_mut()
                    .expect("provider remains present while handling its tool call")
                    .deliver_tool_result(&result)
                    .map_err(|error| {
                        DurableRunnerError::invalid(format!(
                            "failed to replay a durable semantic tool result: {error}"
                        ))
                    })?;
                return Ok(());
            }
            Ok(ToolCallAdmission::PendingReplay) => return Ok(()),
            Err(error) => {
                if error.is_active_turn_receipt_limit() {
                    return self.stop_turn_at_tool_receipt_limit(call_id, operation_id);
                }
                return self.reject_tool_call(call_id, operation_id, error.to_string());
            }
            Ok(ToolCallAdmission::Pending(call)) => {
                self.state
                    .as_mut()
                    .expect("Codex state remains available while accepting a tool call")
                    .push_event(semantic_input_event(&identity, &call))?;
                self.save_state()
            }
        }
    }

    fn deliver_semantic_result(
        &mut self,
        payload: &Value,
    ) -> Result<CommandExecution, DurableRunnerError> {
        let result: ToolResult = serde_json::from_value(payload.clone()).map_err(|error| {
            DurableRunnerError::invalid(format!("semantic tool result is invalid: {error}"))
        })?;
        let identity = self.event_identity()?;
        let was_completed = self
            .state
            .as_ref()
            .is_some_and(|state| state.tool_bridge.has_completed_call(&result.call_id));
        let mut next_state = self
            .state
            .clone()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is not prepared"))?;
        next_state
            .tool_bridge
            .apply_result(result.clone())
            .map_err(|error| {
                DurableRunnerError::invalid(format!("semantic tool result was rejected: {error}"))
            })?;
        if was_completed {
            return Ok(CommandExecution::result(json!({
                "status": "duplicate",
                "callId": result.call_id,
            })));
        }
        next_state.push_event(semantic_result_event(&identity, &result))?;
        self.persist_state(&next_state)?;
        self.state = Some(next_state);
        self.ensure_provider()?
            .deliver_tool_result(&result)
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to return semantic tool result to Codex: {error}"
                ))
            })?;
        Ok(CommandExecution::result(json!({
            "status": "delivered",
            "callId": result.call_id,
        })))
    }

    fn close_session(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        if let Some(provider) = self.provider.as_mut() {
            provider.shutdown().map_err(|error| {
                DurableRunnerError::invalid(format!("failed to stop Codex provider: {error}"))
            })?;
        }
        self.provider = None;
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is not prepared"))?;
        state.active_provider_turn_id = None;
        state.ambiguous_turn_start_pending = false;
        state.receipt_limit_diagnostic_emitted = false;
        state.receipt_limit_interrupt_pending = false;
        state.receipt_limit_interrupt_accepted = false;
        state.receipt_limit_interrupt_attempts = 0;
        state.receipt_limit_interrupt_deadline_unix_ms = None;
        state.lifecycle = "closed".to_owned();
        let thread_id = state.thread_id.clone();
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({"status": "closed", "providerSessionId": thread_id}),
            events: vec![(
                "session.closed".to_owned(),
                EventPriority::P0,
                json!({"provider": "codex", "providerSessionId": thread_id}),
            )],
        })
    }

    fn snapshot(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is not prepared"))?;
        Ok(CommandExecution::result(json!({
            "status": state.lifecycle,
            "provider": "codex",
            "driver": "codex_app_server",
            "providerSessionId": state.thread_id,
            "activeProviderTurnId": state.active_provider_turn_id,
        })))
    }

    fn poll_provider(&mut self) -> Result<(), DurableRunnerError> {
        self.restore()?;
        // `restore_checked` records that the durable file was loaded even when
        // provider recovery failed. Retry the provider reconciliation here so
        // an ambiguous-start failure cannot degrade into an empty successful
        // poll on the same executor.
        self.restore_provider_if_needed()?;
        // Receipt-limit interruption is autonomous recovery. It must advance
        // even while older durable events await acknowledgement, otherwise a
        // slow or disconnected controller can keep an exhausted provider turn
        // alive forever. Terminal settlement uses the reserved event capacity.
        self.retry_receipt_limit_interrupt()?;
        let receipt_limit_terminal_poll = self.state.as_ref().is_some_and(|state| {
            state.receipt_limit_interrupt_pending && state.active_provider_turn_id.is_some()
        });
        if !receipt_limit_terminal_poll
            && self
                .state
                .as_ref()
                .is_some_and(|state| !state.pending_events.is_empty())
        {
            return Ok(());
        }
        if self.provider.is_none() {
            return self.settle_receipt_limit_interrupt_if_deadline_elapsed();
        }
        for _ in 0..MAX_EVENTS_PER_POLL {
            let event = self
                .provider
                .as_mut()
                .expect("provider remains present while polling")
                .poll()
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("Codex provider failed: {error}"))
                })?;
            let Some(event) = event else { break };
            let trace_frame_id = self
                .provider
                .as_mut()
                .and_then(CodexProvider::take_provider_trace_frame_id);
            match event {
                CodexProviderEvent::ToolCall {
                    call_id,
                    operation_id,
                    input,
                } => {
                    self.handle_tool_call(call_id, operation_id, input)?;
                }
                CodexProviderEvent::Notification { method, params } => {
                    let active_provider_turn_id = if method == "turn/started" {
                        self.provider
                            .as_ref()
                            .and_then(CodexProvider::active_provider_turn_id)
                            .map(str::to_owned)
                    } else {
                        None
                    };
                    let normalized_terminal_type =
                        normalized_codex_terminal_event_type(&method, &params);
                    let completed_turn_authority =
                        if normalized_terminal_type == Some("turn.completed") {
                            self.provider
                                .as_ref()
                                .and_then(CodexProvider::completed_turn_authority)
                                .map(|(generation, turn_id)| (generation, turn_id.to_owned()))
                        } else {
                            None
                        };
                    let normalized = normalize_codex_notification(&method, &params);
                    let normalized_event_count = normalized.len();
                    let terminal_event_type = normalized
                        .iter()
                        .find(|event| event.event_type.starts_with("turn."))
                        .map(|event| event.event_type.clone())
                        .filter(|event_type| {
                            matches!(
                                event_type.as_str(),
                                "turn.completed"
                                    | "turn.failed"
                                    | "turn.cancelled"
                                    | "turn.interrupted"
                            )
                        });
                    let identity = self.event_identity.clone();
                    let state = self
                        .state
                        .as_mut()
                        .expect("Codex state remains available while polling");
                    if method == "item/completed" {
                        let item = params.get("item").unwrap_or(&params);
                        if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                            state.last_agent_message = item
                                .get("text")
                                .and_then(Value::as_str)
                                .filter(|text| !text.is_empty())
                                .map(|text| text.chars().take(1_000_000).collect());
                        }
                    }
                    if method == "turn/started" {
                        let provider_turn_id = active_provider_turn_id.ok_or_else(|| {
                            DurableRunnerError::invalid(
                                "Codex turn start notification omitted active turn authority",
                            )
                        })?;
                        state.reconcile_active_provider_turn(Some(provider_turn_id));
                    }
                    if terminal_event_type.is_some() {
                        state.settle_active_provider_turn_identity()?;
                        let settled = state
                            .tool_bridge
                            .settle_turn("provider_turn_terminated")
                            .map_err(|error| {
                                DurableRunnerError::invalid(format!(
                                    "failed to settle semantic tools at turn termination: {error}"
                                ))
                            })?;
                        if !settled.is_empty() {
                            let identity = identity.as_ref().ok_or_else(|| {
                                DurableRunnerError::invalid(
                                    "Codex semantic tool events require the durable runner identity",
                                )
                            })?;
                            for result in settled {
                                state.push_terminal_event(semantic_result_event(
                                    identity, &result,
                                ))?;
                            }
                        }
                        state.active_provider_turn_id = None;
                        if terminal_event_type.as_deref() == Some("turn.completed") {
                            let (process_generation, provider_turn_id) = completed_turn_authority
                                .ok_or_else(|| {
                                DurableRunnerError::invalid(
                                    "Codex completion omitted process and turn authority",
                                )
                            })?;
                            state.completed_turn_authoritative = true;
                            state.completed_turn_process_generation = Some(process_generation);
                            state.completed_provider_turn_id = Some(provider_turn_id);
                        } else {
                            state.completed_turn_authoritative = false;
                            state.completed_turn_process_generation = None;
                            state.completed_provider_turn_id = None;
                        }
                        state.receipt_limit_diagnostic_emitted = false;
                        state.receipt_limit_interrupt_pending = false;
                        state.receipt_limit_interrupt_accepted = false;
                        state.receipt_limit_interrupt_attempts = 0;
                        state.receipt_limit_interrupt_deadline_unix_ms = None;
                        state.ambiguous_turn_start_pending = false;
                        state.lifecycle = "session_open".to_owned();
                    }
                    let trace_first_event_sequence = state.next_provider_event_seq;
                    if terminal_event_type.is_some() {
                        state.extend_terminal_events(normalized)?;
                    } else if receipt_limit_terminal_poll {
                        for event in normalized {
                            state.push_receipt_limit_cleanup_event(event)?;
                        }
                    } else {
                        state.extend_events(normalized)?;
                    }
                    let trace_last_event_sequence = state.next_provider_event_seq;
                    if let Some(event_type) = terminal_event_type {
                        state.extend_terminal_events(terminal_events(state, &event_type))?;
                    }
                    let trace_emitted_event_ids = identity
                        .as_ref()
                        .map(|identity| {
                            (trace_first_event_sequence..trace_last_event_sequence)
                                .map(provider_event_id)
                                .map(|event_id| identity.source_event_id(&event_id))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    self.save_state()?;
                    if let (Some(frame_id), Some(provider)) =
                        (trace_frame_id, self.provider.as_mut())
                    {
                        provider.record_provider_trace_interpretation(
                            frame_id,
                            &format!("codex.normalize.{}", method.replace('/', ".")),
                            if normalized_event_count > 0 {
                                "mapped"
                            } else {
                                "ignored"
                            },
                            trace_emitted_event_ids,
                            if normalized_event_count > 0 {
                                "Provider notification normalized into durable PRP events"
                            } else {
                                "Provider notification did not produce a durable PRP event"
                            },
                        );
                    }
                }
                CodexProviderEvent::RuntimeRequest {
                    request_id,
                    question_set,
                } => {
                    let prompt = question_set
                        .get("title")
                        .or_else(|| question_set.pointer("/questions/0/prompt"))
                        .and_then(Value::as_str)
                        .unwrap_or("Codex needs your input");
                    let state = self
                        .state
                        .as_mut()
                        .expect("Codex state remains available while polling");
                    let event = NormalizedProviderEvent {
                        event_type: "runtime_request.created".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({
                            "request": {
                                "schema": "paperclip.runtime_request.v2",
                                "requestKind": "runtime",
                                "requestId": request_id,
                                "type": "input",
                                "status": "pending",
                                "prompt": prompt,
                                "input": question_set,
                                "origin": {
                                    "adapter": "codex-app-server",
                                    "provider": "codex",
                                    "method": "item/tool/requestUserInput",
                                },
                            },
                        }),
                    };
                    if receipt_limit_terminal_poll {
                        state.push_receipt_limit_cleanup_event(event)?;
                    } else {
                        state.push_event(event)?;
                    }
                    self.save_state()?;
                }
                CodexProviderEvent::Exited {
                    exit_code,
                    success,
                    completed_turn_authoritative,
                    completed_turn_observed_by_process,
                    completion_reconciles_exit,
                    process_generation,
                    completed_turn_process_generation,
                } => {
                    self.provider = None;
                    if !success {
                        let state = self
                            .state
                            .as_mut()
                            .expect("Codex state remains available while polling");
                        // The durable terminal remains the run outcome. Use the
                        // provider's generation correlation only to decide
                        // whether this separate session exit belongs to that
                        // completion or is a later idle-provider failure.
                        state.lifecycle = "provider_exited".to_owned();
                        state.push_terminal_event(NormalizedProviderEvent {
                            // A completed turn remains authoritative, while the
                            // reusable provider session independently becomes
                            // unavailable. Avoid emitting session.failed for
                            // already successful work, but never leave the
                            // durable lifecycle open after a nonzero exit.
                            event_type: if completion_reconciles_exit {
                                "session.reconciled"
                            } else {
                                "session.failed"
                            }
                            .to_owned(),
                            priority: EventPriority::P0,
                            payload: json!({
                                "provider": "codex",
                                "code": "provider_exited",
                                "exitCode": exit_code,
                                "expected": success,
                                "previousTurnCompleted": completed_turn_authoritative,
                                "completedByExitedProcess": completed_turn_observed_by_process,
                                "processGeneration": process_generation,
                                "completedTurnProcessGeneration": completed_turn_process_generation,
                                "activeProviderTurnId": Value::Null,
                            }),
                        })?;
                    }
                    self.save_state()?;
                    break;
                }
            }
        }
        // Check the durable deadline only after a complete provider poll. A
        // terminal that arrived after interruption acceptance but before this
        // observation remains authoritative even when several fast controller
        // polls have already exhausted the interruption-attempt budget.
        self.settle_receipt_limit_interrupt_if_deadline_elapsed()
    }
}

impl CommandExecutor for CodexCommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        self.restore()?;
        match command.command_type.as_str() {
            "run.prepare" => self.prepare(&command.payload),
            "run.attach" => {
                if self.state.is_none() && command.payload.get("provider").is_some() {
                    self.prepare(&command.payload)?;
                }
                self.verify_attached_tools(&command.payload)?;
                let mut execution = self.open_session()?;
                execution.events.push((
                    "run.attached".to_owned(),
                    EventPriority::P0,
                    json!({"provider": "codex"}),
                ));
                Ok(execution)
            }
            "session.open" => self.open_session(),
            "turn.start" => self.start_turn(&command.payload),
            "turn.steer" => self.steer_turn(&command.payload),
            "turn.interrupt" | "turn.stop" | "run.cancel" => {
                self.interrupt_turn(&command.command_type)
            }
            "request.resolve" => self.resolve_request(&command.payload),
            "semantic_tool.result" => self.deliver_semantic_result(&command.payload),
            "session.snapshot" => self.snapshot(),
            "session.close" | "session.destroy" => self.close_session(),
            "runner.drain" | "runner.suspend" | "runner.shutdown" => {
                Ok(CommandExecution::result(json!({"status": "completed"})))
            }
            _ => Ok(CommandExecution::result(json!({
                "status": "rejected",
                "code": "provider_command_unavailable",
                "message": "the Codex provider does not implement this command in the current layer",
            }))),
        }
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.poll_provider()?;
        Ok(self
            .state
            .as_ref()
            .into_iter()
            .flat_map(|state| state.pending_events.iter())
            .cloned()
            .collect())
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        if count == 0 {
            return Ok(());
        }
        let mut next_state = self
            .state
            .clone()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider state is unavailable"))?;
        if count > next_state.pending_events.len() {
            return Err(DurableRunnerError::invalid(
                "provider event acknowledgement exceeded the pending prefix",
            ));
        }
        next_state.pending_events.drain(..count);
        next_state.refill_pending_events();
        self.persist_state(&next_state)?;
        self.state = Some(next_state);
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        if let Some(provider) = self.provider.as_mut() {
            provider.shutdown().map_err(|error| {
                DurableRunnerError::invalid(format!("failed to stop Codex provider: {error}"))
            })?;
        }
        self.provider = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_inconsistent_provider_state() {
        let state = CodexProviderState {
            schema: PROVIDER_STATE_SCHEMA.to_owned(),
            lifecycle: "turn_active".to_owned(),
            config: CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: Vec::new(),
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            completion_contract: None,
            tool_bridge: ProviderToolBridge::default(),
            thread_id: Some("thread-1".to_owned()),
            provider_session_id: None,
            active_provider_turn_id: None,
            ambiguous_turn_start_pending: false,
            completed_turn_authoritative: false,
            provider_process_generation: 0,
            completed_turn_process_generation: None,
            completed_provider_turn_id: None,
            settled_provider_turn_ids: std::collections::BTreeSet::new(),
            settled_provider_turn_filter: DurableReplayFilter::default(),
            receipt_limit_diagnostic_emitted: false,
            receipt_limit_interrupt_pending: false,
            receipt_limit_interrupt_accepted: false,
            receipt_limit_interrupt_attempts: 0,
            receipt_limit_interrupt_deadline_unix_ms: None,
            last_agent_message: None,
            pending_events: VecDeque::new(),
            queued_events: VecDeque::new(),
            next_provider_event_seq: initial_provider_event_seq(),
        };
        assert!(state.validate().is_err());
    }

    #[test]
    fn recovered_active_turn_revokes_prior_completion_authority() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            ProviderToolBridge::default(),
        );
        state.thread_id = Some("thread-1".to_owned());
        state.lifecycle = "session_open".to_owned();
        state.completed_turn_authoritative = true;
        state.provider_process_generation = 1;
        state.completed_turn_process_generation = Some(1);
        state.completed_provider_turn_id = Some("turn-1".to_owned());
        state.last_agent_message = Some("old turn output".to_owned());

        state.reconcile_active_provider_turn(Some("turn-2".to_owned()));

        assert_eq!(state.lifecycle, "turn_active");
        assert_eq!(state.active_provider_turn_id.as_deref(), Some("turn-2"));
        assert!(!state.completed_turn_authoritative);
        assert!(state.completed_turn_process_generation.is_none());
        assert!(state.completed_provider_turn_id.is_none());
        assert!(state.last_agent_message.is_none());
        assert!(state.validate().is_ok());
    }

    #[test]
    fn emits_a_structured_result_before_the_terminal_event() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            Some(CompletionContractBinding {
                revision: "1".to_owned(),
                criterion_ids: vec!["objective".to_owned()],
            }),
            ProviderToolBridge::default(),
        );
        state.last_agent_message = Some("Finished the requested work.".to_owned());
        let events = terminal_events(&state, "turn.completed");
        assert_eq!(events[0].event_type, "run.result.proposed");
        assert_eq!(events[0].payload["summary"], "Finished the requested work.");
        assert_eq!(events[1].event_type, "run.terminal");
        assert_eq!(events[1].payload["runTerminalState"], "succeeded");
    }

    #[test]
    fn semantic_input_digest_covers_the_transmitted_redacted_value() {
        let identity = ProviderEventIdentity {
            runner_instance_id: "runner-1".to_owned(),
            run_id: "run-1".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            item_id: "item-1".to_owned(),
        };
        let call = PendingToolCall {
            call_id: "call-1".to_owned(),
            operation_id: "get_task_context".to_owned(),
            input: json!({"password": "do-not-persist", "safe": true}),
        };
        let event = semantic_input_event(&identity, &call);
        let transmitted = &event.payload["semantic_tool"]["input"];
        assert_eq!(transmitted["password"], "[REDACTED]");
        assert_eq!(
            event.payload["semantic_tool"]["content"]["digest"],
            semantic_value_digest(transmitted)
        );
    }

    #[test]
    fn receipt_limit_diagnostic_is_durable_and_turn_idempotent() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            ProviderToolBridge::default(),
        );
        state.thread_id = Some("thread-1".to_owned());
        state.active_provider_turn_id = Some("turn-1".to_owned());
        state.lifecycle = "turn_active".to_owned();

        assert!(state
            .begin_receipt_limit_stop("call-first".to_owned(), "tool.first".to_owned(), 10_000)
            .unwrap());
        state.mark_receipt_limit_interrupt_accepted(50_000);
        assert!(state
            .begin_receipt_limit_stop("call-second".to_owned(), "tool.second".to_owned(), 20_000)
            .unwrap());
        assert_eq!(state.pending_events.len(), 1);
        assert_eq!(state.pending_events[0].payload["callId"], "call-first");
        assert_eq!(state.receipt_limit_interrupt_deadline_unix_ms, Some(50_000));

        let mut recovered: CodexProviderState =
            serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
        recovered.validate().unwrap();
        assert!(recovered.receipt_limit_interrupt_accepted);
        assert_eq!(
            recovered.receipt_limit_interrupt_deadline_unix_ms,
            Some(50_000)
        );
        assert!(recovered
            .begin_receipt_limit_stop(
                "call-after-restart".to_owned(),
                "tool.third".to_owned(),
                30_000,
            )
            .unwrap());
        assert_eq!(recovered.pending_events.len(), 1);
        // Only a terminal notification clears the retry marker. Accepting an
        // interrupt request does not prove that the provider stopped.
        assert!(recovered
            .begin_receipt_limit_stop(
                "call-after-success".to_owned(),
                "tool.fourth".to_owned(),
                40_000,
            )
            .unwrap());
        assert_eq!(recovered.pending_events.len(), 1);
    }

    #[test]
    fn settled_receipt_limit_interrupt_cannot_be_marked_accepted() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            ProviderToolBridge::default(),
        );
        state.thread_id = Some("thread-1".to_owned());
        state.active_provider_turn_id = Some("turn-1".to_owned());
        state.lifecycle = "turn_active".to_owned();
        state
            .begin_receipt_limit_stop("call-1".to_owned(), "tool.one".to_owned(), 10_000)
            .unwrap();
        state.record_receipt_limit_interrupt_attempt().unwrap();

        // Recovery observed that the turn ended before the interrupt RPC was
        // issued and cleared the receipt-limit interruption state.
        state.settle_active_provider_turn_identity().unwrap();
        state.active_provider_turn_id = None;
        state.lifecycle = "session_open".to_owned();
        state.receipt_limit_diagnostic_emitted = false;
        state.receipt_limit_interrupt_pending = false;
        state.receipt_limit_interrupt_accepted = false;
        state.receipt_limit_interrupt_attempts = 0;
        state.receipt_limit_interrupt_deadline_unix_ms = None;

        state.mark_receipt_limit_interrupt_accepted(50_000);

        assert!(!state.receipt_limit_interrupt_accepted);
        assert!(state.receipt_limit_interrupt_deadline_unix_ms.is_none());
        state.validate().unwrap();
    }

    #[test]
    fn regular_backlog_preserves_receipt_limit_and_terminal_settlement_capacity() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            ProviderToolBridge::default(),
        );
        let identity = ProviderEventIdentity {
            runner_instance_id: "runner-1".to_owned(),
            run_id: "run-1".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            item_id: "item-1".to_owned(),
        };
        let ordinary_event = || NormalizedProviderEvent {
            event_type: "harness.diagnostic".to_owned(),
            priority: EventPriority::P1,
            payload: json!({"code": "ordinary_backlog"}),
        };
        for _ in 0..(MAX_EVENTS_PER_POLL + MAX_REGULAR_QUEUED_PROVIDER_EVENTS) {
            state.push_event(ordinary_event()).unwrap();
        }
        assert_eq!(state.pending_events.len(), MAX_EVENTS_PER_POLL);
        assert_eq!(
            state.queued_events.len(),
            MAX_REGULAR_QUEUED_PROVIDER_EVENTS
        );
        assert!(state.push_event(ordinary_event()).is_err());

        for _ in 0..MAX_EVENTS_PER_POLL {
            state
                .push_receipt_limit_cleanup_event(ordinary_event())
                .unwrap();
        }
        let cleanup_boundary = state.queued_events.len();
        state
            .push_receipt_limit_cleanup_event(ordinary_event())
            .expect("cleanup overflow is dropped while preserving terminal capacity");
        assert_eq!(state.queued_events.len(), cleanup_boundary);

        for index in 0..MAX_PENDING_CALLS {
            state
                .push_terminal_event(semantic_result_event(
                    &identity,
                    &ToolResult {
                        call_id: format!("call-{index}"),
                        operation_id: "get_task_context".to_owned(),
                        result: json!({"error": {"code": "provider_turn_terminated"}}),
                        is_error: true,
                    },
                ))
                .unwrap();
        }
        for event_type in [
            "harness.diagnostic",
            "turn.completed",
            "run.result.proposed",
            "run.terminal",
        ] {
            state
                .push_terminal_event(NormalizedProviderEvent {
                    event_type: event_type.to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({"terminal": true}),
                })
                .unwrap();
        }

        assert_eq!(state.pending_events.len(), MAX_EVENTS_PER_POLL);
        assert_eq!(state.queued_events.len(), MAX_QUEUED_PROVIDER_EVENTS);
        state.validate().unwrap();
        assert!(state.push_terminal_event(ordinary_event()).is_err());
        assert!(serde_json::to_vec(&state).unwrap().len() as u64 <= MAX_PROVIDER_STATE_BYTES);
    }

    #[test]
    fn completed_replays_are_read_only_at_the_regular_event_boundary() {
        let operation = crate::provider_bridge::AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation],
            })
            .unwrap();
        bridge
            .begin_call(
                "call-replayed".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .unwrap();
        let replayed_result = ToolResult {
            call_id: "call-replayed".to_owned(),
            operation_id: "get_task_context".to_owned(),
            result: json!({"ok": true}),
            is_error: false,
        };
        bridge.apply_result(replayed_result.clone()).unwrap();

        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            bridge,
        );
        let identity = ProviderEventIdentity {
            runner_instance_id: "runner-1".to_owned(),
            run_id: "run-1".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            item_id: "item-1".to_owned(),
        };

        // Keep the pending window occupied, then model the input and result
        // receipts retained by the maximum 4,096 completed calls. Only three
        // regular queued-event slots remain at this boundary.
        for index in 0..MAX_EVENTS_PER_POLL {
            state
                .push_event(NormalizedProviderEvent {
                    event_type: "provider.notice.recorded".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"index": index}),
                })
                .unwrap();
        }
        for index in 0..MAX_PENDING_CALLS {
            let call = PendingToolCall {
                call_id: format!("call-{index}"),
                operation_id: "get_task_context".to_owned(),
                input: json!({}),
            };
            state
                .push_event(semantic_input_event(&identity, &call))
                .unwrap();
            state
                .push_event(semantic_result_event(
                    &identity,
                    &ToolResult {
                        call_id: call.call_id,
                        operation_id: call.operation_id,
                        result: json!({"ok": true}),
                        is_error: false,
                    },
                ))
                .unwrap();
        }
        assert_eq!(
            MAX_REGULAR_QUEUED_PROVIDER_EVENTS - state.queued_events.len(),
            3
        );
        let pending_len = state.pending_events.len();
        let queued_len = state.queued_events.len();
        let next_sequence = state.next_provider_event_seq;

        for _ in 0..4 {
            assert_eq!(
                state
                    .admit_tool_call("call-replayed", "get_task_context", &json!({}))
                    .unwrap(),
                ToolCallAdmission::CompletedReplay(replayed_result.clone())
            );
        }
        assert_eq!(state.pending_events.len(), pending_len);
        assert_eq!(state.queued_events.len(), queued_len);
        assert_eq!(state.next_provider_event_seq, next_sequence);
        state.validate().unwrap();
    }

    #[test]
    fn pending_replays_are_read_only_at_the_regular_event_boundary() {
        let operation = crate::provider_bridge::AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation],
            })
            .unwrap();
        bridge
            .begin_call(
                "call-pending".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .unwrap();

        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            bridge,
        );
        for index in 0..(MAX_EVENTS_PER_POLL + MAX_REGULAR_QUEUED_PROVIDER_EVENTS) {
            state
                .push_event(NormalizedProviderEvent {
                    event_type: "provider.notice.recorded".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"index": index}),
                })
                .unwrap();
        }
        assert_eq!(state.pending_events.len(), MAX_EVENTS_PER_POLL);
        assert_eq!(
            state.queued_events.len(),
            MAX_REGULAR_QUEUED_PROVIDER_EVENTS
        );
        let next_sequence = state.next_provider_event_seq;

        for _ in 0..4 {
            assert_eq!(
                state
                    .admit_tool_call("call-pending", "get_task_context", &json!({}))
                    .unwrap(),
                ToolCallAdmission::PendingReplay
            );
        }
        assert_eq!(state.pending_events.len(), MAX_EVENTS_PER_POLL);
        assert_eq!(
            state.queued_events.len(),
            MAX_REGULAR_QUEUED_PROVIDER_EVENTS
        );
        assert_eq!(state.next_provider_event_seq, next_sequence);
        state.validate().unwrap();
    }

    #[test]
    fn exact_regular_backlog_capacity_rejects_turn_admission() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            ProviderToolBridge::default(),
        );
        state.lifecycle = "prepared".to_owned();
        for _ in 0..(MAX_EVENTS_PER_POLL + MAX_REGULAR_QUEUED_PROVIDER_EVENTS) {
            state
                .push_event(NormalizedProviderEvent {
                    event_type: "harness.diagnostic".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"code": "admission_boundary"}),
                })
                .unwrap();
        }
        assert_eq!(
            state.queued_events.len(),
            MAX_REGULAR_QUEUED_PROVIDER_EVENTS,
        );
        let mut executor = CodexCommandExecutor::new(PathBuf::from("unused-test-state"));
        executor.state = Some(state);
        executor.restore_checked = true;

        let error = executor
            .start_turn(&json!({"text": "must not reach the provider"}))
            .expect_err("the exact regular backlog limit must reject admission");
        assert!(error
            .to_string()
            .contains("until terminal events are acknowledged"));
        assert!(executor.provider.is_none());
    }

    #[test]
    fn transient_receipt_limit_clears_before_a_later_turn() {
        let operation = crate::provider_bridge::AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation],
            })
            .unwrap();
        let mut encoded = serde_json::to_value(&bridge).unwrap();
        encoded["durableRunReceiptLimitReached"] = Value::Bool(true);
        let mut bridge: ProviderToolBridge = serde_json::from_value(encoded).unwrap();
        bridge.attach_existing_run().unwrap();

        assert!(bridge.durable_run_receipt_limit_reached());
        bridge.prepare_turn().unwrap();
        assert!(!bridge.durable_run_receipt_limit_reached());
    }

    #[test]
    fn restore_reattaches_the_durable_tool_result_byte_counter() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-provider-tool-byte-restore-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let operation = crate::provider_bridge::AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation],
            })
            .unwrap();
        bridge
            .begin_call(
                "call-1".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .unwrap();
        bridge
            .apply_result(ToolResult {
                call_id: "call-1".to_owned(),
                operation_id: "get_task_context".to_owned(),
                result: json!({"ok": true}),
                is_error: false,
            })
            .unwrap();
        bridge.settle_turn("provider_turn_terminated").unwrap();
        assert!(bridge.retained_result_bytes_for_test() > 0);

        let state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            bridge,
        );
        let writer = CodexCommandExecutor::new(&directory);
        writer.persist_state(&state).unwrap();

        let mut recovered = CodexCommandExecutor::new(&directory);
        recovered.restore().unwrap();
        assert!(
            recovered
                .state
                .as_ref()
                .unwrap()
                .tool_bridge
                .retained_result_bytes_for_test()
                > 0
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn durable_provider_turn_ledger_backfills_legacy_completion_authority() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            ProviderToolBridge::default(),
        );
        state.completed_turn_authoritative = true;
        state.completed_turn_process_generation = Some(1);
        state.completed_provider_turn_id = Some("provider-turn-legacy".to_owned());
        state.provider_process_generation = 1;

        let (recovered, recovered_filter) = state.recovered_settled_provider_turn_ids().unwrap();

        assert!(settled_provider_turn_contains(
            &recovered,
            &recovered_filter,
            "provider-turn-legacy"
        ));
    }

    #[test]
    fn durable_provider_turn_ledger_never_evicts_within_an_epoch() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            ProviderToolBridge::default(),
        );
        state.thread_id = Some("thread-1".to_owned());
        state.lifecycle = "turn_active".to_owned();
        for index in 0..MAX_SETTLED_PROVIDER_TURN_IDS - 1 {
            state
                .settled_provider_turn_ids
                .insert(format!("provider-turn-{index:04}"));
        }
        state.active_provider_turn_id = Some("provider-turn-final".to_owned());

        state.settle_active_provider_turn_identity().unwrap();
        state.active_provider_turn_id = None;
        state.lifecycle = "session_open".to_owned();

        assert_eq!(
            state.settled_provider_turn_ids.len(),
            MAX_SETTLED_PROVIDER_TURN_IDS
        );
        assert!(state.settled_provider_turn_filter.is_empty());
        assert!(state
            .settled_provider_turn_ids
            .contains("provider-turn-final"));
        assert!(state
            .settled_provider_turn_ids
            .contains("provider-turn-0000"));

        state.lifecycle = "turn_active".to_owned();
        state.active_provider_turn_id = Some("provider-turn-overflow".to_owned());
        assert!(state.settle_active_provider_turn_identity().is_err());
        assert!(!state
            .settled_provider_turn_ids
            .contains("provider-turn-overflow"));
        state.active_provider_turn_id = None;
        state.lifecycle = "session_open".to_owned();
        state.validate().unwrap();
        let recovered: CodexProviderState =
            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        assert_eq!(
            recovered.settled_provider_turn_ids,
            state.settled_provider_turn_ids
        );
        assert_eq!(
            recovered.settled_provider_turn_filter,
            state.settled_provider_turn_filter
        );
        recovered.validate().unwrap();
    }

    #[test]
    fn receipt_limit_deadline_settlement_preserves_unacknowledged_events() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-provider-receipt-deadline-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            None,
            ProviderToolBridge::default(),
        );
        state.thread_id = Some("thread-1".to_owned());
        state.active_provider_turn_id = Some("turn-1".to_owned());
        state.lifecycle = "turn_active".to_owned();
        state.receipt_limit_diagnostic_emitted = true;
        state.receipt_limit_interrupt_pending = true;
        state.receipt_limit_interrupt_attempts = MAX_RECEIPT_LIMIT_INTERRUPT_ATTEMPTS;
        state.receipt_limit_interrupt_deadline_unix_ms = Some(1);
        state
            .push_event(NormalizedProviderEvent {
                event_type: "provider.notice.recorded".to_owned(),
                priority: EventPriority::P1,
                payload: json!({"message": "awaiting acknowledgement"}),
            })
            .unwrap();
        let mut executor = CodexCommandExecutor::new(&directory);
        executor.state = Some(state);
        executor.event_identity = Some(ProviderEventIdentity {
            runner_instance_id: "runner-1".to_owned(),
            run_id: "run-1".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            item_id: "item-1".to_owned(),
        });
        executor.restore_checked = true;

        // Exercise receipt-limit recovery directly. `poll_provider` also
        // restores a missing provider by design, while this unit test
        // intentionally injects state without constructing a provider.
        executor.retry_receipt_limit_interrupt().unwrap();
        executor
            .settle_receipt_limit_interrupt_if_deadline_elapsed()
            .unwrap();

        let state = executor.state.as_ref().unwrap();
        assert_eq!(state.lifecycle, "provider_exited");
        assert!(state.active_provider_turn_id.is_none());
        assert!(!state.receipt_limit_interrupt_pending);
        assert!(state.pending_events.iter().any(|event| {
            event.event_type == "provider.notice.recorded"
                && event.payload == json!({"message": "awaiting acknowledgement"})
        }));
        assert!(state
            .pending_events
            .iter()
            .any(|event| event.event_type == "turn.failed"));
        fs::remove_dir_all(directory).unwrap();
    }
}
