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
use sha2::{Digest, Sha256};

use crate::codex_provider::{
    CodexProvider, CodexProviderConfig, CodexProviderEvent, ProviderStartupObservation,
    ProviderStartupStage, RejectedAcceptedTurn, MAX_SETTLED_PROVIDER_TURN_IDS,
};
use crate::durable::{
    create_private_temporary_file, current_unix_ms, open_private_regular_file,
    sanitize_semantic_tool_input, sanitize_value, verify_private_directory, Command,
    CommandExecution, CommandExecutor, DurableRunnerConfig, DurableRunnerError, EventPriority,
    OpenCodeLaunchProfile, PolledEvent, TerminalDeliveryReconciliation,
};
use crate::provider_bridge::{
    authorized_tool_catalog_digest, semantic_value_digest, AuthorizedToolSet, DurableReplayFilter,
    PendingToolCall, ProviderBridgeError, ProviderToolBridge, ToolResult, MAX_PENDING_CALLS,
    TOOL_SET_SCHEMA,
};
use crate::provider_events::{
    normalize_codex_notification, normalized_codex_terminal_event_type, NormalizedProviderEvent,
};
use crate::stable_identity::{is_stable_id, DURABLE_STABLE_ID_CHARS, SHORT_STABLE_ID_CHARS};

const PROVIDER_STATE_SCHEMA: &str = "paperclip.runner.codex-provider-state.v1";
pub const CODEX_PROVIDER_STATE_FILE: &str = "codex-provider-state.json";
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
const GENERIC_INVALID_TOOL_CALL_MESSAGE: &str = "Paperclip rejected this semantic tool call";

fn invalid_tool_call_result(
    call_id: String,
    operation_id: String,
    error: &ProviderBridgeError,
) -> ToolResult {
    ToolResult {
        call_id,
        operation_id,
        result: json!({
            "error": {
                "code": "invalid_tool_call",
                "message": error
                    .safe_provider_message()
                    .unwrap_or(GENERIC_INVALID_TOOL_CALL_MESSAGE),
                "retryable": false,
            },
        }),
        is_error: true,
    }
}

fn receipt_limit_deadline_after(timeout_ms: u64) -> Result<u64, DurableRunnerError> {
    current_unix_ms()?.checked_add(timeout_ms).ok_or_else(|| {
        DurableRunnerError::invalid("Codex receipt-limit interruption deadline overflowed")
    })
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderEventIdentity {
    runner_instance_id: String,
    run_id: String,
    normalized_session_id: String,
    turn_id: String,
    item_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderStartupCommand {
    command_id: String,
    controller_seq: u64,
    command_type: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ProviderStartupTrigger {
    Restore,
    Ensure,
    Rollover,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ProviderStartupPhase {
    Intent,
    Spawned,
    InitializationFailed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderStartupAttempt {
    schema: String,
    launch_id: String,
    phase: ProviderStartupPhase,
    trigger: ProviderStartupTrigger,
    attempted_process_generation: u64,
    origin: Option<ProviderEventIdentity>,
    command: Option<ProviderStartupCommand>,
    configuration_fingerprint: String,
    requested_thread_id: Option<String>,
    authenticated_thread_id: Option<String>,
    process_id: Option<u32>,
    process_group_id: Option<u32>,
    failed_stage: Option<ProviderStartupStage>,
    direct_child_exit_observed: bool,
    exit_code: Option<i32>,
    signal: Option<i32>,
    process_tree_retired: bool,
}

impl ProviderStartupAttempt {
    fn validate(&self) -> Result<(), DurableRunnerError> {
        let identifier = |value: &str, limit: usize| {
            !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
        };
        let command_valid = self.command.as_ref().is_none_or(|command| {
            Command {
                schema: "paperclip.prp.command.v1".to_owned(),
                command_id: command.command_id.clone(),
                controller_seq: command.controller_seq,
                command_type: command.command_type.clone(),
                issued_at: "startup-origin".to_owned(),
                deadline_at: None,
                precondition: None,
                payload: json!({}),
            }
            .validate()
            .is_ok()
        });
        let has_process =
            self.process_id.is_some_and(|pid| pid > 0) && self.process_id == self.process_group_id;
        let no_process = self.process_id.is_none() && self.process_group_id.is_none();
        let no_exit =
            !self.direct_child_exit_observed && self.exit_code.is_none() && self.signal.is_none();
        let exit_valid = if self.direct_child_exit_observed {
            has_process
                && (self.exit_code.is_some() ^ self.signal.is_some())
                && self.signal.is_none_or(|signal| signal > 0)
        } else {
            no_exit
        };
        let phase_valid = match self.phase {
            ProviderStartupPhase::Intent => no_process && no_exit && self.failed_stage.is_none(),
            ProviderStartupPhase::Spawned => has_process && no_exit && self.failed_stage.is_none(),
            ProviderStartupPhase::InitializationFailed => match self.failed_stage {
                Some(ProviderStartupStage::Spawn) => no_process && no_exit,
                Some(_) => has_process && exit_valid,
                None => false,
            },
        };
        if self.schema != "paperclip.provider_startup.v1"
            || uuid::Uuid::parse_str(&self.launch_id).is_err()
            || self.attempted_process_generation == 0
            || self.authenticated_thread_id.is_some()
            || self.process_tree_retired
            || !phase_valid
            || !command_valid
            || !self
                .configuration_fingerprint
                .strip_prefix("sha256:")
                .is_some_and(|digest| {
                    digest.len() == 64
                        && digest
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                })
            || self
                .requested_thread_id
                .as_ref()
                .is_some_and(|id| !identifier(id, 240))
            || self.origin.as_ref().is_some_and(|origin| {
                !identifier(&origin.runner_instance_id, 512)
                    || !is_stable_id(&origin.run_id, SHORT_STABLE_ID_CHARS)
                    || !is_stable_id(&origin.normalized_session_id, SHORT_STABLE_ID_CHARS)
                    || !is_stable_id(&origin.turn_id, DURABLE_STABLE_ID_CHARS)
                    || !is_stable_id(&origin.item_id, DURABLE_STABLE_ID_CHARS)
            })
        {
            return Err(DurableRunnerError::invalid(
                "invalid provider startup ownership fence",
            ));
        }
        Ok(())
    }
}

fn is_startup_audit_event(event: &PolledEvent) -> bool {
    event.event_type == "harness.diagnostic"
        && event.payload.get("code") == Some(&json!("provider_startup_ownership"))
        && event
            .payload
            .as_object()
            .is_some_and(|payload| payload.len() == 2)
        && event.payload.get("startup").is_some_and(|value| {
            serde_json::from_value::<ProviderStartupAttempt>(value.clone()).is_ok_and(|attempt| {
                attempt.validate().is_ok()
                    && attempt.phase != ProviderStartupPhase::InitializationFailed
            })
        })
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
) -> Result<NormalizedProviderEvent, DurableRunnerError> {
    let safe_input = sanitize_semantic_tool_input(&call.operation_id, &call.input)?;
    Ok(NormalizedProviderEvent {
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
    })
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

fn validate_opencode_run_result(
    state: &CodexProviderState,
    params: &Value,
) -> Result<(Value, String, String), DurableRunnerError> {
    if state.config.provider != "opencode" {
        return Err(DurableRunnerError::invalid(
            "paperclip/runResult is reserved for the verified OpenCode provider",
        ));
    }
    if state.lifecycle != "turn_active" || state.active_provider_turn_id.is_none() {
        return Err(DurableRunnerError::invalid(
            "OpenCode emitted paperclip/runResult without an active provider turn",
        ));
    }
    if params.get("threadId").and_then(Value::as_str) != state.thread_id.as_deref()
        || params.get("turnId").and_then(Value::as_str) != state.active_provider_turn_id.as_deref()
    {
        return Err(DurableRunnerError::invalid(
            "OpenCode paperclip/runResult is not bound to the active provider turn",
        ));
    }
    let result = params.get("result").cloned().ok_or_else(|| {
        DurableRunnerError::invalid("OpenCode paperclip/runResult omitted its result")
    })?;
    let (fingerprint, disposition) = validate_run_result(state, &result)?;
    Ok((result, fingerprint, disposition))
}

fn validate_run_result(
    state: &CodexProviderState,
    result: &Value,
) -> Result<(String, String), DurableRunnerError> {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/result.schema.json"
    ))
    .map_err(|_| DurableRunnerError::invalid("embedded Paperclip result schema is invalid"))?;
    let validator = jsonschema::validator_for(&schema).map_err(|_| {
        DurableRunnerError::invalid("embedded Paperclip result schema cannot compile")
    })?;
    if !validator.is_valid(result) {
        return Err(DurableRunnerError::invalid(
            "provider semantic result failed the Paperclip result schema",
        ));
    }
    let contract = state.completion_contract.as_ref().ok_or_else(|| {
        DurableRunnerError::invalid("OpenCode paperclip/runResult has no bound completion contract")
    })?;
    let claim = result.get("completionClaim").ok_or_else(|| {
        DurableRunnerError::invalid("OpenCode paperclip/runResult omitted its completion claim")
    })?;
    if claim.get("contractRevision").and_then(Value::as_str) != Some(contract.revision.as_str()) {
        return Err(DurableRunnerError::invalid(
            "OpenCode paperclip/runResult changed its completion contract revision",
        ));
    }
    let criteria = claim
        .get("criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DurableRunnerError::invalid(
                "OpenCode paperclip/runResult omitted its completion criteria",
            )
        })?;
    let mut reported_criterion_ids = HashSet::new();
    for criterion in criteria {
        let criterion_id = criterion
            .get("criterionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "OpenCode paperclip/runResult has an invalid completion criterion",
                )
            })?;
        if !reported_criterion_ids.insert(criterion_id) {
            return Err(DurableRunnerError::invalid(
                "OpenCode paperclip/runResult repeated a completion criterion",
            ));
        }
    }
    if reported_criterion_ids.len() != contract.criterion_ids.len()
        || !contract
            .criterion_ids
            .iter()
            .all(|criterion_id| reported_criterion_ids.contains(criterion_id.as_str()))
    {
        return Err(DurableRunnerError::invalid(
            "OpenCode paperclip/runResult changed its bound completion criteria",
        ));
    }
    let disposition = result
        .get("reportedWorkDisposition")
        .and_then(Value::as_str)
        .expect("the validated result schema requires a disposition")
        .to_owned();
    let fingerprint = semantic_value_digest(result);
    Ok((fingerprint, disposition))
}

fn admit_terminal_tool_authority(
    state: &mut CodexProviderState,
    operation_id: &str,
    input: &Value,
    result_is_error: bool,
) -> Result<(), DurableRunnerError> {
    if result_is_error || !matches!(operation_id, "paperclip_finish" | "paperclip_block") {
        return Ok(());
    }
    // The correlated TypeScript semantic-tool handler validates the provider
    // input against the operation schema, normalizes its defaults, and commits
    // the accepted result before returning success. The bridge deliberately
    // retains the original provider input, so validating that raw value against
    // the stricter canonical result schema here would reject valid omitted
    // defaults. Record the authenticated tool authority without trying to
    // repeat the controller's normalization.
    let reported_disposition = input
        .get("reportedWorkDisposition")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DurableRunnerError::invalid(format!("{operation_id} omitted its work disposition"))
        })?;
    let disposition = match reported_disposition {
        "complete" | "completed" => "done",
        other => other,
    }
    .to_owned();
    let fingerprint = semantic_value_digest(input);
    let disposition_matches_operation = match operation_id {
        "paperclip_finish" => {
            matches!(disposition.as_str(), "done" | "needs_review")
                || (disposition == "yielded"
                    && input
                        .get("continuation")
                        .and_then(|continuation| continuation.get("kind"))
                        .and_then(Value::as_str)
                        == Some("response_wake"))
        }
        "paperclip_block" => disposition == "blocked",
        _ => false,
    };
    if !disposition_matches_operation {
        return Err(DurableRunnerError::invalid(format!(
            "{operation_id} supplied an incompatible work disposition"
        )));
    }
    match (
        state.active_provider_result_fingerprint.as_deref(),
        state.active_provider_result_disposition.as_deref(),
    ) {
        (None, None) => {
            // The TypeScript driver commits this exact tool input while
            // servicing the correlated provider request. Retain only its
            // digest and disposition here so runnerd does not synthesize a
            // second, conflicting result when the provider turn terminates.
            state.active_provider_result_fingerprint = Some(fingerprint);
            state.active_provider_result_disposition = Some(disposition);
            Ok(())
        }
        (Some(existing_fingerprint), Some(existing_disposition))
            if existing_fingerprint == fingerprint && existing_disposition == disposition =>
        {
            Ok(())
        }
        _ => Err(DurableRunnerError::invalid(
            "provider emitted conflicting terminal semantic tool results for one turn",
        )),
    }
}

fn normalize_provider_notification(
    state: &mut CodexProviderState,
    method: &str,
    params: &Value,
) -> Result<Vec<NormalizedProviderEvent>, DurableRunnerError> {
    if method != "paperclip/runResult" {
        return Ok(normalize_codex_notification(method, params)
            .into_iter()
            .map(|event| relabel_provider_event(event, &state.config.provider))
            .collect());
    }
    let (result, fingerprint, disposition) = validate_opencode_run_result(state, params)?;
    match (
        state.active_provider_result_fingerprint.as_deref(),
        state.active_provider_result_disposition.as_deref(),
    ) {
        (None, None) => {
            state.active_provider_result_fingerprint = Some(fingerprint);
            state.active_provider_result_disposition = Some(disposition);
            Ok(vec![NormalizedProviderEvent {
                event_type: "run.result.proposed".to_owned(),
                priority: EventPriority::P0,
                payload: result,
            }])
        }
        (Some(existing_fingerprint), Some(existing_disposition))
            if existing_fingerprint == fingerprint && existing_disposition == disposition =>
        {
            Ok(Vec::new())
        }
        _ => Err(DurableRunnerError::invalid(
            "OpenCode emitted conflicting paperclip/runResult notifications for one turn",
        )),
    }
}

fn terminal_events(
    state: &CodexProviderState,
    event_type: &str,
    goal_status: Option<&str>,
) -> Vec<NormalizedProviderEvent> {
    if goal_status == Some("active") {
        return Vec::new();
    }
    let Some(contract) = state.completion_contract.as_ref() else {
        return Vec::new();
    };
    // Once the correlated semantic-tool result has been accepted, Paperclip's
    // bounded controller finalizer may interrupt the provider after the result
    // proposal. That provider terminal closes the exact turn; it does not
    // revoke the already-authoritative semantic outcome.
    let succeeded = goal_status == Some("complete")
        || (goal_status.is_none()
            && (event_type == "turn.completed"
                || state.active_provider_result_fingerprint.is_some()));
    let cancelled = matches!(event_type, "turn.cancelled" | "turn.interrupted");
    let disposition = match goal_status {
        Some("blocked") => "blocked",
        Some("paused" | "limited" | "usage_limited" | "budget_limited") => "yielded",
        Some("complete") => "done",
        _ => state
            .active_provider_result_disposition
            .as_deref()
            .unwrap_or(if succeeded { "done" } else { "needs_review" }),
    };
    let provider = state.config.provider.as_str();
    let provider_name = if provider == "opencode" {
        "OpenCode"
    } else {
        "Codex"
    };
    let summary = state.last_agent_message.clone().unwrap_or_else(|| {
        if succeeded {
            format!("{provider_name} completed the requested work.")
        } else if cancelled {
            format!("The {provider_name} run stopped before it completed.")
        } else {
            format!("The {provider_name} run failed before it completed.")
        }
    });
    let evidence_ref = format!("provider:{provider}:agent-message");
    let criteria = contract
        .criterion_ids
        .iter()
        .map(|criterion_id| {
            json!({
                "criterionId": criterion_id,
                "status": if succeeded { "satisfied" } else { "unknown" },
                "evidenceRefs": if succeeded { vec![evidence_ref.as_str()] } else { Vec::<&str>::new() },
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
                "description": if disposition == "yielded" {
                    "Resume the durable Codex goal when execution can continue.".to_owned()
                } else if disposition == "blocked" {
                    "Resolve the blocker before resuming the durable Codex goal.".to_owned()
                } else {
                    format!("Review the stopped {provider_name} run and continue the task.")
                },
                "blocksCompletion": true,
            })] },
        },
        "evidence": if succeeded { vec![json!({ "ref": evidence_ref })] } else { Vec::<Value>::new() },
        "verification": [],
        "attentionRequests": if succeeded { Vec::<Value>::new() } else { vec![json!({
            "kind": "review",
            "summary": format!("Review the stopped {provider_name} run before continuing."),
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
        "provider": provider,
        "turnTerminalState": turn_terminal_state,
        "runTerminalState": if succeeded { "succeeded" } else if cancelled || disposition == "yielded" { "cancelled" } else { "failed" },
        "reportedWorkDisposition": disposition,
    });
    let mut events = Vec::new();
    if state.active_provider_result_fingerprint.is_none() {
        events.push(NormalizedProviderEvent {
            event_type: "run.result.proposed".to_owned(),
            priority: EventPriority::P0,
            payload: result,
        });
    }
    events.push(NormalizedProviderEvent {
        event_type: "run.terminal".to_owned(),
        priority: EventPriority::P0,
        payload: terminal,
    });
    events
}

fn relabel_provider_event(
    mut event: NormalizedProviderEvent,
    provider: &str,
) -> NormalizedProviderEvent {
    if provider == "codex" {
        return event;
    }
    fn relabel(value: &mut Value, provider: &str) {
        match value {
            Value::Object(object) => {
                if object.get("provider").and_then(Value::as_str) == Some("codex") {
                    object.insert("provider".to_owned(), json!(provider));
                }
                for value in object.values_mut() {
                    relabel(value, provider);
                }
            }
            Value::Array(values) => {
                for value in values {
                    relabel(value, provider);
                }
            }
            _ => {}
        }
    }
    relabel(&mut event.payload, provider);
    event
}

fn default_goal_revision() -> u64 {
    0
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SessionGoalCapability {
    availability: String,
    actions: Vec<String>,
    autonomous_updates: bool,
    persistent_across_resume: bool,
    max_objective_chars: u64,
    token_budget_control: bool,
    usage_reporting: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

impl SessionGoalCapability {
    fn codex_available() -> Self {
        Self {
            availability: "available".to_owned(),
            actions: vec![
                "set".to_owned(),
                "pause".to_owned(),
                "resume".to_owned(),
                "clear".to_owned(),
            ],
            autonomous_updates: true,
            persistent_across_resume: true,
            max_objective_chars: 4_000,
            token_budget_control: true,
            usage_reporting: true,
            reason_code: None,
            reason: None,
        }
    }

    fn unavailable(availability: &str, reason_code: &str) -> Self {
        Self {
            availability: availability.to_owned(),
            actions: Vec::new(),
            autonomous_updates: false,
            persistent_across_resume: false,
            max_objective_chars: 4_000,
            token_budget_control: false,
            usage_reporting: false,
            reason_code: Some(reason_code.to_owned()),
            reason: Some(
                match availability {
                    "policy_disabled" => "Session goals are disabled by the Codex provider policy.",
                    _ => "This Codex app-server does not expose session goals.",
                }
                .to_owned(),
            ),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SessionGoalSnapshot {
    objective: String,
    status: String,
    token_budget: Option<u64>,
    tokens_used: u64,
    elapsed_seconds: u64,
    iterations: u64,
    #[serde(default)]
    last_reason: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    #[serde(default)]
    completed_at: Option<String>,
    working_now: bool,
}

fn normalize_goal_status(status: &str) -> Option<&'static str> {
    match status {
        "active" => Some("active"),
        "paused" => Some("paused"),
        "blocked" => Some("blocked"),
        "limited" => Some("limited"),
        "usageLimited" | "usage_limited" => Some("usage_limited"),
        "budgetLimited" | "budget_limited" => Some("budget_limited"),
        "complete" => Some("complete"),
        _ => None,
    }
}

fn codex_goal_status(status: &str) -> Option<&'static str> {
    match status {
        "active" => Some("active"),
        "paused" => Some("paused"),
        "blocked" => Some("blocked"),
        "usage_limited" => Some("usageLimited"),
        "budget_limited" => Some("budgetLimited"),
        "complete" => Some("complete"),
        _ => None,
    }
}

fn goal_timestamp(value: Option<&Value>) -> Option<String> {
    use aws_smithy_types::{date_time::Format, DateTime};
    let value = value?;
    if let Some(text) = value.as_str() {
        return DateTime::from_str(text, Format::DateTime)
            .ok()?
            .fmt(Format::DateTime)
            .ok();
    }
    let timestamp = value.as_i64().filter(|value| *value > 0)?;
    let date = if timestamp < 10_000_000_000 {
        DateTime::from_secs(timestamp)
    } else {
        DateTime::from_millis(timestamp)
    };
    date.fmt(Format::DateTime).ok()
}

fn normalize_codex_goal(value: &Value, working_now: bool) -> Option<SessionGoalSnapshot> {
    let goal = value.get("goal").unwrap_or(value);
    if goal.is_null() {
        return None;
    }
    let objective = goal.get("objective")?.as_str()?.trim();
    let status = normalize_goal_status(goal.get("status")?.as_str()?)?;
    if objective.is_empty() || objective.chars().count() > 4_000 {
        return None;
    }
    Some(SessionGoalSnapshot {
        objective: objective.to_owned(),
        status: status.to_owned(),
        token_budget: goal.get("tokenBudget").and_then(Value::as_u64),
        tokens_used: goal.get("tokensUsed").and_then(Value::as_u64).unwrap_or(0),
        elapsed_seconds: goal
            .get("timeUsedSeconds")
            .or_else(|| goal.get("elapsedSeconds"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        iterations: goal.get("iterations").and_then(Value::as_u64).unwrap_or(0),
        last_reason: goal
            .get("lastReason")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(1_000).collect()),
        created_at: goal_timestamp(goal.get("createdAt")),
        updated_at: goal_timestamp(goal.get("updatedAt")),
        completed_at: goal_timestamp(goal.get("completedAt").or_else(|| {
            (status == "complete")
                .then(|| goal.get("updatedAt"))
                .flatten()
        })),
        working_now,
    })
}

fn goal_event_payload(
    goal: Option<&SessionGoalSnapshot>,
    capability: Option<&SessionGoalCapability>,
    revision: u64,
) -> Value {
    json!({
        "schema": "paperclip.session_goal.snapshot.v1",
        "goal": goal,
        "sessionGoals": capability,
        "workingNow": goal.is_some_and(|goal| goal.working_now),
        "revision": revision,
    })
}

fn goal_control_event_payload(
    goal: Option<&SessionGoalSnapshot>,
    capability: Option<&SessionGoalCapability>,
    revision: u64,
    request_id: Option<&str>,
) -> Value {
    let mut payload = goal_event_payload(goal, capability, revision);
    if let Some(request_id) = request_id.filter(|value| !value.is_empty()) {
        payload["requestId"] = json!(request_id);
    }
    payload
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CodexProviderState {
    schema: String,
    lifecycle: String,
    config: CodexProviderConfig,
    #[serde(default)]
    opencode_launch_profile_digest: Option<String>,
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
    startup_attempt: Option<ProviderStartupAttempt>,
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
    descendant_thread_ids: std::collections::BTreeSet<String>,
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
    #[serde(default)]
    active_provider_result_fingerprint: Option<String>,
    #[serde(default)]
    active_provider_result_disposition: Option<String>,
    last_agent_message: Option<String>,
    #[serde(default)]
    goal_capability: Option<SessionGoalCapability>,
    #[serde(default)]
    goal: Option<SessionGoalSnapshot>,
    #[serde(default = "default_goal_revision")]
    goal_revision: u64,
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
            opencode_launch_profile_digest: None,
            completion_contract,
            tool_bridge,
            thread_id,
            provider_session_id: None,
            active_provider_turn_id: None,
            ambiguous_turn_start_pending: false,
            completed_turn_authoritative: false,
            provider_process_generation: 0,
            startup_attempt: None,
            completed_turn_process_generation: None,
            completed_provider_turn_id: None,
            settled_provider_turn_ids: std::collections::BTreeSet::new(),
            descendant_thread_ids: std::collections::BTreeSet::new(),
            settled_provider_turn_filter: DurableReplayFilter::default(),
            receipt_limit_diagnostic_emitted: false,
            receipt_limit_interrupt_pending: false,
            receipt_limit_interrupt_accepted: false,
            receipt_limit_interrupt_attempts: 0,
            receipt_limit_interrupt_deadline_unix_ms: None,
            active_provider_result_fingerprint: None,
            active_provider_result_disposition: None,
            last_agent_message: None,
            goal_capability: None,
            goal: None,
            goal_revision: default_goal_revision(),
            pending_events: VecDeque::new(),
            queued_events: VecDeque::new(),
            next_provider_event_seq: initial_provider_event_seq(),
        }
    }

    fn validate(&self) -> Result<(), DurableRunnerError> {
        if let Some(attempt) = &self.startup_attempt {
            attempt.validate()?;
        }
        self.config
            .validate()
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        self.tool_bridge.validate_recovered().map_err(|error| {
            DurableRunnerError::invalid(format!("Codex semantic tool state is invalid: {error}"))
        })?;
        let mut pending_event_ids = HashSet::new();
        if self.descendant_thread_ids.len() > crate::codex_provider::MAX_DESCENDANT_THREAD_IDS
            || self
                .descendant_thread_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 240)
            || self.schema != PROVIDER_STATE_SCHEMA
            || !matches!(
                self.lifecycle.as_str(),
                "prepared"
                    | "session_open"
                    | "turn_active"
                    | "provider_exited"
                    | "reconciliation_required"
                    | "closed"
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
            || self.goal.as_ref().is_some_and(|goal| {
                goal.objective.trim().is_empty()
                    || goal.objective.chars().count() > 4_000
                    || normalize_goal_status(&goal.status).is_none()
            })
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
            || self.active_provider_result_fingerprint.is_some()
                != self.active_provider_result_disposition.is_some()
            || self
                .active_provider_result_fingerprint
                .as_ref()
                .is_some_and(|fingerprint| {
                    fingerprint.len() != 71
                        || !fingerprint.starts_with("sha256:")
                        || !fingerprint[7..]
                            .chars()
                            .all(|character| character.is_ascii_hexdigit())
                })
            || self
                .active_provider_result_disposition
                .as_deref()
                .is_some_and(|disposition| {
                    !matches!(disposition, "done" | "blocked" | "needs_review" | "yielded")
                        || !matches!(self.config.provider.as_str(), "codex" | "opencode")
                })
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
                "provider": self.config.provider,
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
            self.active_provider_result_fingerprint = None;
            self.active_provider_result_disposition = None;
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
    restore_error: Option<DurableRunnerError>,
    opencode_launch_profile: Option<OpenCodeLaunchProfile>,
    startup_command: Option<ProviderStartupCommand>,
    startup_evidence_error: Option<DurableRunnerError>,
}

impl CodexCommandExecutor {
    pub fn new(state_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
            state: None,
            provider: None,
            event_identity: None,
            restore_checked: false,
            restore_error: None,
            opencode_launch_profile: None,
            startup_command: None,
            startup_evidence_error: None,
        }
    }

    pub fn with_runner_config(state_dir: impl Into<PathBuf>, config: &DurableRunnerConfig) -> Self {
        let mut executor = Self::new(state_dir);
        executor.event_identity = Some(ProviderEventIdentity::from_config(config));
        executor.opencode_launch_profile = config.opencode_launch_profile.clone();
        executor
    }

    fn bind_opencode_launch_profile(
        &self,
        config: &CodexProviderConfig,
    ) -> Result<Option<String>, DurableRunnerError> {
        if config.provider != "opencode" {
            return Ok(None);
        }
        let profile = self.opencode_launch_profile.as_ref().ok_or_else(|| {
            DurableRunnerError::invalid(
                "OpenCode runner startup omitted its qualified launch profile",
            )
        })?;
        let proxy_script = profile.proxy_script.path.to_string_lossy();
        if config.command != profile.command.path
            || config.args.as_slice() != [proxy_script.as_ref()]
        {
            return Err(DurableRunnerError::invalid(
                "OpenCode run.prepare launch does not match the runner-owned qualified profile",
            ));
        }
        let mut digest = Sha256::new();
        digest.update(b"paperclip.runner.opencode-launch-profile.v1\0");
        for artifact in [&profile.command, &profile.proxy_script, &profile.executable] {
            digest.update(artifact.path.to_string_lossy().as_bytes());
            digest.update(b"\0");
            digest.update(artifact.sha256.as_bytes());
            digest.update(b"\0");
        }
        Ok(Some(format!("sha256:{:x}", digest.finalize())))
    }

    fn state_path(&self) -> PathBuf {
        self.state_dir.join(CODEX_PROVIDER_STATE_FILE)
    }

    fn assert_startup_admitted(&self) -> Result<(), DurableRunnerError> {
        if let Some(error) = &self.startup_evidence_error {
            return Err(error.clone());
        }
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.startup_attempt.is_some())
        {
            return Err(DurableRunnerError::invalid(
                "provider startup ownership remains unadmitted",
            ));
        }
        Ok(())
    }

    fn save_startup_fact(&mut self) -> Result<(), DurableRunnerError> {
        let outcome = (|| {
            let state = self
                .state
                .as_mut()
                .ok_or_else(|| DurableRunnerError::invalid("provider startup state missing"))?;
            let attempt = state
                .startup_attempt
                .clone()
                .ok_or_else(|| DurableRunnerError::invalid("provider startup intent missing"))?;
            state.push_terminal_event(NormalizedProviderEvent {
                event_type: "harness.diagnostic".to_owned(),
                priority: EventPriority::P0,
                payload: json!({"code":"provider_startup_ownership", "startup": attempt}),
            })?;
            self.save_state()
        })();
        if let Err(error) = &outcome {
            self.startup_evidence_error = Some(error.clone());
        }
        outcome
    }

    fn begin_startup(
        &mut self,
        trigger: ProviderStartupTrigger,
        generation: u64,
    ) -> Result<(), DurableRunnerError> {
        self.assert_startup_admitted()?;
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("provider startup state missing"))?;
        let configuration = serde_json::to_vec(&state.config).map_err(|_| {
            DurableRunnerError::invalid("provider startup configuration serialization failed")
        })?;
        state.startup_attempt = Some(ProviderStartupAttempt {
            schema: "paperclip.provider_startup.v1".to_owned(),
            launch_id: uuid::Uuid::new_v4().to_string(),
            phase: ProviderStartupPhase::Intent,
            trigger,
            attempted_process_generation: generation,
            origin: self.event_identity.clone(),
            command: self.startup_command.clone(),
            configuration_fingerprint: format!("sha256:{:x}", Sha256::digest(configuration)),
            requested_thread_id: state.thread_id.clone(),
            authenticated_thread_id: None,
            process_id: None,
            process_group_id: None,
            failed_stage: None,
            direct_child_exit_observed: false,
            exit_code: None,
            signal: None,
            process_tree_retired: false,
        });
        self.save_startup_fact()
    }

    fn observe_startup(
        &mut self,
        observation: ProviderStartupObservation,
    ) -> Result<(), DurableRunnerError> {
        let attempt = self
            .state
            .as_mut()
            .and_then(|state| state.startup_attempt.as_mut())
            .ok_or_else(|| DurableRunnerError::invalid("provider startup intent missing"))?;
        match observation {
            ProviderStartupObservation::Spawned {
                process_id,
                process_group_id,
            } => {
                attempt.phase = ProviderStartupPhase::Spawned;
                attempt.process_id = Some(process_id);
                attempt.process_group_id = Some(process_group_id);
            }
            ProviderStartupObservation::Failed { stage, child_exit } => {
                attempt.phase = ProviderStartupPhase::InitializationFailed;
                attempt.failed_stage = Some(stage);
                attempt.direct_child_exit_observed = child_exit.is_some();
                attempt.exit_code = child_exit.as_ref().and_then(|fact| fact.exit_code);
                attempt.signal = child_exit.as_ref().and_then(|fact| fact.signal);
            }
        }
        self.save_startup_fact()
    }

    fn start_observed_provider(
        &mut self,
        trigger: ProviderStartupTrigger,
        generation: u64,
    ) -> Result<CodexProvider, DurableRunnerError> {
        let state = self
            .state
            .clone()
            .ok_or_else(|| DurableRunnerError::invalid("provider startup state missing"))?;
        let profile = self.opencode_launch_profile.clone();
        self.begin_startup(trigger, generation)?;
        CodexProvider::start_with_tools_observed(
            &state.config,
            state.tool_bridge.authorized_tools().cloned(),
            state.thread_id.as_deref(),
            generation,
            profile.as_ref(),
            state.completion_contract.as_ref().map(|contract| {
                (
                    contract.revision.as_str(),
                    contract.criterion_ids.as_slice(),
                )
            }),
            &mut |observation| {
                self.observe_startup(observation).map_err(|error| {
                    crate::local_runner::LocalRunnerError::invalid(error.to_string())
                })
            },
        )
        .map(|mut provider| {
            provider.restore_descendant_thread_identities(&state.descendant_thread_ids);
            provider
        })
        .map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to start {} provider: {error}",
                state.config.provider
            ))
        })
    }

    fn commit_startup_admission(&mut self) -> Result<(), DurableRunnerError> {
        // Never clear the live fence until the authenticated provider state is
        // fsynced. Failed persistence leaves the exact attempt unadmitted.
        let mut next = self
            .state
            .clone()
            .ok_or_else(|| DurableRunnerError::invalid("provider startup state missing"))?;
        next.startup_attempt = None;
        self.persist_state(&next)?;
        self.state = Some(next);
        Ok(())
    }

    fn fail_started_provider(&mut self, provider: &mut CodexProvider) {
        let child_exit = provider.retire_failed_startup();
        let _ = self.observe_startup(ProviderStartupObservation::Failed {
            stage: ProviderStartupStage::Admission,
            child_exit,
        });
    }

    fn restore(&mut self) -> Result<(), DurableRunnerError> {
        if let Some(error) = self.restore_error.as_ref() {
            return Err(error.clone());
        }
        self.assert_startup_admitted()?;
        if self.restore_checked {
            return Ok(());
        }
        match self.restore_once() {
            Ok(()) => {
                self.assert_startup_admitted()?;
                self.restore_checked = true;
                Ok(())
            }
            Err(error) => {
                self.restore_error = Some(error.clone());
                Err(error)
            }
        }
    }

    fn restore_once(&mut self) -> Result<(), DurableRunnerError> {
        self.load_state_without_provider()?;
        self.restore_provider_if_needed()
    }

    fn load_state_without_provider(&mut self) -> Result<(), DurableRunnerError> {
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
        let expected_launch_profile_digest = self.bind_opencode_launch_profile(&state.config)?;
        if state.opencode_launch_profile_digest != expected_launch_profile_digest {
            return Err(DurableRunnerError::invalid(
                "OpenCode runner launch profile changed across durable recovery",
            ));
        }
        self.state = Some(state);
        Ok(())
    }

    fn restore_provider_if_needed(&mut self) -> Result<(), DurableRunnerError> {
        self.assert_startup_admitted()?;
        let Some(state) = self.state.clone() else {
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
        let provider_label = state.config.provider.clone();
        let provider_name = if provider_label == "opencode" {
            "OpenCode"
        } else {
            "Codex"
        };
        let provider_had_exited = state.lifecycle == "provider_exited";
        let thread_id = state.thread_id.clone().ok_or_else(|| {
            DurableRunnerError::invalid(format!(
                "recoverable {provider_name} state omitted its thread id"
            ))
        })?;
        let previous_active_turn_id = state.active_provider_turn_id.clone();
        let process_generation = state
            .provider_process_generation
            .checked_add(1)
            .ok_or_else(|| {
                DurableRunnerError::invalid(format!("{provider_name} process generation exhausted"))
            })?;
        let completed_turn_authoritative = state.completed_turn_authoritative;
        let completed_turn_process_generation = state.completed_turn_process_generation;
        let completed_provider_turn_id = state.completed_provider_turn_id.clone();
        let active_provider_result_authoritative =
            state.active_provider_result_fingerprint.is_some();
        let ambiguous_turn_start_pending = state.ambiguous_turn_start_pending;
        let tool_replay_history_blocks_admission =
            state.tool_bridge.replay_history_blocks_admission();
        let tool_receipt_epoch_has_active_receipts = state.tool_bridge.has_active_receipts();
        let (settled_provider_turn_ids, settled_provider_turn_filter) =
            state.recovered_settled_provider_turn_ids()?;
        let provider_epoch_requires_rollover = settled_provider_turn_ids.len()
            >= MAX_SETTLED_PROVIDER_TURN_IDS
            || !settled_provider_turn_filter.is_empty();
        let mut provider = self
            .start_observed_provider(ProviderStartupTrigger::Restore, process_generation)
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to resume {provider_name} provider: {error}"
                ))
            })?;
        let admission = (|| -> Result<(), DurableRunnerError> {
            provider.enable_durable_tool_call_replays();
            provider
                .restore_settled_turn_identities(
                    settled_provider_turn_ids.iter().cloned(),
                    settled_provider_turn_filter.clone(),
                )
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to restore local provider turn identities: {error}"
                    ))
                })?;
            let recovered_active_turn_id = provider.active_provider_turn_id().map(str::to_owned);
            let recovered_turn_ended_with_result = active_provider_result_authoritative
                && previous_active_turn_id.is_some()
                && recovered_active_turn_id.is_none();
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
                state.active_provider_result_fingerprint = None;
                state.active_provider_result_disposition = None;
                state.last_agent_message = None;
                state.lifecycle = "closed".to_owned();
                let _ = state.push_terminal_event(NormalizedProviderEvent {
                event_type: "harness.diagnostic".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": provider_label,
                    "code": "legacy_provider_turn_epoch_ambiguous",
                    "message": format!("{provider_name} recovery could not safely identify and settle active work from a saturated legacy replay epoch; Paperclip terminated the provider and closed the durable run"),
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
                state.active_provider_result_fingerprint = None;
                state.active_provider_result_disposition = None;
                state.last_agent_message = None;
                state.lifecycle = "closed".to_owned();
                // Closing the provider is the safety boundary. Preserve that
                // durable transition even when an already-full event backlog has
                // no room for an additional diagnostic.
                let _ = state.push_terminal_event(NormalizedProviderEvent {
                event_type: "harness.diagnostic".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": provider_label,
                    "code": "provider_turn_identity_reused",
                    "providerTurnId": reused_provider_turn_id,
                    "message": format!("{provider_name} recovery reported a previously settled turn identity as active; Paperclip terminated the provider and closed the durable run"),
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
                    format!("cannot safely recover an ambiguous {provider_name} turn start without an active replacement turn"),
                )
            })?;
                if completed_provider_turn_id.as_deref() == Some(recovered_turn_id) {
                    return Err(DurableRunnerError::invalid(
                    format!("ambiguous {provider_name} turn recovery reused the previously completed turn identity"),
                ));
                }
            }
            provider
                .restore_completed_turn_authority(
                    (completed_turn_authoritative || recovered_turn_ended_with_result)
                        && recovered_active_turn_id.is_none()
                        && !ambiguous_turn_start_pending,
                    if recovered_turn_ended_with_result {
                        Some(process_generation)
                    } else {
                        completed_turn_process_generation
                    },
                    if recovered_turn_ended_with_result {
                        previous_active_turn_id.as_deref()
                    } else {
                        completed_provider_turn_id.as_deref()
                    },
                )
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to restore local provider completion authority: {error}"
                    ))
                })?;
            if active_provider_result_authoritative
                && recovered_active_turn_id.is_some()
                && recovered_active_turn_id == previous_active_turn_id
            {
                provider
                .mark_active_turn_result_authoritative()
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to restore semantic result authority for the active {provider_name} turn: {error}"
                    ))
                })?;
            }
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
                        "provider": provider_label,
                        "providerSessionId": thread_id.clone(),
                        "providerAccountSessionId": resumed_provider_session_id,
                        "processId": resumed_process_id,
                    }),
                })?;
            }
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
                    if recovered_turn_ended_with_result {
                        state.completed_turn_authoritative = true;
                        state.completed_turn_process_generation = Some(process_generation);
                        state.completed_provider_turn_id = previous_active_turn_id.clone();
                    }
                }
                state.reconcile_active_provider_turn(recovered_active_turn_id.clone());
                let reconciled = NormalizedProviderEvent {
                    event_type: "session.reconciled".to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({
                        "provider": provider_label,
                        "providerSessionId": thread_id,
                        "previousProviderTurnId": previous_active_turn_id.clone(),
                        "activeProviderTurnId": recovered_active_turn_id.clone(),
                    }),
                };
                if recovered_turn_ended {
                    state.push_terminal_event(reconciled)?;
                    if recovered_turn_ended_with_result {
                        // The durable correlated tool receipt proves Paperclip
                        // accepted this exact turn's semantic result before the
                        // runner stopped observing provider output. Resume
                        // finalization without inventing another provider turn.
                        state.extend_terminal_events(terminal_events(
                            state,
                            "turn.completed",
                            state.goal.as_ref().map(|goal| goal.status.as_str()),
                        ))?;
                    } else {
                        // A turn that disappeared while runnerd was offline has no
                        // trustworthy success notification to replay. Terminate it
                        // conservatively so the controller cannot wait forever or
                        // mistake an unknown outcome for success.
                        state.push_terminal_event(NormalizedProviderEvent {
                            event_type: "turn.failed".to_owned(),
                            priority: EventPriority::P0,
                            payload: json!({
                                "provider": provider_label,
                                "providerTurnId": previous_active_turn_id,
                                "status": "failed",
                                "providerTerminalObserved": false,
                            }),
                        })?;
                        state.extend_terminal_events(terminal_events(
                            state,
                            "turn.failed",
                            state.goal.as_ref().map(|goal| goal.status.as_str()),
                        ))?;
                    }
                } else {
                    state.push_event(reconciled)?;
                }
            }
            if self
                .state
                .as_ref()
                .is_some_and(|state| state.lifecycle == "closed")
            {
                return Ok(());
            }
            self.commit_startup_admission()
        })();
        if admission.is_err()
            || self
                .state
                .as_ref()
                .is_some_and(|state| state.lifecycle == "closed")
        {
            self.fail_started_provider(&mut provider);
        } else {
            self.provider = Some(provider);
        }
        admission
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
        let provider_name = config.provider.clone();
        let driver = config.driver.clone();
        let opencode_launch_profile_digest = self.bind_opencode_launch_profile(&config)?;
        let completion_contract = completion_contract(payload)?;
        let tool_set = authorized_tool_set(payload)?;
        if let Some(state) = self.state.as_mut() {
            if state.config != config || state.completion_contract != completion_contract {
                return Err(DurableRunnerError::invalid(
                    "Codex provider or completion contract changed across the durable run",
                ));
            }
            if state.opencode_launch_profile_digest != opencode_launch_profile_digest {
                return Err(DurableRunnerError::invalid(
                    "OpenCode runner launch profile changed across the durable run",
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
            let mut state = CodexProviderState::new(config, completion_contract, tool_bridge);
            state.opencode_launch_profile_digest = opencode_launch_profile_digest;
            self.state = Some(state);
            self.save_state()?;
        }
        Ok(CommandExecution::result(json!({
            "status": "prepared",
            "provider": provider_name,
            "driver": driver,
        })))
    }

    fn ensure_provider(&mut self) -> Result<&mut CodexProvider, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.lifecycle == "reconciliation_required")
        {
            return Err(DurableRunnerError::invalid(
                "Codex provider session requires explicit reconciliation and a fresh session",
            ));
        }
        if self.provider.is_none() {
            let state = self.state.clone().ok_or_else(|| {
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
            let mut provider = self
                .start_observed_provider(ProviderStartupTrigger::Ensure, process_generation)
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("failed to start Codex provider: {error}"))
                })?;
            let admission = (|| -> Result<(), DurableRunnerError> {
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
                if state.lifecycle == "prepared" && provider.active_provider_turn_id().is_some() {
                    // A stopped checkpoint has no active work to inherit. Inspect
                    // the actual resumed thread before publishing this process or
                    // accepting any of its buffered tool calls under new authority.
                    let provider_shutdown_failed = provider.shutdown().is_err();
                    let state = self
                        .state
                        .as_mut()
                        .expect("prepared state remains available after provider start");
                    state.provider_process_generation = process_generation;
                    state.lifecycle = "closed".to_owned();
                    let _ = state.push_terminal_event(NormalizedProviderEvent {
                        event_type: "harness.diagnostic".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({
                            "code": "prepared_provider_checkpoint_has_active_work",
                            "paperclipAccepted": false,
                            "providerReportedActive": true,
                            "providerShutdownFailed": provider_shutdown_failed,
                        }),
                    });
                    self.save_state()?;
                    return Err(DurableRunnerError::invalid(
                        "prepared provider checkpoint resumed unexpected active work",
                    ));
                }
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
                {
                    let state = self
                        .state
                        .as_mut()
                        .expect("Codex state remains available after provider start");
                    state.provider_process_generation = process_generation;
                    state.thread_id = Some(provider.thread_id().to_owned());
                    state.provider_session_id = provider.provider_session_id().map(str::to_owned);
                    state.lifecycle = "session_open".to_owned();
                    state.settled_provider_turn_ids = settled_provider_turn_ids;
                    state.settled_provider_turn_filter = settled_provider_turn_filter;
                }
                self.commit_startup_admission()
            })();
            if let Err(error) = admission {
                self.fail_started_provider(&mut provider);
                return Err(error);
            }
            self.provider = Some(provider);
        }
        self.provider
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is unavailable"))
    }

    // Only the authenticated controller can rebind these run-scoped launch
    // settings. Executable, model, instructions, approval mode, and all other
    // flags remain part of the immutable durable provider profile.
    fn stable_launch_args(args: &[String]) -> Vec<String> {
        let mut stable = Vec::new();
        let mut index = 0;
        while index < args.len() {
            if args[index] == "-c" && index + 1 < args.len() {
                let key = args[index + 1].split('=').next().unwrap_or("");
                if matches!(
                    key,
                    "permissions.paperclip-runner-workspace-only.filesystem"
                        | "permissions.paperclip-runner-workspace-read-only.filesystem"
                        | "permissions.paperclip-runner-workspace-only.network.enabled"
                        | "permissions.paperclip-runner-workspace-read-only.network.enabled"
                        | "shell_environment_policy.inherit"
                        | "shell_environment_policy.ignore_default_excludes"
                        | "shell_environment_policy.include_only"
                        | "shell_environment_policy.set"
                ) {
                    index += 2;
                    continue;
                }
            }
            stable.push(args[index].clone());
            index += 1;
        }
        stable
    }

    fn attach_run(&mut self, payload: &Value) -> Result<(), DurableRunnerError> {
        let mut next_state = self
            .state
            .clone()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider has not been prepared"))?;
        // execute() restores the durable provider before dispatching run.attach.
        // An exact, settled restore can emit one session.resumed notice about
        // the prior provider session before the new run authority is attached.
        // That lifecycle-only notice is safe to discard during rotation. Closed
        // startup audit facts are retained for the runner's old-authority ACK
        // fence; other pending events still block attachment so terminal, tool,
        // and reconciliation data cannot be lost.
        let only_recovery_notice_pending = next_state
            .pending_events
            .iter()
            .all(|event| event.event_type == "session.resumed" || is_startup_audit_event(event));
        if next_state.thread_id.is_none()
            || next_state.lifecycle == "closed"
            || next_state.active_provider_turn_id.is_some()
            || next_state.ambiguous_turn_start_pending
            || !only_recovery_notice_pending
            || !next_state.queued_events.is_empty()
        {
            return Err(DurableRunnerError::invalid(
                "run.attach requires a settled Codex provider session with no pending events",
            ));
        }
        let runtime_launch_args: Option<Vec<String>> = payload
            .get("runtimeLaunchArgs")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|_| {
                DurableRunnerError::invalid("run.attach runtime launch arguments are invalid")
            })?;
        if let Some(provider) = payload.get("provider") {
            let mut config: CodexProviderConfig = serde_json::from_value(provider.clone())
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("run.attach provider is invalid: {error}"))
                })?;
            config
                .validate()
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
            if runtime_launch_args.is_some()
                && config.provider == "codex"
                && Self::stable_launch_args(&config.args)
                    == Self::stable_launch_args(&next_state.config.args)
            {
                config.args = next_state.config.args.clone();
            }
            if config != next_state.config {
                return Err(DurableRunnerError::invalid(
                    "run.attach cannot change the durable Codex provider profile",
                ));
            }
        }
        let runtime_launch_changed = if let Some(args) = runtime_launch_args {
            if next_state.config.provider != "codex"
                || Self::stable_launch_args(&args)
                    != Self::stable_launch_args(&next_state.config.args)
            {
                return Err(DurableRunnerError::invalid(
                    "run.attach cannot change protected launch arguments",
                ));
            }
            let changed = args != next_state.config.args;
            next_state.config.args = args;
            next_state
                .config
                .validate()
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
            changed
        } else {
            false
        };
        let completion_contract = completion_contract(payload)?;
        let tool_set = authorized_tool_set(payload)?;
        next_state
            .tool_bridge
            .attach_run(tool_set)
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "run.attach tool contract could not be rebound: {error}"
                ))
            })?;
        next_state.completion_contract = completion_contract;
        next_state.completed_turn_authoritative = false;
        next_state.completed_turn_process_generation = None;
        next_state.completed_provider_turn_id = None;
        next_state.receipt_limit_diagnostic_emitted = false;
        next_state.receipt_limit_interrupt_pending = false;
        next_state.receipt_limit_interrupt_accepted = false;
        next_state.receipt_limit_interrupt_attempts = 0;
        next_state.receipt_limit_interrupt_deadline_unix_ms = None;
        next_state.active_provider_result_fingerprint = None;
        next_state.active_provider_result_disposition = None;
        next_state.last_agent_message = None;
        let retained_provider = if let Some(provider) = self.provider.as_mut() {
            !runtime_launch_changed
                && provider
                    .attach_run_in_place(
                        next_state.tool_bridge.authorized_tools().cloned(),
                        next_state.completion_contract.as_ref().map(|contract| {
                            (
                                contract.revision.as_str(),
                                contract.criterion_ids.as_slice(),
                            )
                        }),
                    )
                    .map_err(|error| {
                        DurableRunnerError::invalid(format!(
                            "failed to retain Codex for warm run attachment: {error}"
                        ))
                    })?
        } else if next_state.lifecycle == "prepared"
            && next_state.provider_process_generation > 0
            && next_state.pending_events.iter().all(is_startup_audit_event)
        {
            // turn.stop deliberately terminates the exact old process and
            // retains a prepared, settled thread checkpoint. Rebind only its
            // validated run-scoped settings here; open_session then restores
            // that same thread under the new authority. Never restart during
            // drain/suspend or require the stopped process to still exist.
            false
        } else {
            return Err(DurableRunnerError::invalid(
                "run.attach requires the restored Codex provider process",
            ));
        };
        if !retained_provider {
            if let Some(provider) = self.provider.as_mut() {
                provider.shutdown().map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to checkpoint Codex before attaching a new run: {error}"
                    ))
                })?;
            }
            self.provider = None;
        }
        // Successful startup facts remain owned by their original attempt.
        // The runner must commit this retained FIFO before rotating authority;
        // only the superseded informational restore notice is discarded.
        next_state.pending_events.retain(is_startup_audit_event);
        next_state.lifecycle = if retained_provider {
            "session_open".to_owned()
        } else {
            // The next provider command restores the same checkpointed session
            // with the rotated tool/completion authority.
            "prepared".to_owned()
        };
        self.persist_state(&next_state)?;
        self.state = Some(next_state);
        Ok(())
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
        let (thread_id, provider_session_id, process_id, active_provider_turn_id, goal_probe) = {
            let provider = self.ensure_provider()?;
            (
                provider.thread_id().to_owned(),
                provider.provider_session_id().map(str::to_owned),
                provider.process_id(),
                provider.active_provider_turn_id().map(str::to_owned),
                provider.get_goal(),
            )
        };
        let (goal_capability, goal) = match goal_probe {
            Ok(snapshot) => (
                SessionGoalCapability::codex_available(),
                normalize_codex_goal(&snapshot, active_provider_turn_id.is_some()),
            ),
            Err(error) => {
                let message = error.to_string().to_ascii_lowercase();
                if message.contains("policy")
                    || message.contains("disabled")
                    || message.contains("feature")
                {
                    (
                        SessionGoalCapability::unavailable(
                            "policy_disabled",
                            "codex_goal_policy_disabled",
                        ),
                        None,
                    )
                } else {
                    (
                        SessionGoalCapability::unavailable(
                            "unsupported",
                            if message.contains("-32601") || message.contains("unknown method") {
                                "codex_goal_unknown_method"
                            } else {
                                "codex_goal_probe_failed"
                            },
                        ),
                        None,
                    )
                }
            }
        };
        let (provider_name, driver, provider_version, goal_revision) = {
            let state = self
                .state
                .as_mut()
                .expect("Codex state exists after provider start");
            state.thread_id = Some(thread_id.clone());
            state.provider_session_id = provider_session_id.clone();
            state.active_provider_turn_id = active_provider_turn_id.clone();
            state.receipt_limit_diagnostic_emitted = false;
            state.receipt_limit_interrupt_pending = false;
            state.receipt_limit_interrupt_accepted = false;
            state.receipt_limit_interrupt_attempts = 0;
            state.receipt_limit_interrupt_deadline_unix_ms = None;
            state.lifecycle = if active_provider_turn_id.is_some() {
                "turn_active".to_owned()
            } else {
                "session_open".to_owned()
            };
            state.goal_capability = Some(goal_capability.clone());
            state.goal = goal.clone();
            state.goal_revision = state.goal_revision.saturating_add(1);
            (
                state.config.provider.clone(),
                state.config.driver.clone(),
                state.config.provider_version.clone(),
                state.goal_revision,
            )
        };
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({
                "status": if resumed { "resumed" } else { "started" },
                "provider": provider_name,
                "driver": driver,
                "providerVersion": provider_version,
                "providerSessionId": thread_id,
                "processId": process_id,
            }),
            events: vec![
                (
                    if resumed {
                        "session.resumed"
                    } else {
                        "session.started"
                    }
                    .to_owned(),
                    EventPriority::P0,
                    json!({
                        "provider": provider_name,
                        "providerSessionId": thread_id,
                        "providerAccountSessionId": provider_session_id,
                        "processId": process_id,
                    }),
                ),
                (
                    "session.capabilities.updated".to_owned(),
                    EventPriority::P0,
                    json!({"sessionGoals": goal_capability}),
                ),
                (
                    "session.goal.snapshot".to_owned(),
                    EventPriority::P0,
                    goal_event_payload(goal.as_ref(), Some(&goal_capability), goal_revision),
                ),
            ],
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
        state.active_provider_result_fingerprint = None;
        state.active_provider_result_disposition = None;
        state.last_agent_message = None;
        state.lifecycle = "closed".to_owned();
        let provider_label = state.config.provider.clone();
        let provider_name = if provider_label == "opencode" {
            "OpenCode"
        } else {
            "Codex"
        };
        // Closure is the safety boundary. Preserve it even if a saturated
        // event queue cannot retain this additional diagnostic.
        let _ = state.push_terminal_event(NormalizedProviderEvent {
            event_type: "harness.diagnostic".to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "provider": provider_label,
                "code": match rejected_accepted_turn {
                    RejectedAcceptedTurn::ReusedIdentity(_) => "provider_turn_identity_reused",
                    RejectedAcceptedTurn::InvalidIdentity => "provider_turn_identity_invalid",
                },
                "providerTurnId": match rejected_accepted_turn {
                    RejectedAcceptedTurn::ReusedIdentity(provider_turn_id) => json!(provider_turn_id),
                    RejectedAcceptedTurn::InvalidIdentity => Value::Null,
                },
                "message": match rejected_accepted_turn {
                    RejectedAcceptedTurn::ReusedIdentity(_) => format!("{provider_name} accepted work with a previously settled turn identity; Paperclip terminated the provider and closed the durable run"),
                    RejectedAcceptedTurn::InvalidIdentity => format!("{provider_name} accepted work without a valid bounded turn identity; Paperclip terminated the provider and closed the durable run"),
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

        let next_generation = self
            .state
            .as_ref()
            .and_then(|state| state.provider_process_generation.checked_add(1))
            .ok_or_else(|| DurableRunnerError::invalid("provider process generation exhausted"))?;
        self.begin_startup(ProviderStartupTrigger::Rollover, next_generation)?;
        let (restart_result, process_generation, rejected_accepted_turn) = {
            let mut provider = self.provider.take().ok_or_else(|| {
                DurableRunnerError::invalid(
                    "Codex provider identity epoch cannot rotate without an attached process",
                )
            })?;
            let restart_result =
                provider.restart_idle_identity_epoch_observed(&mut |observation| {
                    self.observe_startup(observation).map_err(|error| {
                        crate::local_runner::LocalRunnerError::invalid(error.to_string())
                    })
                });
            let result = (
                restart_result,
                provider.process_generation(),
                provider.take_rejected_accepted_turn(),
            );
            self.provider = Some(provider);
            result
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
        let admission = (|| {
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
            self.commit_startup_admission()
        })();
        if let Err(error) = admission {
            if let Some(mut provider) = self.provider.take() {
                self.fail_started_provider(&mut provider);
            }
            return Err(error);
        }
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
                state.active_provider_result_fingerprint = None;
                state.active_provider_result_disposition = None;
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
        state.active_provider_result_fingerprint = None;
        state.active_provider_result_disposition = None;
        state.last_agent_message = None;
        state.lifecycle = "turn_active".to_owned();
        let provider_label = state.config.provider.clone();
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({"status": "accepted", "providerTurnId": provider_turn_id}),
            events: vec![(
                "turn.accepted".to_owned(),
                EventPriority::P0,
                json!({"provider": provider_label, "providerSessionId": thread_id, "providerTurnId": provider_turn_id}),
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

    fn stop_turn_for_suspension(
        &mut self,
        reason: &str,
    ) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        let state = self.state.as_ref();
        // An unprepared or permanently closed executor cannot become a
        // successor checkpoint merely because the controller asks it to stop.
        if state.is_none_or(|state| state.lifecycle == "closed") {
            return Ok(CommandExecution::result(json!({
                "status": "already_settled",
                "reason": reason,
            })));
        }
        let provider_turn_id = state.and_then(|state| state.active_provider_turn_id.clone());

        // Unlike turn.interrupt, turn.stop is the definitive physical cleanup
        // boundary. A courtesy RPC can wait longer than the controller's close
        // budget, especially after an earlier interrupt already aborted the
        // provider turn but its terminal frame has not been polled. Terminate
        // the exact owned generation without another cooperative interrupt.
        // Resume may discover that the old turn already ended; its newly
        // resumed process still needs the same exit and prepared-state proof.
        let provider_shutdown_failed = self
            .provider
            .as_mut()
            .is_some_and(|provider| provider.shutdown().is_err());
        if provider_shutdown_failed {
            return Err(DurableRunnerError::invalid(
                "failed to prove provider termination at the suspension boundary",
            ));
        }
        self.provider = None;

        let identity = self.event_identity()?;
        let state = self
            .state
            .as_mut()
            .expect("Codex state remains available after provider termination");
        if provider_turn_id.is_some() {
            state.settle_active_provider_turn_identity()?;
        }
        let settled = state
            .tool_bridge
            .settle_turn("provider_turn_stopped_for_suspension")
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to settle semantic tools at the suspension boundary: {error}"
                ))
            })?;
        for result in settled {
            state.push_terminal_event(semantic_result_event(&identity, &result))?;
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
        state.active_provider_result_fingerprint = None;
        state.active_provider_result_disposition = None;
        state.last_agent_message = None;
        // Do not let the runner.drain command that follows turn.stop restore a
        // fresh provider process. `prepared` retains the durable thread while
        // deferring the only authorized restart to the successor run.attach.
        state.lifecycle = "prepared".to_owned();
        self.save_state()?;
        Ok(CommandExecution::result(json!({
            "status": if provider_turn_id.is_some() { "stopped" } else { "already_settled" },
            "providerTurnId": provider_turn_id,
            "reason": reason,
            "interruptAccepted": false,
            "providerExitConfirmed": true,
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

    fn ensure_goal_available(&self) -> Result<(), DurableRunnerError> {
        if self
            .state
            .as_ref()
            .and_then(|state| state.goal_capability.as_ref())
            .is_some_and(|capability| capability.availability == "available")
        {
            Ok(())
        } else {
            Err(DurableRunnerError::invalid(
                "Codex session goals are unavailable for this provider session",
            ))
        }
    }

    fn get_goal(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        self.ensure_goal_available()?;
        let (snapshot, working_now) = {
            let provider = self.ensure_provider()?;
            let snapshot = provider.get_goal().map_err(|error| {
                DurableRunnerError::invalid(format!("Codex thread/goal/get failed: {error}"))
            })?;
            (snapshot, provider.active_provider_turn_id().is_some())
        };
        let goal = normalize_codex_goal(&snapshot, working_now);
        let (capability, revision) = {
            let state = self
                .state
                .as_mut()
                .expect("Codex state exists while reading its goal");
            state.goal = goal.clone();
            state.goal_revision = state.goal_revision.saturating_add(1);
            (state.goal_capability.clone(), state.goal_revision)
        };
        self.save_state()?;
        let payload = goal_event_payload(goal.as_ref(), capability.as_ref(), revision);
        Ok(CommandExecution {
            result: payload.clone(),
            events: vec![(
                "session.goal.snapshot".to_owned(),
                EventPriority::P0,
                payload,
            )],
        })
    }

    fn set_goal(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        self.ensure_goal_available()?;
        let objective = payload
            .get("objective")
            .map(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.chars().count() <= 4_000)
                    .ok_or_else(|| {
                        DurableRunnerError::invalid(
                        "session.goal.set objective must be nonblank and at most 4000 characters",
                    )
                    })
            })
            .transpose()?;
        let status = payload
            .get("status")
            .map(|value| {
                let status = value.as_str().ok_or_else(|| {
                    DurableRunnerError::invalid("session.goal.set status must be a string")
                })?;
                codex_goal_status(status).ok_or_else(|| {
                    DurableRunnerError::invalid("session.goal.set status is not supported by Codex")
                })
            })
            .transpose()?;
        let token_budget = if let Some(value) = payload.get("tokenBudget") {
            if value.is_null() {
                Some(None)
            } else {
                Some(Some(value.as_u64().filter(|value| *value > 0).ok_or_else(
                    || {
                        DurableRunnerError::invalid(
                            "session.goal.set tokenBudget must be null or a positive integer",
                        )
                    },
                )?))
            }
        } else {
            None
        };
        if objective.is_none() && status.is_none() && token_budget.is_none() {
            return Err(DurableRunnerError::invalid(
                "session.goal.set requires objective, status, or tokenBudget",
            ));
        }
        let (result, working_now) = {
            let provider = self.ensure_provider()?;
            let result = provider
                .set_goal(objective, status, token_budget)
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("Codex thread/goal/set failed: {error}"))
                })?;
            (result, provider.active_provider_turn_id().is_some())
        };
        let snapshot = if normalize_codex_goal(&result, working_now).is_some() {
            result
        } else {
            self.ensure_provider()?.get_goal().map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "Codex thread/goal/get after set failed: {error}"
                ))
            })?
        };
        let goal = normalize_codex_goal(&snapshot, working_now).ok_or_else(|| {
            DurableRunnerError::invalid("Codex thread/goal/set omitted a valid goal snapshot")
        })?;
        let (capability, revision) = {
            let state = self
                .state
                .as_mut()
                .expect("Codex state exists while setting its goal");
            state.goal = Some(goal.clone());
            state.goal_revision = state.goal_revision.saturating_add(1);
            (state.goal_capability.clone(), state.goal_revision)
        };
        self.save_state()?;
        let event = goal_control_event_payload(
            Some(&goal),
            capability.as_ref(),
            revision,
            payload.get("requestId").and_then(Value::as_str),
        );
        Ok(CommandExecution {
            result: json!({"status": "accepted", "snapshot": event}),
            events: vec![("session.goal.updated".to_owned(), EventPriority::P0, event)],
        })
    }

    fn clear_goal(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        self.ensure_goal_available()?;
        let result = self.ensure_provider()?.clear_goal().map_err(|error| {
            DurableRunnerError::invalid(format!("Codex thread/goal/clear failed: {error}"))
        })?;
        let (capability, revision, working_now) = {
            let working_now = self
                .provider
                .as_ref()
                .is_some_and(|provider| provider.active_provider_turn_id().is_some());
            let state = self
                .state
                .as_mut()
                .expect("Codex state exists while clearing its goal");
            state.goal = None;
            state.goal_revision = state.goal_revision.saturating_add(1);
            (
                state.goal_capability.clone(),
                state.goal_revision,
                working_now,
            )
        };
        self.save_state()?;
        let event = json!({
            "schema": "paperclip.session_goal.snapshot.v1",
            "goal": Value::Null,
            "sessionGoals": capability,
            "workingNow": working_now,
            "revision": revision,
            "cleared": result.get("cleared").and_then(Value::as_bool).unwrap_or(true),
            "requestId": payload.get("requestId").and_then(Value::as_str),
        });
        Ok(CommandExecution {
            result: json!({"status": "accepted", "snapshot": event}),
            events: vec![("session.goal.cleared".to_owned(), EventPriority::P0, event)],
        })
    }

    fn resolve_request(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let request_id = payload
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires requestId"))?;
        let provider_label = self
            .state
            .as_ref()
            .map(|state| state.config.provider.clone())
            .unwrap_or_else(|| "codex".to_owned());
        let provider_name = if provider_label == "opencode" {
            "OpenCode"
        } else {
            "Codex"
        };
        if self
            .state
            .as_ref()
            .is_none_or(|state| state.active_provider_turn_id.is_none())
        {
            return Err(DurableRunnerError::invalid(format!(
                "cannot resolve a {provider_name} runtime request outside an active turn"
            )));
        }
        let response = payload
            .get("response")
            .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires response"))?;
        self.ensure_provider()?
            .resolve_runtime_request(request_id, response)
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "{provider_name} runtime response failed: {error}"
                ))
            })?;
        Ok(CommandExecution {
            result: json!({"status": "delivered", "requestId": request_id}),
            events: vec![(
                "runtime_request.resolved".to_owned(),
                EventPriority::P0,
                json!({"provider": provider_label, "requestId": request_id, "status": "delivered"}),
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
        error: ProviderBridgeError,
    ) -> Result<(), DurableRunnerError> {
        let reason = error.to_string();
        let state = self
            .state
            .as_mut()
            .expect("Codex state remains available for a rejected tool call");
        let event = NormalizedProviderEvent {
            event_type: "harness.diagnostic".to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "provider": state.config.provider,
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
        let rejection = invalid_tool_call_result(call_id, operation_id, &error);
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
        let provider_label = state.config.provider.clone();
        let provider_name = if provider_label == "opencode" {
            "OpenCode"
        } else {
            "Codex"
        };
        state.push_terminal_event(NormalizedProviderEvent {
            event_type: terminal_event_type.to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "provider": provider_label,
                "code": if interrupt_accepted {
                    "semantic_tool_turn_receipt_limit_interrupt_deadline"
                } else {
                    "semantic_tool_turn_receipt_limit_interrupt_unconfirmed"
                },
                "message": if interrupt_accepted {
                    format!("{provider_name} accepted the receipt-limit interruption but did not emit its terminal before the bounded shutdown deadline")
                } else {
                    format!("{provider_name} did not confirm terminal state after the bounded receipt-limit interruption attempts")
                },
                "interruptAccepted": interrupt_accepted,
                "providerTerminalObserved": false,
                "providerShutdownFailed": provider_shutdown_failed,
            }),
        })?;
        let terminal = terminal_events(state, terminal_event_type, None);
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
                return self.reject_tool_call(call_id, operation_id, error);
            }
            Ok(ToolCallAdmission::Pending(call)) => {
                self.state
                    .as_mut()
                    .expect("Codex state remains available while accepting a tool call")
                    .push_event(semantic_input_event(&identity, &call)?)?;
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
        let terminal_tool_input = next_state
            .tool_bridge
            .pending_calls()
            .find(|call| call.call_id == result.call_id)
            .map(|call| (call.operation_id.clone(), call.input.clone()));
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
        let terminal_tool_authoritative =
            terminal_tool_input
                .as_ref()
                .is_some_and(|(operation_id, _)| {
                    !result.is_error
                        && matches!(
                            operation_id.as_str(),
                            "paperclip_finish" | "paperclip_block"
                        )
                });
        if let Some((operation_id, input)) = terminal_tool_input {
            admit_terminal_tool_authority(&mut next_state, &operation_id, &input, result.is_error)?;
        }
        next_state.push_event(semantic_result_event(&identity, &result))?;
        self.persist_state(&next_state)?;
        self.state = Some(next_state);
        let provider = self.ensure_provider()?;
        if terminal_tool_authoritative {
            provider
                .mark_active_turn_result_authoritative()
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to bind semantic result to the active Codex turn: {error}"
                    ))
                })?;
        }
        provider.deliver_tool_result(&result).map_err(|error| {
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
        state.active_provider_result_fingerprint = None;
        state.active_provider_result_disposition = None;
        state.lifecycle = "closed".to_owned();
        let thread_id = state.thread_id.clone();
        let provider_name = state.config.provider.clone();
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({"status": "closed", "providerSessionId": thread_id}),
            events: vec![(
                "session.closed".to_owned(),
                EventPriority::P0,
                json!({"provider": provider_name, "providerSessionId": thread_id}),
            )],
        })
    }

    fn snapshot(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        let quiesce_for_warm_attach = payload
            .get("quiesceForWarmAttach")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut warm_attach_blockers = self
            .provider
            .as_mut()
            .map(|provider| provider.warm_run_attachment_blockers(quiesce_for_warm_attach))
            .transpose()
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to inspect Codex warm attachment readiness: {error}"
                ))
            })?
            .unwrap_or_else(|| vec!["provider_unavailable"]);
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is not prepared"))?;
        if state.active_provider_turn_id.is_some() {
            warm_attach_blockers.push("durable_active_turn");
        }
        if state.ambiguous_turn_start_pending {
            warm_attach_blockers.push("durable_ambiguous_turn_start");
        }
        if !state.pending_events.is_empty() {
            warm_attach_blockers.push("durable_pending_events");
        }
        if !state.queued_events.is_empty() {
            warm_attach_blockers.push("durable_queued_events");
        }
        let warm_attach_ready = warm_attach_blockers.is_empty();
        Ok(CommandExecution::result(json!({
            "status": state.lifecycle,
            "provider": state.config.provider,
            "driver": state.config.driver,
            "driverSessionId": state.thread_id,
            "providerSessionId": state.thread_id,
            "sessionId": state.provider_session_id,
            "providerAccountSessionId": state.provider_session_id,
            "activeProviderTurnId": state.active_provider_turn_id,
            "sessionGoals": state.goal_capability,
            "goal": state.goal,
            "goalRevision": state.goal_revision,
            "warmAttachReady": warm_attach_ready,
            "warmAttachBlockers": warm_attach_blockers,
            "cwd": state.config.cwd,
        })))
    }

    fn poll_provider(&mut self) -> Result<(), DurableRunnerError> {
        self.restore()?;
        // `restore_checked` records that the durable file was loaded even when
        // provider recovery failed. Retry the provider reconciliation here so
        // an ambiguous-start failure cannot degrade into an empty successful
        // poll on the same executor.
        self.restore_provider_if_needed()?;
        self.poll_current_provider()
    }

    fn poll_current_provider(&mut self) -> Result<(), DurableRunnerError> {
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
                CodexProviderEvent::ProtocolFailure { diagnostic }
                | CodexProviderEvent::ResourceLimit { diagnostic } => {
                    let resource_capacity = diagnostic["classification"] == "resource_capacity";
                    let state = self
                        .state
                        .as_mut()
                        .expect("Codex state available while polling");
                    // Neither an integrity failure nor a full lineage ledger can
                    // safely reopen this provider session, even after event ACK.
                    state.lifecycle = "reconciliation_required".to_owned();
                    state.completed_turn_authoritative = false;
                    state.completed_turn_process_generation = None;
                    state.completed_provider_turn_id = None;
                    if state.active_provider_turn_id.is_some() {
                        state.settle_active_provider_turn_identity()?;
                    }
                    state.active_provider_turn_id = None;
                    state.push_terminal_event(NormalizedProviderEvent {
                        event_type: "harness.diagnostic".to_owned(),
                        priority: EventPriority::P0,
                        payload: diagnostic.clone(),
                    })?;
                    state.push_terminal_event(NormalizedProviderEvent {
                        event_type: "turn.failed".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({ "provider": state.config.provider, "status": "failed",
                            "code": diagnostic["code"], "recoverable": false,
                            "message": diagnostic["message"], "error": diagnostic }),
                    })?;
                    state.extend_terminal_events(terminal_events(state, "turn.failed", None))?;
                    // Commit the authoritative failure before best-effort provider cleanup.
                    self.save_state()?;
                    if let Some(mut provider) = self.provider.take() {
                        if let Some(frame_id) = trace_frame_id {
                            provider.record_provider_trace_interpretation(
                                frame_id,
                                if resource_capacity { "codex.resource_capacity" } else { "codex.identity.invalid_authoritative" },
                                "rejected",
                                Vec::new(),
                                if resource_capacity { "Provider resource capacity requires explicit reconciliation" } else { "Rejected provider authority outside the root execution identity" },
                            );
                        }
                        let _ = provider.shutdown();
                    }
                    break;
                }
                CodexProviderEvent::DescendantNotification { method, params } => {
                    // Do not normalize a child's turn/completed as a root terminal.
                    // Retain bounded lineage evidence without credential-bearing payloads.
                    let child = params
                        .get("threadId")
                        .or_else(|| params.pointer("/thread/id"))
                        .and_then(Value::as_str)
                        .map(|id| id.chars().take(256).collect::<String>());
                    let root_thread = self
                        .provider
                        .as_ref()
                        .map(|provider| provider.thread_id().to_owned());
                    let root_turn = self
                        .provider
                        .as_ref()
                        .and_then(CodexProvider::active_provider_turn_id)
                        .map(str::to_owned);
                    let child_turn = params
                        .get("turnId")
                        .or_else(|| params.pointer("/turn/id"))
                        .and_then(Value::as_str)
                        .map(|id| id.chars().take(256).collect::<String>());
                    let state = self
                        .state
                        .as_mut()
                        .expect("Codex state remains available while polling");
                    if let Some(id) = child.as_ref() {
                        state.descendant_thread_ids.insert(id.clone());
                    }
                    state.extend_events(vec![NormalizedProviderEvent {
                        event_type: "harness.diagnostic".to_owned(),
                        priority: EventPriority::P1,
                        payload: json!({ "code": "provider_notification_identity", "classification": "descendant",
                            "method": method.chars().take(128).collect::<String>(), "receivedThreadId": child, "expectedThreadId": root_thread,
                            "receivedTurnId": child_turn, "expectedTurnId": root_turn }),
                    }])?;
                    self.save_state()?;
                    if let (Some(frame_id), Some(provider)) =
                        (trace_frame_id, self.provider.as_mut())
                    {
                        provider.record_provider_trace_interpretation(frame_id,
                            "codex.identity.descendant", "mapped", Vec::new(),
                            "Provider-confirmed descendant progress has no root terminal or tool authority");
                    }
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
                    let result_authoritative = normalized_terminal_type.is_some()
                        && self.state.as_ref().is_some_and(|state| {
                            state.active_provider_result_fingerprint.is_some()
                        });
                    let completed_turn_authority = if normalized_terminal_type
                        == Some("turn.completed")
                        || result_authoritative
                    {
                        self.provider
                            .as_ref()
                            .and_then(CodexProvider::completed_turn_authority)
                            .map(|(generation, turn_id)| (generation, turn_id.to_owned()))
                    } else {
                        None
                    };
                    let terminal_event_type = normalized_terminal_type.map(str::to_owned);
                    let goal_reconciliation = if terminal_event_type.is_some()
                        && self
                            .state
                            .as_ref()
                            .and_then(|state| state.goal_capability.as_ref())
                            .is_some_and(|capability| capability.availability == "available")
                    {
                        Some(
                            self.provider
                                .as_mut()
                                .expect("provider remains present during goal reconciliation")
                                .get_goal()
                                .map_err(|error| error.to_string()),
                        )
                    } else {
                        None
                    };
                    let working_now = self
                        .provider
                        .as_ref()
                        .is_some_and(|provider| provider.active_provider_turn_id().is_some());
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
                        if let Some(goal) = state.goal.as_mut() {
                            goal.working_now = true;
                            state.goal_revision = state.goal_revision.saturating_add(1);
                            state.push_event(NormalizedProviderEvent {
                                event_type: "session.goal.updated".to_owned(),
                                priority: EventPriority::P0,
                                payload: goal_event_payload(
                                    state.goal.as_ref(),
                                    state.goal_capability.as_ref(),
                                    state.goal_revision,
                                ),
                            })?;
                        }
                    }
                    let normalized = normalize_provider_notification(state, &method, &params)?;
                    let normalized_event_count = normalized.len();
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
                        if terminal_event_type.as_deref() == Some("turn.completed")
                            || result_authoritative
                        {
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
                        if let Some(goal) = state.goal.as_mut() {
                            goal.working_now = false;
                            state.goal_revision = state.goal_revision.saturating_add(1);
                            state.push_event(NormalizedProviderEvent {
                                event_type: "session.goal.updated".to_owned(),
                                priority: EventPriority::P0,
                                payload: goal_event_payload(
                                    state.goal.as_ref(),
                                    state.goal_capability.as_ref(),
                                    state.goal_revision,
                                ),
                            })?;
                        }
                    }
                    if method == "thread/goal/updated" {
                        state.goal = normalize_codex_goal(&params, working_now);
                        state.goal_revision = state.goal_revision.saturating_add(1);
                        state.push_event(NormalizedProviderEvent {
                            event_type: "session.goal.updated".to_owned(),
                            priority: EventPriority::P0,
                            payload: goal_event_payload(
                                state.goal.as_ref(),
                                state.goal_capability.as_ref(),
                                state.goal_revision,
                            ),
                        })?;
                    } else if method == "thread/goal/cleared" {
                        state.goal = None;
                        state.goal_revision = state.goal_revision.saturating_add(1);
                        state.push_event(NormalizedProviderEvent {
                            event_type: "session.goal.cleared".to_owned(),
                            priority: EventPriority::P0,
                            payload: goal_event_payload(
                                None,
                                state.goal_capability.as_ref(),
                                state.goal_revision,
                            ),
                        })?;
                    }
                    if let Some(reconciliation) = goal_reconciliation {
                        match reconciliation {
                            Ok(snapshot) => {
                                let next_goal = normalize_codex_goal(&snapshot, false);
                                if next_goal != state.goal {
                                    state.goal = next_goal;
                                    state.goal_revision = state.goal_revision.saturating_add(1);
                                    state.push_event(NormalizedProviderEvent {
                                        event_type: "session.goal.snapshot".to_owned(),
                                        priority: EventPriority::P0,
                                        payload: goal_event_payload(
                                            state.goal.as_ref(),
                                            state.goal_capability.as_ref(),
                                            state.goal_revision,
                                        ),
                                    })?;
                                }
                            }
                            Err(_) => {
                                state.push_event(NormalizedProviderEvent {
                                    event_type: "provider.notice.recorded".to_owned(),
                                    priority: EventPriority::P0,
                                    payload: json!({
                                        "schema": "paperclip.provider.notice.v1",
                                        "noticeId": "codex-goal-reconcile-failed",
                                        "severity": "warning",
                                        "category": "goal_reconciliation",
                                        "scope": "session",
                                        "recoverable": true,
                                        "userActionable": false,
                                        "summary": "Codex goal state could not be reconciled after the turn; Paperclip retained the last durable snapshot.",
                                    }),
                                })?;
                            }
                        }
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
                        let goal_status = state.goal.as_ref().map(|goal| goal.status.as_str());
                        state.extend_terminal_events(terminal_events(
                            state,
                            &event_type,
                            goal_status,
                        ))?;
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
                                    "adapter": if state.config.provider == "opencode" { "opencode-server" } else { "codex-app-server" },
                                    "provider": state.config.provider,
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
                                "provider": state.config.provider,
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
        self.startup_command = Some(ProviderStartupCommand {
            command_id: command.command_id.clone(),
            controller_seq: command.controller_seq,
            command_type: command.command_type.clone(),
        });
        let outcome = (|| {
            self.restore()?;
            if self
                .state
                .as_ref()
                .is_some_and(|state| state.lifecycle == "reconciliation_required")
                && !matches!(
                    command.command_type.as_str(),
                    "session.snapshot"
                        | "session.close"
                        | "session.destroy"
                        | "runner.drain"
                        | "runner.suspend"
                        | "runner.shutdown"
                        | "turn.interrupt"
                        | "run.cancel"
                        | "turn.stop"
                )
            {
                return Err(DurableRunnerError::invalid(
                    "Codex provider session requires explicit reconciliation and a fresh session",
                ));
            }
            match command.command_type.as_str() {
                "run.prepare" => self.prepare(&command.payload),
                "run.attach" => {
                    if self.state.is_none() && command.payload.get("provider").is_some() {
                        self.prepare(&command.payload)?;
                    } else {
                        self.attach_run(&command.payload)?;
                    }
                    let mut execution = self.open_session()?;
                    let provider = self
                        .state
                        .as_ref()
                        .map(|state| state.config.provider.clone())
                        .unwrap_or_else(|| "codex".to_owned());
                    execution.events.push((
                        "run.attached".to_owned(),
                        EventPriority::P0,
                        json!({"provider": provider}),
                    ));
                    Ok(execution)
                }
                "session.open" => self.open_session(),
                "turn.start" => self.start_turn(&command.payload),
                "turn.steer" => self.steer_turn(&command.payload),
                "session.goal.get" => self.get_goal(),
                "session.goal.set" => self.set_goal(&command.payload),
                "session.goal.clear" => self.clear_goal(&command.payload),
                "turn.interrupt" | "run.cancel" => self.interrupt_turn(&command.command_type),
                "turn.stop" => self.stop_turn_for_suspension(&command.command_type),
                "request.resolve" => self.resolve_request(&command.payload),
                "semantic_tool.result" => self.deliver_semantic_result(&command.payload),
                "session.snapshot" => self.snapshot(&command.payload),
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
        })();
        self.startup_command = None;
        outcome
    }

    fn rotate_authority(&mut self, config: &DurableRunnerConfig) {
        self.event_identity = Some(ProviderEventIdentity::from_config(config));
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.poll_provider()?;
        self.retained_events()
    }

    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        if let Some(error) = &self.startup_evidence_error {
            return Err(error.clone());
        }
        Ok(self
            .state
            .as_ref()
            .into_iter()
            .flat_map(|state| state.pending_events.iter())
            .cloned()
            .collect())
    }

    fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
        if self.state.as_ref().is_some_and(|state| {
            state.receipt_limit_interrupt_pending && state.active_provider_turn_id.is_some()
        }) {
            // Reuse the bounded receipt-limit cleanup poll, including reserved
            // terminal storage and terminal-before-deadline ordering. Do not
            // restore/start a provider or ingest ordinary output under ACK debt.
            self.poll_current_provider()?;
        }
        Ok(())
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
        // Terminal-result recovery can invoke shutdown on a fresh executor.
        // Loading the durable provider identity here ensures that cleanup is
        // attempted against the persisted session instead of reporting a
        // successful no-op from an empty in-memory provider slot.
        self.restore()?;
        if let Some(provider) = self.provider.as_mut() {
            provider.shutdown().map_err(|error| {
                DurableRunnerError::invalid(format!("failed to stop Codex provider: {error}"))
            })?;
        }
        self.provider = None;
        Ok(())
    }

    fn reconcile_terminal_delivery(
        &mut self,
    ) -> Result<TerminalDeliveryReconciliation, DurableRunnerError> {
        // A fresh terminal-delivery process has no provider handle. Validate
        // its retained state without starting a provider merely to stop it.
        // If this process already owns a handle, stop only that exact handle.
        if let Some(provider) = self.provider.as_mut() {
            provider.shutdown().map_err(|error| {
                DurableRunnerError::invalid(format!("failed to stop Codex provider: {error}"))
            })?;
            self.provider = None;
        }
        if self.state.is_none() {
            self.load_state_without_provider()?;
        }
        self.assert_startup_admitted()?;
        let state = self.state.as_ref().ok_or_else(|| {
            DurableRunnerError::invalid(
                "terminal delivery reconciliation requires retained provider state",
            )
        })?;
        state.validate()?;
        Ok(
            if state.lifecycle == "prepared" && state.active_provider_turn_id.is_none() {
                TerminalDeliveryReconciliation::CleanupCompleted
            } else {
                TerminalDeliveryReconciliation::ProviderCleanupPending
            },
        )
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn startup_evidence_save_failure_cannot_become_an_empty_drain_or_admission() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-startup-write-failure-{}",
            uuid::Uuid::new_v4()
        ));
        let mut executor = CodexCommandExecutor::new(&directory);
        let mut state = opencode_result_state();
        state.config.provider = "codex".to_owned();
        state.config.driver = "codex_app_server".to_owned();
        state.config.command = PathBuf::from("codex");
        state.active_provider_turn_id = None;
        state.lifecycle = "prepared".to_owned();
        executor.state = Some(state);
        executor
            .begin_startup(ProviderStartupTrigger::Ensure, 1)
            .unwrap();
        let path = executor.state_path();
        fs::rename(&path, directory.join("preserved-intent.json")).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(executor
            .observe_startup(ProviderStartupObservation::Spawned {
                process_id: 123,
                process_group_id: 123
            })
            .is_err());
        assert!(executor.retained_events().is_err());
        assert!(executor.assert_startup_admitted().is_err());
        let intent: Value =
            serde_json::from_slice(&fs::read(directory.join("preserved-intent.json")).unwrap())
                .unwrap();
        assert_eq!(intent["startupAttempt"]["phase"], "intent");
        assert_eq!(intent["startupAttempt"]["processId"], Value::Null);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_phase_fields_are_closed_and_coherent() {
        let mut attempt = ProviderStartupAttempt {
            schema: "paperclip.provider_startup.v1".to_owned(),
            launch_id: uuid::Uuid::new_v4().to_string(),
            phase: ProviderStartupPhase::Intent,
            trigger: ProviderStartupTrigger::Ensure,
            attempted_process_generation: 1,
            origin: None,
            command: None,
            configuration_fingerprint: format!("sha256:{}", "a".repeat(64)),
            requested_thread_id: None,
            authenticated_thread_id: None,
            process_id: None,
            process_group_id: None,
            failed_stage: None,
            direct_child_exit_observed: false,
            exit_code: None,
            signal: None,
            process_tree_retired: false,
        };
        attempt.validate().unwrap();
        attempt.process_id = Some(123);
        attempt.process_group_id = Some(123);
        assert!(attempt.validate().is_err());
        attempt.phase = ProviderStartupPhase::Spawned;
        attempt.validate().unwrap();
        attempt.direct_child_exit_observed = true;
        assert!(attempt.validate().is_err());
        attempt.phase = ProviderStartupPhase::InitializationFailed;
        attempt.failed_stage = Some(ProviderStartupStage::Initialize);
        assert!(attempt.validate().is_err());
        attempt.signal = Some(15);
        attempt.validate().unwrap();
        attempt.exit_code = Some(0);
        assert!(attempt.validate().is_err());
        attempt.exit_code = None;
        attempt.direct_child_exit_observed = false;
        assert!(attempt.validate().is_err());
        attempt.signal = None;
        attempt.validate().unwrap(); // Unknown cleanup is truthful, not retirement.
        attempt.origin = Some(ProviderEventIdentity {
            runner_instance_id: "r".repeat(512),
            run_id: "r".repeat(SHORT_STABLE_ID_CHARS),
            normalized_session_id: "s".repeat(SHORT_STABLE_ID_CHARS),
            turn_id: "t".repeat(DURABLE_STABLE_ID_CHARS),
            item_id: "i".repeat(DURABLE_STABLE_ID_CHARS),
        });
        attempt.requested_thread_id = Some("t".repeat(240));
        attempt.validate().unwrap();
        attempt.origin.as_mut().unwrap().turn_id.push('x');
        assert!(attempt.validate().is_err());
        attempt.origin.as_mut().unwrap().turn_id.pop();
        attempt.requested_thread_id.as_mut().unwrap().push('x');
        assert!(attempt.validate().is_err());
    }

    #[test]
    fn failed_authenticated_identity_commit_keeps_the_durable_startup_fence() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-startup-identity-commit-{}",
            uuid::Uuid::new_v4()
        ));
        let mut executor = CodexCommandExecutor::new(&directory);
        let mut state = opencode_result_state();
        state.config.provider = "codex".to_owned();
        state.config.driver = "codex_app_server".to_owned();
        state.config.command = PathBuf::from("codex");
        state.thread_id = None;
        state.active_provider_turn_id = None;
        state.lifecycle = "prepared".to_owned();
        executor.state = Some(state);
        executor
            .begin_startup(ProviderStartupTrigger::Ensure, 1)
            .unwrap();
        executor
            .observe_startup(ProviderStartupObservation::Spawned {
                process_id: 123,
                process_group_id: 123,
            })
            .unwrap();
        let path = executor.state_path();
        let preserved = directory.join("preserved-spawn.json");
        fs::rename(&path, &preserved).unwrap();
        fs::create_dir(&path).unwrap();
        let state = executor.state.as_mut().unwrap();
        state.thread_id = Some("authenticated-thread".to_owned());
        state.provider_session_id = Some("authenticated-account".to_owned());
        state.provider_process_generation = 1;
        state.lifecycle = "session_open".to_owned();
        assert!(executor.commit_startup_admission().is_err());
        assert!(executor.assert_startup_admitted().is_err());
        fs::remove_dir(&path).unwrap();
        fs::rename(preserved, &path).unwrap();
        let mut restarted = CodexCommandExecutor::new(&directory);
        let error = restarted.poll_events().unwrap_err();
        assert!(error
            .to_string()
            .contains("provider startup ownership remains unadmitted"));
        assert_eq!(restarted.state.as_ref().unwrap().thread_id, None);
        assert_eq!(
            restarted
                .state
                .as_ref()
                .unwrap()
                .provider_process_generation,
            0
        );
        assert_eq!(
            restarted
                .state
                .as_ref()
                .unwrap()
                .startup_attempt
                .as_ref()
                .unwrap()
                .phase,
            ProviderStartupPhase::Spawned
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn runtime_launch_rebinding_preserves_protected_arguments() {
        let before: Vec<String> = vec![
            "-c",
            "default_permissions=\"paperclip-runner-workspace-only\"",
            "-c",
            "shell_environment_policy.set={PATH=\"/run/a\"}",
            "--disable",
            "image_generation",
            "app-server",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let after: Vec<String> = vec![
            "-c",
            "default_permissions=\"paperclip-runner-workspace-only\"",
            "-c",
            "shell_environment_policy.set={PATH=\"/run/b\"}",
            "-c",
            "shell_environment_policy.include_only=[\"PAPERCLIP_GITHUB_BROKER_TOKEN\"]",
            "--disable",
            "image_generation",
            "app-server",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        assert_eq!(
            CodexCommandExecutor::stable_launch_args(&before),
            CodexCommandExecutor::stable_launch_args(&after)
        );
        let mut unsafe_args = after;
        unsafe_args.push("--dangerously-bypass-approvals-and-sandbox".to_owned());
        assert_ne!(
            CodexCommandExecutor::stable_launch_args(&before),
            CodexCommandExecutor::stable_launch_args(&unsafe_args)
        );
    }
    use super::*;

    fn schema_rejection(operation_id: &str, input: Value) -> ToolResult {
        let operation = crate::provider_bridge::AuthorizedTool {
            operation_id: operation_id.to_owned(),
            version: 1,
            description: "Test operation.".to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["requiredField"],
                "properties": {"requiredField": {"type": "string"}},
                "additionalProperties": false,
            }),
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
        let error = bridge
            .begin_call("schema-call".to_owned(), operation_id.to_owned(), input)
            .unwrap_err();
        invalid_tool_call_result("schema-call".to_owned(), operation_id.to_owned(), &error)
    }

    #[test]
    fn invalid_tool_results_expose_only_reserved_static_schema_guidance() {
        let finish_result = schema_rejection(
            "paperclip_finish",
            json!({"secretSubmittedValue": "must-not-appear"}),
        );
        assert_eq!(finish_result.result["error"]["code"], "invalid_tool_call");
        assert_eq!(finish_result.result["error"]["retryable"], false);
        let finish_message = finish_result.result["error"]["message"].as_str().unwrap();
        assert!(finish_message
            .contains("continuation must include kind=response_wake, summary, and idempotencyKey"));
        assert!(finish_message.len() <= 512);
        assert!(!finish_message.chars().any(char::is_control));
        assert!(!finish_result.result.to_string().contains("must-not-appear"));

        let block_result = schema_rejection("paperclip_block", json!({}));
        let block_message = block_result.result["error"]["message"].as_str().unwrap();
        assert!(block_message
            .contains("blocker must include reasonCode, owner, unblockAction, and scope"));
        assert!(block_message.len() <= 512);
        assert!(!block_message.chars().any(char::is_control));

        let ordinary_result = schema_rejection("get_task_context", json!({}));
        assert_eq!(
            ordinary_result.result["error"]["message"],
            GENERIC_INVALID_TOOL_CALL_MESSAGE
        );

        let unauthorized_error = ProviderToolBridge::default()
            .begin_call(
                "unauthorized-call".to_owned(),
                "paperclip_finish".to_owned(),
                json!({}),
            )
            .unwrap_err();
        let unauthorized_result = invalid_tool_call_result(
            "unauthorized-call".to_owned(),
            "paperclip_finish".to_owned(),
            &unauthorized_error,
        );
        assert_eq!(
            unauthorized_result.result["error"]["message"],
            GENERIC_INVALID_TOOL_CALL_MESSAGE
        );
    }

    fn opencode_result_state() -> CodexProviderState {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "opencode".to_owned(),
                driver: "opencode_server".to_owned(),
                provider_version: "1.18.29".to_owned(),
                command: PathBuf::from("node"),
                args: Vec::new(),
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: Some("openrouter/model".to_owned()),
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
                externally_sandboxed: false,
            },
            Some(CompletionContractBinding {
                revision: "revision-1".to_owned(),
                criterion_ids: vec!["criterion-1".to_owned()],
            }),
            ProviderToolBridge::default(),
        );
        state.thread_id = Some("thread-1".to_owned());
        state.active_provider_turn_id = Some("turn-1".to_owned());
        state.lifecycle = "turn_active".to_owned();
        state
    }

    fn valid_opencode_result() -> Value {
        json!({
            "schema": "paperclip.run_result.v1",
            "reportedWorkDisposition": "done",
            "summary": "Finished the requested work.",
            "completionClaim": {
                "contractRevision": "revision-1",
                "objectiveSatisfied": true,
                "criteria": [{
                    "criterionId": "criterion-1",
                    "status": "satisfied",
                    "evidenceRefs": ["provider:opencode:agent-message"],
                }],
                "remainingWork": [],
            },
            "evidence": [{"ref": "provider:opencode:agent-message"}],
            "verification": [],
            "attentionRequests": [],
            "artifacts": [],
        })
    }

    #[test]
    fn preserves_one_verified_opencode_result_before_its_terminal() {
        let mut state = opencode_result_state();
        let params = json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "semantic-result",
            "result": valid_opencode_result(),
        });

        let result_events =
            normalize_provider_notification(&mut state, "paperclip/runResult", &params).unwrap();
        let replay_events =
            normalize_provider_notification(&mut state, "paperclip/runResult", &params).unwrap();
        let terminal = terminal_events(&state, "turn.completed", None);

        assert_eq!(result_events.len(), 1);
        assert_eq!(result_events[0].event_type, "run.result.proposed");
        assert_eq!(result_events[0].priority, EventPriority::P0);
        assert!(replay_events.is_empty());
        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0].event_type, "run.terminal");
        assert_eq!(terminal[0].payload["reportedWorkDisposition"], "done");
        assert!(state.validate().is_ok());
    }

    #[test]
    fn stopped_prepared_checkpoint_rebinds_without_restarting_its_old_provider() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-provider-stopped-checkpoint-rebind-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let mut state = opencode_result_state();
        state.config.provider = "codex".to_owned();
        state.config.driver = "codex_app_server".to_owned();
        state.config.command = PathBuf::from("must-not-start-during-attachment");
        state.config.model = None;
        state.active_provider_turn_id = None;
        state.provider_process_generation = 1;
        state.lifecycle = "prepared".to_owned();
        let writer = CodexCommandExecutor::new(&directory);
        writer.persist_state(&state).unwrap();
        let mut executor = CodexCommandExecutor::new(&directory);
        executor.restore().unwrap();
        assert!(executor.provider.is_none());
        executor.attach_run(&json!({})).unwrap();
        assert!(executor.provider.is_none());
        let rebound = executor.state.as_ref().unwrap();
        assert_eq!(rebound.lifecycle, "prepared");
        assert_eq!(rebound.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(rebound.provider_process_generation, 1);
        assert!(rebound.pending_events.is_empty());
        assert!(rebound.queued_events.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stopped_checkpoint_rebinding_keeps_unsettled_and_missing_process_fences() {
        let mut settled = opencode_result_state();
        settled.config.provider = "codex".to_owned();
        settled.config.driver = "codex_app_server".to_owned();
        settled.config.command = PathBuf::from("must-not-start-during-attachment");
        settled.config.model = None;
        settled.active_provider_turn_id = None;
        settled.provider_process_generation = 1;
        settled.lifecycle = "prepared".to_owned();
        for change in [
            "closed",
            "session_open",
            "active",
            "ambiguous",
            "pending",
            "queued",
            "thread_missing",
            "generation_missing",
            "profile_changed",
        ] {
            let mut state = settled.clone();
            let mut payload = json!({});
            match change {
                "closed" | "session_open" => state.lifecycle = change.to_owned(),
                "active" => state.active_provider_turn_id = Some("still-active".to_owned()),
                "ambiguous" => state.ambiguous_turn_start_pending = true,
                "pending" | "queued" => {
                    let event = PolledEvent {
                        executor_event_id: "undelivered-result".to_owned(),
                        event_type: "run.result.proposed".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({}),
                    };
                    if change == "pending" {
                        state.pending_events.push_back(event);
                    } else {
                        state.queued_events.push_back(event);
                    }
                }
                "thread_missing" => state.thread_id = None,
                "generation_missing" => state.provider_process_generation = 0,
                "profile_changed" => {
                    let mut config = state.config.clone();
                    config.model = Some("different-model".to_owned());
                    payload = json!({"provider": config});
                }
                _ => unreachable!(),
            }
            let before = serde_json::to_value(&state).unwrap();
            let mut executor =
                CodexCommandExecutor::new(PathBuf::from("unused-rejected-attachment"));
            executor.state = Some(state);
            assert!(
                executor.attach_run(&payload).is_err(),
                "must reject {change}"
            );
            assert!(executor.provider.is_none());
            assert_eq!(
                serde_json::to_value(executor.state.as_ref().unwrap()).unwrap(),
                before
            );
        }
    }

    #[test]
    fn accepted_terminal_tool_suppresses_the_generated_terminal_fallback() {
        let mut state = opencode_result_state();
        let mut result = valid_opencode_result();
        result["reportedWorkDisposition"] = json!("needs_review");
        result.as_object_mut().unwrap().remove("attentionRequests");
        result.as_object_mut().unwrap().remove("artifacts");

        admit_terminal_tool_authority(&mut state, "paperclip_finish", &result, false).unwrap();
        let terminal = terminal_events(&state, "turn.completed", None);

        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0].event_type, "run.terminal");
        assert_eq!(
            terminal[0].payload["reportedWorkDisposition"],
            "needs_review"
        );
        assert!(state.validate().is_ok());
    }

    #[test]
    fn accepted_terminal_tool_preserves_an_explicit_response_wait() {
        let mut state = opencode_result_state();
        let mut result = valid_opencode_result();
        result["reportedWorkDisposition"] = json!("yielded");
        result["continuation"] = json!({
            "kind": "response_wake",
            "summary": "Wait for the next response.",
            "idempotencyKey": "response-wake-1"
        });

        admit_terminal_tool_authority(&mut state, "paperclip_finish", &result, false).unwrap();
        let terminal = terminal_events(&state, "turn.completed", None);

        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0].payload["reportedWorkDisposition"], "yielded");
        assert!(state.validate().is_ok());
    }

    #[test]
    fn terminal_tool_authority_rejects_an_unbound_yield() {
        let mut state = opencode_result_state();
        let mut result = valid_opencode_result();
        result["reportedWorkDisposition"] = json!("yielded");
        result["continuation"] = json!({
            "kind": "same_agent",
            "summary": "Continue immediately.",
            "idempotencyKey": "same-agent-1"
        });

        assert!(
            admit_terminal_tool_authority(&mut state, "paperclip_finish", &result, false,).is_err()
        );
    }

    #[test]
    fn accepted_terminal_tool_remains_successful_after_controller_interrupt() {
        let mut state = opencode_result_state();
        let result = valid_opencode_result();

        admit_terminal_tool_authority(&mut state, "paperclip_finish", &result, false).unwrap();
        let terminal = terminal_events(&state, "turn.interrupted", None);

        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0].event_type, "run.terminal");
        assert_eq!(terminal[0].payload["runTerminalState"], "succeeded");
        assert_eq!(terminal[0].payload["turnTerminalState"], "completed");
        assert_eq!(terminal[0].payload["reportedWorkDisposition"], "done");
        assert!(state.validate().is_ok());
    }

    #[test]
    fn codex_terminal_tool_authority_is_valid_durable_state() {
        let mut state = opencode_result_state();
        state.config.provider = "codex".to_owned();
        state.config.driver = "codex_app_server".to_owned();
        state.config.provider_version = "test".to_owned();

        admit_terminal_tool_authority(
            &mut state,
            "paperclip_finish",
            &valid_opencode_result(),
            false,
        )
        .unwrap();

        assert_eq!(
            state.active_provider_result_disposition.as_deref(),
            Some("done")
        );
        assert!(state.validate().is_ok());
    }

    #[test]
    fn terminal_tool_authority_rejects_an_incompatible_disposition() {
        let mut state = opencode_result_state();

        assert!(admit_terminal_tool_authority(
            &mut state,
            "paperclip_block",
            &valid_opencode_result(),
            false,
        )
        .unwrap_err()
        .to_string()
        .contains("incompatible work disposition"));
        assert!(state.active_provider_result_fingerprint.is_none());
    }

    #[test]
    fn rejects_unbound_conflicting_or_spoofed_opencode_results() {
        let params = |result: Value| {
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "semantic-result",
                "result": result,
            })
        };

        let mut wrong_revision = opencode_result_state();
        let mut result = valid_opencode_result();
        result["completionClaim"]["contractRevision"] = json!("revision-2");
        assert!(normalize_provider_notification(
            &mut wrong_revision,
            "paperclip/runResult",
            &params(result),
        )
        .unwrap_err()
        .to_string()
        .contains("contract revision"));

        let mut malformed = opencode_result_state();
        assert!(normalize_provider_notification(
            &mut malformed,
            "paperclip/runResult",
            &params(json!({"schema": "paperclip.run_result.v1"})),
        )
        .unwrap_err()
        .to_string()
        .contains("failed the Paperclip result schema"));

        let mut wrong_criteria = opencode_result_state();
        let mut result = valid_opencode_result();
        result["completionClaim"]["criteria"][0]["criterionId"] = json!("criterion-2");
        assert!(normalize_provider_notification(
            &mut wrong_criteria,
            "paperclip/runResult",
            &params(result),
        )
        .unwrap_err()
        .to_string()
        .contains("bound completion criteria"));

        let mut conflicting = opencode_result_state();
        normalize_provider_notification(
            &mut conflicting,
            "paperclip/runResult",
            &params(valid_opencode_result()),
        )
        .unwrap();
        let mut result = valid_opencode_result();
        result["summary"] = json!("A conflicting second result.");
        assert!(normalize_provider_notification(
            &mut conflicting,
            "paperclip/runResult",
            &params(result),
        )
        .unwrap_err()
        .to_string()
        .contains("conflicting"));

        let mut spoofed = opencode_result_state();
        spoofed.config.provider = "codex".to_owned();
        assert!(normalize_provider_notification(
            &mut spoofed,
            "paperclip/runResult",
            &params(valid_opencode_result()),
        )
        .unwrap_err()
        .to_string()
        .contains("reserved for the verified OpenCode provider"));
    }

    #[test]
    fn opencode_terminal_fallback_uses_its_actual_provider_identity() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "opencode".to_owned(),
                driver: "opencode_server".to_owned(),
                provider_version: "1.18.29".to_owned(),
                command: PathBuf::from("node"),
                args: Vec::new(),
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: Some("openrouter/model".to_owned()),
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
                externally_sandboxed: false,
            },
            Some(CompletionContractBinding {
                revision: "revision-1".to_owned(),
                criterion_ids: vec!["criterion-1".to_owned()],
            }),
            ProviderToolBridge::default(),
        );
        state.last_agent_message = None;

        let events = terminal_events(&state, "turn.completed", None);

        assert_eq!(
            events[0].payload["summary"],
            "OpenCode completed the requested work."
        );
        assert_eq!(
            events[0].payload["evidence"][0]["ref"],
            "provider:opencode:agent-message"
        );
        assert_eq!(events[1].payload["provider"], "opencode");
        assert!(!events[0].payload.to_string().contains("Codex"));
    }

    #[test]
    fn goal_timestamps_normalize_seconds_milliseconds_and_iso() {
        for value in [
            json!(1_788_825_600),
            json!(1_788_825_600_000_i64),
            json!("2026-09-08T00:00:00.000Z"),
        ] {
            assert_eq!(
                goal_timestamp(Some(&value)).as_deref(),
                Some("2026-09-08T00:00:00Z")
            );
        }
        assert_eq!(goal_timestamp(Some(&json!("invalid"))), None);
        assert_eq!(goal_timestamp(Some(&Value::Null)), None);
    }

    #[test]
    fn goal_snapshot_serializes_required_nullable_fields() {
        let goal = SessionGoalSnapshot {
            objective: "Finish the durable goal.".to_owned(),
            status: "active".to_owned(),
            token_budget: None,
            tokens_used: 0,
            elapsed_seconds: 0,
            iterations: 0,
            last_reason: None,
            created_at: None,
            updated_at: None,
            completed_at: None,
            working_now: true,
        };

        let payload = goal_event_payload(Some(&goal), None, 1);

        for path in [
            "/goal/tokenBudget",
            "/goal/lastReason",
            "/goal/createdAt",
            "/goal/updatedAt",
            "/goal/completedAt",
        ] {
            assert_eq!(payload.pointer(path), Some(&Value::Null), "{path}");
        }
    }

    #[test]
    fn rejects_inconsistent_provider_state() {
        let state = CodexProviderState {
            startup_attempt: None,
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
                externally_sandboxed: false,
            },
            opencode_launch_profile_digest: None,
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
            descendant_thread_ids: std::collections::BTreeSet::new(),
            settled_provider_turn_filter: DurableReplayFilter::default(),
            receipt_limit_diagnostic_emitted: false,
            receipt_limit_interrupt_pending: false,
            receipt_limit_interrupt_accepted: false,
            receipt_limit_interrupt_attempts: 0,
            receipt_limit_interrupt_deadline_unix_ms: None,
            active_provider_result_fingerprint: None,
            active_provider_result_disposition: None,
            last_agent_message: None,
            goal_capability: None,
            goal: None,
            goal_revision: default_goal_revision(),
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
                externally_sandboxed: false,
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
                externally_sandboxed: false,
            },
            Some(CompletionContractBinding {
                revision: "1".to_owned(),
                criterion_ids: vec!["objective".to_owned()],
            }),
            ProviderToolBridge::default(),
        );
        state.last_agent_message = Some("Finished the requested work.".to_owned());
        let events = terminal_events(&state, "turn.completed", None);
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
        let event = semantic_input_event(&identity, &call).unwrap();
        let transmitted = &event.payload["semantic_tool"]["input"];
        assert_eq!(transmitted["password"], "[REDACTED]");
        assert_eq!(
            event.payload["semantic_tool"]["content"]["digest"],
            semantic_value_digest(transmitted)
        );
    }

    #[test]
    fn semantic_finish_input_preserves_a_complete_long_redacted_summary() {
        let identity = ProviderEventIdentity {
            runner_instance_id: "runner-1".to_owned(),
            run_id: "run-1".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            item_id: "item-1".to_owned(),
        };
        let summary = format!(
            "token=do-not-persist {} Authorization: Bearer late-provider-secret COMPLETE-LONG-SUMMARY",
            "A complete paragraph for the user. ".repeat(180)
        );
        assert!(summary.len() > 4_096);
        let call = PendingToolCall {
            call_id: "call-1".to_owned(),
            operation_id: "paperclip_finish".to_owned(),
            input: json!({"summary": summary}),
        };

        let event = semantic_input_event(&identity, &call).unwrap();
        let transmitted = &event.payload["semantic_tool"]["input"];
        let transmitted_summary = transmitted["summary"].as_str().unwrap();
        assert!(transmitted_summary.starts_with("token=[REDACTED] "));
        assert!(transmitted_summary.ends_with(" COMPLETE-LONG-SUMMARY"));
        assert!(!transmitted_summary.contains("do-not-persist"));
        assert!(!transmitted_summary.contains("late-provider-secret"));
        assert!(transmitted_summary.contains("Authorization: Bearer [REDACTED]"));
        assert!(!transmitted_summary.contains("…[truncated]"));
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
                externally_sandboxed: false,
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
                externally_sandboxed: false,
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
                externally_sandboxed: false,
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
                externally_sandboxed: false,
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
                .push_event(semantic_input_event(&identity, &call).unwrap())
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
                externally_sandboxed: false,
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
                externally_sandboxed: false,
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
                externally_sandboxed: false,
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
                externally_sandboxed: false,
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
                externally_sandboxed: false,
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
                externally_sandboxed: false,
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

        // ACK debt must still advance an already-pending cleanup deadline,
        // without restoring/starting a process or releasing retained events.
        executor.maintain_backpressured_provider().unwrap();

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
        let settled = serde_json::to_value(state).unwrap();
        executor.maintain_backpressured_provider().unwrap();
        assert_eq!(
            serde_json::to_value(executor.state.as_ref().unwrap()).unwrap(),
            settled
        );
        assert!(executor.provider.is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
