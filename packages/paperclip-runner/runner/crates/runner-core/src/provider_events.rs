use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::acpx_event_payload::{AcpxRuntimeEventKind, AcpxTurnStatus};
use crate::acpx_provider_state::{is_reserved_terminal_operation, AcpxProviderStateEvent};
use crate::durable::{redact_text, sanitize_value, EventPriority};
use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::{semantic_value_digest, ToolResult};
use crate::stable_identity::{
    is_stable_id, project_acpx_runtime_request_id, DURABLE_STABLE_ID_CHARS, SHORT_STABLE_ID_CHARS,
};

const MAX_TEXT_CHARS: usize = 4_000;

#[derive(Clone, Debug, PartialEq)]
pub struct NormalizedProviderEvent {
    pub event_type: String,
    pub priority: EventPriority,
    pub payload: Value,
}

pub(crate) fn normalized_codex_terminal_event_type(
    method: &str,
    params: &Value,
) -> Option<&'static str> {
    let status = match method {
        "turn/failed" => "failed",
        "turn/cancelled" => "cancelled",
        "turn/interrupted" => "interrupted",
        "turn/completed" => string(
            params
                .pointer("/turn/status")
                .or_else(|| params.get("status")),
        ),
        _ => return None,
    };
    Some(match status {
        "failed" | "error" => "turn.failed",
        "cancelled" | "canceled" => "turn.cancelled",
        "interrupted" | "aborted" => "turn.interrupted",
        _ => "turn.completed",
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcpxEventProjectionContext {
    pub run_id: String,
    pub normalized_session_id: String,
    pub turn_id: String,
    pub item_id: String,
}

impl AcpxEventProjectionContext {
    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        for (value, label, max_chars) in [
            (&self.run_id, "run", SHORT_STABLE_ID_CHARS),
            (
                &self.normalized_session_id,
                "normalized session",
                SHORT_STABLE_ID_CHARS,
            ),
            // Turn and item correlation use the durable 240-character
            // identity contract shared by PRP events, runtime requests, and
            // semantic-tool receipts.
            (&self.turn_id, "turn", DURABLE_STABLE_ID_CHARS),
            (&self.item_id, "item", DURABLE_STABLE_ID_CHARS),
        ] {
            validate_projection_identity(value, label, max_chars)?;
        }
        Ok(())
    }

    fn correlation(&self) -> Value {
        json!({
            "runId": self.run_id,
            "normalizedSessionId": self.normalized_session_id,
            "turnId": self.turn_id,
            "itemId": self.item_id,
        })
    }
}

/// Projects already scope-checked ACPX reducer output into provider-neutral
/// durable events. The reducer remains authoritative for bounds and request
/// state; this boundary must not accept raw sidecar envelopes.
pub fn project_acpx_state_event(
    context: &AcpxEventProjectionContext,
    event: &AcpxProviderStateEvent,
) -> Result<Vec<NormalizedProviderEvent>, LocalRunnerError> {
    context.validate()?;
    let one = |event_type: &str, priority: EventPriority, payload: Value| {
        Ok(vec![NormalizedProviderEvent {
            event_type: event_type.to_owned(),
            priority,
            payload,
        }])
    };
    match event {
        AcpxProviderStateEvent::Activity(event) => Ok(vec![event.clone()]),
        AcpxProviderStateEvent::ToolCall {
            call_id,
            operation_id,
            input,
        } => {
            validate_semantic_projection_identity(call_id, operation_id)?;
            one(
                "semantic_tool.input",
                EventPriority::P0,
                json!({
                    "semantic_tool": {
                        "schema": "paperclip.prp.semantic_tool.v1",
                        "schemaVersion": 1,
                        "phase": "input",
                        "operationId": operation_id,
                        "callId": call_id,
                        "correlation": context.correlation(),
                        "idempotencyKey": Value::Null,
                        "content": {
                            "digest": semantic_value_digest(input),
                            "redactionDisposition": "digest_only",
                            "references": [],
                        },
                        "input": input,
                    },
                }),
            )
        }
        AcpxProviderStateEvent::ToolResult(result) => {
            Ok(vec![project_acpx_tool_result(context, result)?])
        }
        AcpxProviderStateEvent::PermissionRequest { .. } => Err(LocalRunnerError::invalid(
            "ACPX permission request reached projection outside the pinned runner policy",
        )),
        AcpxProviderStateEvent::InputRequest {
            request_id,
            question_set,
            origin,
        } => {
            let request_id = project_acpx_runtime_request_id(request_id).ok_or_else(|| {
                LocalRunnerError::invalid("ACPX event projection request identity is invalid")
            })?;
            let prompt = question_set
                .get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    question_set
                        .pointer("/questions/0/prompt")
                        .and_then(Value::as_str)
                })
                .map(|value| bounded_text(value, MAX_TEXT_CHARS))
                .unwrap_or_else(|| "Codex needs your input".to_owned());
            let origin = project_runtime_request_origin(origin.as_ref())?;
            one(
                "runtime_request.created",
                EventPriority::P0,
                json!({
                    "request": {
                        "schema": "paperclip.runtime_request.v2",
                        "requestKind": "runtime",
                        "requestId": request_id,
                        "turnId": context.turn_id,
                        "itemId": context.item_id,
                        "type": "input",
                        "status": "pending",
                        "prompt": prompt,
                        "input": question_set,
                        "origin": origin,
                    },
                }),
            )
        }
        AcpxProviderStateEvent::SemanticResult(result) => {
            validate_semantic_projection_identity(&result.call_id, &result.operation_id)?;
            if is_reserved_terminal_operation(&result.operation_id) {
                one(
                    "run.result.proposed",
                    EventPriority::P0,
                    result.result.clone(),
                )
            } else {
                Ok(vec![project_acpx_tool_result(
                    context,
                    &ToolResult {
                        call_id: result.call_id.clone(),
                        operation_id: result.operation_id.clone(),
                        result: result.result.clone(),
                        is_error: !result.ok,
                    },
                )?])
            }
        }
        AcpxProviderStateEvent::AssistantMessage { turn_id, text } => {
            require_projected_turn(context, turn_id)?;
            one(
                "item.completed",
                EventPriority::P1,
                json!({
                    "provider": "acpx",
                    "itemId": context.item_id,
                    "kind": "agentMessage",
                    "status": "completed",
                    "channel": "final",
                    "text": bounded_text(text, MAX_TEXT_CHARS),
                }),
            )
        }
        AcpxProviderStateEvent::TurnTerminal {
            turn_id,
            status,
            error,
        } => {
            require_projected_turn(context, turn_id)?;
            let (event_type, status) = match status {
                AcpxTurnStatus::Completed => ("turn.completed", "completed"),
                AcpxTurnStatus::Failed => ("turn.failed", "failed"),
                AcpxTurnStatus::Cancelled => ("turn.cancelled", "cancelled"),
                AcpxTurnStatus::Interrupted => ("turn.interrupted", "interrupted"),
            };
            one(
                event_type,
                EventPriority::P0,
                json!({
                    "provider": "acpx",
                    "providerTurnId": turn_id,
                    "status": status,
                    "error": error,
                }),
            )
        }
        AcpxProviderStateEvent::Process(details) => one(
            "harness.diagnostic",
            EventPriority::P1,
            json!({
                "code": "acpx_process",
                "message": "The ACPX sidecar reported provider process metadata.",
                "details": details,
            }),
        ),
        AcpxProviderStateEvent::Diagnostic { code, message } => one(
            "harness.diagnostic",
            EventPriority::P1,
            json!({"code": code, "message": bounded_text(message, MAX_TEXT_CHARS)}),
        ),
    }
}

fn project_acpx_tool_result(
    context: &AcpxEventProjectionContext,
    result: &ToolResult,
) -> Result<NormalizedProviderEvent, LocalRunnerError> {
    validate_semantic_projection_identity(&result.call_id, &result.operation_id)?;
    let safe_result = sanitize_value(&result.result);
    Ok(NormalizedProviderEvent {
        event_type: "semantic_tool.result".to_owned(),
        priority: EventPriority::P0,
        payload: json!({
            "semantic_tool": {
                "schema": "paperclip.prp.semantic_tool.v1",
                "schemaVersion": 1,
                "phase": "result",
                "operationId": result.operation_id,
                "callId": result.call_id,
                "correlation": context.correlation(),
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
            },
        }),
    })
}

fn validate_semantic_projection_identity(
    call_id: &str,
    operation_id: &str,
) -> Result<(), LocalRunnerError> {
    for (value, label) in [(call_id, "call"), (operation_id, "operation")] {
        if !is_stable_id(value, SHORT_STABLE_ID_CHARS) {
            return Err(LocalRunnerError::invalid(format!(
                "ACPX semantic {label} identity is invalid"
            )));
        }
    }
    Ok(())
}

fn project_runtime_request_origin(origin: Option<&Value>) -> Result<Value, LocalRunnerError> {
    let Some(origin) = origin else {
        return Ok(json!({
            "adapter": "codex-acpx",
            "provider": "acpx",
            "method": "item/tool/requestUserInput",
        }));
    };
    let object = origin.as_object().ok_or_else(|| {
        LocalRunnerError::invalid("ACPX runtime request origin must be an object")
    })?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "adapter" | "provider" | "method"))
    {
        return Err(LocalRunnerError::invalid(
            "ACPX runtime request origin contains unsupported fields",
        ));
    }
    validate_origin_field(object.get("adapter"), "adapter", 160, true)?;
    validate_origin_field(object.get("provider"), "provider", 160, false)?;
    validate_origin_field(object.get("method"), "method", 500, false)?;
    Ok(origin.clone())
}

fn validate_origin_field(
    value: Option<&Value>,
    field: &str,
    max_chars: usize,
    required: bool,
) -> Result<(), LocalRunnerError> {
    let Some(value) = value else {
        if required {
            return Err(LocalRunnerError::invalid(format!(
                "ACPX runtime request origin omitted {field}"
            )));
        }
        return Ok(());
    };
    let text = value.as_str().ok_or_else(|| {
        LocalRunnerError::invalid(format!("ACPX runtime request origin {field} must be text"))
    })?;
    if text.is_empty() || text.chars().count() > max_chars {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX runtime request origin {field} is invalid"
        )));
    }
    Ok(())
}

fn validate_projection_identity(
    value: &str,
    label: &str,
    max_chars: usize,
) -> Result<(), LocalRunnerError> {
    if !is_stable_id(value, max_chars) {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX event projection {label} identity is invalid"
        )));
    }
    Ok(())
}

fn require_projected_turn(
    context: &AcpxEventProjectionContext,
    turn_id: &str,
) -> Result<(), LocalRunnerError> {
    if turn_id != context.turn_id {
        return Err(LocalRunnerError::invalid(
            "ACPX state event does not match its durable turn projection",
        ));
    }
    Ok(())
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    redact_text(value).chars().take(max_chars).collect()
}

fn string(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn stable_id(value: &str, fallback: &str) -> String {
    let value: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "._:-".contains(character) {
                character
            } else {
                '-'
            }
        })
        .take(160)
        .collect();
    if value
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric())
    {
        value
    } else {
        fallback.to_owned()
    }
}

fn item(params: &Value) -> &Value {
    params.get("item").unwrap_or(&Value::Null)
}

fn provider_status(value: &str, completed: bool) -> &'static str {
    match value {
        "failed" | "error" => "failed",
        "cancelled" | "canceled" => "cancelled",
        "interrupted" | "aborted" => "interrupted",
        _ if completed => "completed",
        _ => "running",
    }
}

fn bounded_output(value: &str) -> Value {
    let output = redact_text(value);
    let output_truncated = output != value;
    json!({
        "output": output,
        "outputBytes": value.len(),
        "outputTruncated": output_truncated,
        "outputDigest": format!("sha256:{:x}", Sha256::digest(value.as_bytes())),
    })
}

fn measurement(value: &Value) -> Value {
    json!({
        "inputTokens": value.get("inputTokens").and_then(Value::as_u64).unwrap_or(0),
        "outputTokens": value.get("outputTokens").and_then(Value::as_u64).unwrap_or(0),
        "cacheReadTokens": value.get("cachedInputTokens").or_else(|| value.get("cacheReadTokens")).and_then(Value::as_u64).unwrap_or(0),
        "cacheWriteTokens": value.get("cacheWriteTokens").and_then(Value::as_u64).unwrap_or(0),
        "activeSeconds": value.get("activeSeconds").and_then(Value::as_f64).filter(|value| *value >= 0.0).unwrap_or(0.0),
        "requests": value.get("requests").and_then(Value::as_u64).unwrap_or(0),
        "providerCostUsd": value.get("providerCostUsd").and_then(Value::as_f64).filter(|value| *value >= 0.0).unwrap_or(0.0),
    })
}

/// Converts Codex app-server notifications into provider-neutral PRP events.
/// Provider-native envelopes are consumed here and never cross the PRP boundary.
pub fn normalize_codex_notification(method: &str, params: &Value) -> Vec<NormalizedProviderEvent> {
    let mut events = Vec::new();
    let push = |events: &mut Vec<NormalizedProviderEvent>,
                event_type: &str,
                priority: EventPriority,
                payload: Value| {
        events.push(NormalizedProviderEvent {
            event_type: event_type.to_owned(),
            priority,
            payload,
        });
    };

    match method {
        "thread/compacted" => push(
            &mut events,
            "context.compacted",
            EventPriority::P1,
            json!({
                "schema": "paperclip.context.compacted.v1",
                "compactionId": stable_id(string(params.get("threadId")), "codex-compaction"),
                "reason": "provider",
                "preTokens": Value::Null,
                "postTokens": Value::Null,
                "sameSession": true,
            }),
        ),
        "turn/started" => push(
            &mut events,
            "turn.started",
            EventPriority::P0,
            json!({
                "provider": "codex",
                "providerTurnId": params.pointer("/turn/id").or_else(|| params.get("turnId")).and_then(Value::as_str),
            }),
        ),
        "turn/completed" | "turn/failed" | "turn/cancelled" | "turn/interrupted" => {
            let status = match method {
                "turn/failed" => "failed",
                "turn/cancelled" => "cancelled",
                "turn/interrupted" => "interrupted",
                _ => string(
                    params
                        .pointer("/turn/status")
                        .or_else(|| params.get("status")),
                ),
            };
            let event_type = normalized_codex_terminal_event_type(method, params)
                .expect("matched Codex terminal method has a normalized terminal type");
            push(
                &mut events,
                event_type,
                EventPriority::P0,
                json!({
                    "provider": "codex",
                    "providerTurnId": params.pointer("/turn/id").or_else(|| params.get("turnId")).and_then(Value::as_str),
                    "status": provider_status(status, true),
                }),
            );
        }
        "turn/plan/updated" => {
            let plan_id = stable_id(string(params.get("turnId")), "codex-plan");
            let steps = params
                .get("plan")
                .and_then(Value::as_array)
                .map(|steps| {
                    steps
                        .iter()
                        .take(256)
                        .enumerate()
                        .filter_map(|(index, step)| {
                            let body = bounded_text(string(step.get("step")), MAX_TEXT_CHARS);
                            if body.trim().is_empty() {
                                return None;
                            }
                            Some(json!({
                                "stepId": format!("step-{}", index + 1),
                                "body": body,
                                "status": match string(step.get("status")) {
                                    "inProgress" | "in_progress" => "in_progress",
                                    "completed" => "completed",
                                    "blocked" | "failed" | "error" => "blocked",
                                    _ => "pending",
                                },
                            }))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let complete = !steps.is_empty()
                && steps
                    .iter()
                    .all(|step| step.get("status").and_then(Value::as_str) == Some("completed"));
            push(
                &mut events,
                "plan.updated",
                EventPriority::P1,
                json!({
                    "schema": "paperclip.plan.updated.v1",
                    "planId": plan_id,
                    "revision": params.get("revision").and_then(Value::as_u64).filter(|value| *value > 0).unwrap_or(1),
                    "explanation": params.get("explanation").and_then(Value::as_str).map(|value| bounded_text(value, MAX_TEXT_CHARS)),
                    "steps": steps,
                    "complete": complete,
                    "syncStatus": "not_applicable",
                    "documentRevision": Value::Null,
                }),
            );
        }
        "thread/tokenUsage/updated" => {
            let cumulative = params
                .get("tokenUsage")
                .and_then(|value| value.get("total"))
                .or_else(|| params.get("total"))
                .unwrap_or(&Value::Null);
            let run_delta = params
                .get("tokenUsage")
                .and_then(|value| value.get("last"))
                .or_else(|| params.get("last"));
            push(
                &mut events,
                "usage.reported",
                EventPriority::P0,
                json!({
                    "provider": "codex",
                    "model": params.get("model").and_then(Value::as_str).map(|value| bounded_text(value, 240)),
                    "providerSessionId": params.get("threadId").and_then(Value::as_str).map(|value| bounded_text(value, 240)),
                    "providerRequestId": Value::Null,
                    "cumulative": measurement(cumulative),
                    // `total` is session-cumulative. Preserve whether Codex
                    // supplied a per-run delta so consumers never relabel a
                    // session total or a placeholder zero as run usage.
                    "runDeltaAvailable": run_delta.is_some(),
                    "runDelta": measurement(run_delta.unwrap_or(&Value::Null)),
                }),
            );
        }
        "error" | "warning" | "deprecationNotice" | "configWarning" => push(
            &mut events,
            "provider.notice.recorded",
            EventPriority::P0,
            json!({
                "schema": "paperclip.provider.notice.v1",
                "noticeId": stable_id(&format!("codex-{method}"), "codex-notice"),
                "severity": if method == "error" { "error" } else { "warning" },
                "category": method.replace('/', "_"),
                "scope": if method.contains("config") { "environment" } else { "turn" },
                "recoverable": method != "error",
                "userActionable": true,
                "summary": bounded_text(string(params.get("message")), MAX_TEXT_CHARS),
            }),
        ),
        "item/agentMessage/delta" => push(
            &mut events,
            "item.delta",
            EventPriority::P2,
            json!({
                "provider": "codex",
                "itemId": stable_id(string(params.get("itemId")), "codex-message"),
                "kind": "agentMessage",
                "channel": "progress",
                "providerMethod": method,
                "text": bounded_text(string(params.get("delta")), MAX_TEXT_CHARS),
            }),
        ),
        "item/started" | "item/completed" => {
            let provider_item = item(params);
            let item_id = stable_id(string(provider_item.get("id")), "codex-item");
            let item_type = string(provider_item.get("type"));
            let completed = method == "item/completed";
            if matches!(item_type, "commandExecution" | "mcpToolCall") {
                let mut payload = json!({
                    "schema": "paperclip.tool.execution.v1",
                    "executionId": item_id,
                    "transport": if item_type == "mcpToolCall" { "mcp" } else { "process" },
                    "operation": if item_type == "commandExecution" { "execute" } else { "unknown" },
                    "name": provider_item.get("tool").or_else(|| provider_item.get("command")).and_then(Value::as_str).map(|value| bounded_text(value, 240)),
                    "target": Value::Null,
                    "namespace": provider_item.get("server").and_then(Value::as_str).map(|value| bounded_text(value, 240)),
                    "readOnly": provider_item.get("readOnlyHint").and_then(Value::as_bool),
                    "status": provider_status(string(provider_item.get("status")), completed),
                    "durationMs": provider_item.get("durationMs").and_then(Value::as_u64),
                    "exitCode": provider_item.get("exitCode").and_then(Value::as_i64),
                    "progress": Value::Null,
                });
                if let (Some(object), Value::Object(output)) = (
                    payload.as_object_mut(),
                    bounded_output(string(
                        provider_item
                            .get("aggregatedOutput")
                            .or_else(|| provider_item.get("output")),
                    )),
                ) {
                    object.extend(output);
                }
                push(
                    &mut events,
                    if completed {
                        "tool.execution.completed"
                    } else {
                        "tool.execution.started"
                    },
                    if completed {
                        EventPriority::P1
                    } else {
                        EventPriority::P2
                    },
                    payload,
                );
            } else {
                push(
                    &mut events,
                    if completed {
                        "item.completed"
                    } else {
                        "item.started"
                    },
                    if completed {
                        EventPriority::P1
                    } else {
                        EventPriority::P2
                    },
                    json!({
                        "provider": "codex",
                        "itemId": item_id,
                        "kind": bounded_text(item_type, 160),
                        "status": provider_status(string(provider_item.get("status")), completed),
                        "channel": if item_type == "agentMessage" { "progress" } else { "detail" },
                        "text": provider_item.get("text").and_then(Value::as_str).map(|value| bounded_text(value, MAX_TEXT_CHARS)),
                    }),
                );
            }
        }
        _ => {}
    }

    events
}

/// Converts an already scope-checked and payload-validated ACPX runtime event
/// into provider-neutral PRP activity. Operational events such as semantic
/// results and turn completion remain owned by the stateful provider adapter.
/// That adapter also suppresses repeated reasoning-start boundaries in a turn.
pub fn normalize_acpx_runtime_event(
    kind: AcpxRuntimeEventKind,
    payload: &Value,
    tool_operation: Option<&str>,
    fallback_item_id: &str,
    turn_id: &str,
    provider_requests: u64,
) -> Vec<NormalizedProviderEvent> {
    let item_id = stable_id(
        match kind {
            AcpxRuntimeEventKind::ToolCall => string(payload.get("toolCallId")),
            AcpxRuntimeEventKind::Plan => turn_id,
            _ => string(payload.get("messageId")),
        },
        fallback_item_id,
    );
    match kind {
        AcpxRuntimeEventKind::TextDelta => vec![NormalizedProviderEvent {
            event_type: "item.delta".to_owned(),
            priority: EventPriority::P2,
            payload: json!({
                "provider": "acpx",
                "itemId": item_id,
                "kind": "agentMessage",
                "channel": "progress",
                "providerMethod": "runtime.event",
                "text": bounded_text(string(payload.get("text")), MAX_TEXT_CHARS),
            }),
        }],
        AcpxRuntimeEventKind::Thinking => vec![NormalizedProviderEvent {
            event_type: "item.started".to_owned(),
            priority: EventPriority::P2,
            payload: json!({
                "provider": "acpx",
                "itemId": item_id,
                "kind": "reasoning",
                "status": "running",
                "channel": "detail",
                "text": Value::Null,
            }),
        }],
        AcpxRuntimeEventKind::Plan => normalize_acpx_plan(payload, &item_id),
        AcpxRuntimeEventKind::Status => {
            normalize_acpx_status(payload, &item_id, turn_id, provider_requests)
        }
        AcpxRuntimeEventKind::ToolCall => {
            normalize_acpx_tool_call(payload, &item_id, tool_operation.unwrap_or("unknown"))
        }
        AcpxRuntimeEventKind::ProviderNotice => vec![acpx_notice(
            &item_id,
            string(payload.get("severity")),
            string(payload.get("category")),
            string(payload.get("summary")),
            false,
        )],
        AcpxRuntimeEventKind::Error => vec![acpx_notice(
            &item_id,
            "error",
            string(payload.get("code")),
            string(payload.get("message")),
            true,
        )],
        AcpxRuntimeEventKind::SemanticResult | AcpxRuntimeEventKind::Done => Vec::new(),
    }
}

fn normalize_acpx_plan(payload: &Value, plan_id: &str) -> Vec<NormalizedProviderEvent> {
    let steps = payload
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(256)
        .enumerate()
        .filter_map(|(index, entry)| {
            let body = bounded_text(string(entry.get("content")), MAX_TEXT_CHARS);
            if body.trim().is_empty() {
                return None;
            }
            Some(json!({
                "stepId": format!("step-{}", index + 1),
                "body": body,
                "status": match string(entry.get("status")) {
                    "inProgress" | "in_progress" => "in_progress",
                    "completed" => "completed",
                    "blocked" | "failed" | "error" => "blocked",
                    _ => "pending",
                },
            }))
        })
        .collect::<Vec<_>>();
    let complete = !steps.is_empty()
        && steps
            .iter()
            .all(|step| step.get("status").and_then(Value::as_str) == Some("completed"));
    vec![NormalizedProviderEvent {
        event_type: "plan.updated".to_owned(),
        priority: EventPriority::P1,
        payload: json!({
            "schema": "paperclip.plan.updated.v1",
            "planId": plan_id,
            "revision": 1,
            "explanation": Value::Null,
            "steps": steps,
            "complete": complete,
            "syncStatus": "not_applicable",
            "documentRevision": Value::Null,
        }),
    }]
}

fn normalize_acpx_status(
    payload: &Value,
    item_id: &str,
    turn_id: &str,
    provider_requests: u64,
) -> Vec<NormalizedProviderEvent> {
    let tag = string(payload.get("tag"));
    if tag == "usage_update" {
        let breakdown = payload.get("breakdown").unwrap_or(&Value::Null);
        let cache_read = breakdown
            .get("cachedReadTokens")
            .or_else(|| breakdown.get("cacheReadTokens"));
        let cache_write = breakdown
            .get("cachedWriteTokens")
            .or_else(|| breakdown.get("cacheWriteTokens"));
        // ACPX marks every breakdown field optional and defines omission as
        // unknown. Only advertise a complete per-turn delta when every field
        // that feeds a Paperclip token budget is explicitly present.
        let run_delta_available = breakdown
            .get("inputTokens")
            .and_then(Value::as_u64)
            .is_some()
            && breakdown
                .get("outputTokens")
                .and_then(Value::as_u64)
                .is_some()
            && breakdown
                .get("thoughtTokens")
                .and_then(Value::as_u64)
                .is_some()
            && cache_read.and_then(Value::as_u64).is_some()
            && cache_write.and_then(Value::as_u64).is_some();
        let cost_is_usd = match payload.pointer("/cost/currency") {
            None => true,
            Some(Value::String(currency)) => currency.eq_ignore_ascii_case("USD"),
            Some(_) => false,
        };
        // ACPX 0.13.1 documents breakdown as per-turn usage while cost is
        // session-cumulative. Keep those authorities separate so consumers do
        // not add the same tokens twice or treat cumulative cost as a delta.
        let cumulative = json!({
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "activeSeconds": 0.0,
            "requests": provider_requests,
            "providerCostUsd": if cost_is_usd {
                payload
                    .pointer("/cost/amount")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .unwrap_or(0.0)
            } else {
                0.0
            },
        });
        let run_delta = json!({
            "inputTokens": nonnegative_u64(breakdown.get("inputTokens")),
            // PRP v1 has no separate reasoning-token field. Fold ACPX thought
            // tokens into output so spend and token ceilings cannot undercount
            // reasoning work.
            "outputTokens": nonnegative_u64(breakdown.get("outputTokens"))
                .saturating_add(nonnegative_u64(breakdown.get("thoughtTokens"))),
            "cacheReadTokens": nonnegative_u64(
                cache_read,
            ),
            "cacheWriteTokens": nonnegative_u64(
                cache_write,
            ),
            "activeSeconds": 0.0,
            "requests": 1,
            "providerCostUsd": 0.0,
        });
        return vec![NormalizedProviderEvent {
            event_type: "usage.reported".to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "provider": "acpx",
                "model": payload
                    .get("model")
                    .and_then(Value::as_str)
                    .map(|value| bounded_text(value, 240)),
                "providerSessionId": Value::Null,
                "providerRequestId": Value::Null,
                "cumulative": cumulative,
                "runDeltaAvailable": run_delta_available,
                "runDelta": run_delta,
            }),
        }];
    }
    if tag == "current_mode_update" {
        let status = string(payload.get("text"));
        return vec![NormalizedProviderEvent {
            event_type: "review.mode.changed".to_owned(),
            priority: EventPriority::P1,
            payload: json!({
                "schema": "paperclip.review.mode_changed.v1",
                "reviewId": stable_id(turn_id, item_id),
                "state": if status.to_ascii_lowercase().contains("review")
                    || status.to_ascii_lowercase().contains("plan")
                {
                    "entered"
                } else {
                    "exited"
                },
                "scope": if status.is_empty() {
                    Value::Null
                } else {
                    Value::String(bounded_text(status, MAX_TEXT_CHARS))
                },
            }),
        }];
    }
    if matches!(
        tag,
        "available_commands_update" | "config_option_update" | "session_info_update"
    ) {
        return Vec::new();
    }
    vec![acpx_notice(
        item_id,
        "info",
        tag,
        string(payload.get("text")),
        false,
    )]
}

fn normalize_acpx_tool_call(
    payload: &Value,
    item_id: &str,
    operation: &str,
) -> Vec<NormalizedProviderEvent> {
    let native_status = string(payload.get("status"));
    let status = provider_status(native_status, native_status == "completed");
    let terminal = status != "running";
    let raw_title = string(payload.get("title"));
    let title = bounded_text(raw_title, 240);
    let output = match payload.get("rawOutput").or_else(|| payload.get("output")) {
        Some(Value::String(value)) => value.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
        None => String::new(),
    };
    let mut normalized = json!({
        "schema": "paperclip.tool.execution.v1",
        "executionId": item_id,
        "transport": "builtin",
        "operation": operation,
        "name": if title.is_empty() { Value::Null } else { Value::String(title) },
        "target": safe_acpx_location(payload.pointer("/locations/0"), operation == "edit"),
        "namespace": Value::Null,
        "readOnly": matches!(operation, "read" | "search" | "list"),
        "status": status,
        "durationMs": Value::Null,
        "exitCode": Value::Null,
        "progress": if terminal {
            Value::Null
        } else {
            payload
                .get("text")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|value| Value::String(bounded_text(value, MAX_TEXT_CHARS)))
                .unwrap_or(Value::Null)
        },
    });
    if let (Some(object), Value::Object(output)) =
        (normalized.as_object_mut(), bounded_output(&output))
    {
        object.extend(output);
    }
    vec![NormalizedProviderEvent {
        event_type: if terminal {
            "tool.execution.completed"
        } else if string(payload.get("tag")) == "tool_call" {
            "tool.execution.started"
        } else {
            "tool.execution.progressed"
        }
        .to_owned(),
        priority: if terminal {
            EventPriority::P1
        } else {
            EventPriority::P2
        },
        payload: normalized,
    }]
}

fn acpx_notice(
    item_id: &str,
    severity: &str,
    category: &str,
    summary: &str,
    user_actionable: bool,
) -> NormalizedProviderEvent {
    NormalizedProviderEvent {
        event_type: "provider.notice.recorded".to_owned(),
        priority: if severity == "error" {
            EventPriority::P0
        } else {
            EventPriority::P1
        },
        payload: json!({
            "schema": "paperclip.provider.notice.v1",
            "noticeId": item_id,
            "severity": match severity {
                "error" => "error",
                "warning" => "warning",
                _ => "info",
            },
            "category": stable_id(category, "acpx_provider_update"),
            "scope": "turn",
            "recoverable": severity != "error",
            "userActionable": user_actionable,
            "summary": if summary.trim().is_empty() {
                "The qualified ACP agent emitted a provider update.".to_owned()
            } else {
                bounded_text(summary, MAX_TEXT_CHARS)
            },
        }),
    }
}

fn nonnegative_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn safe_acpx_location(value: Option<&Value>, allow_create_target: bool) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    // Only the pinned sidecar may attest that it resolved this value within
    // the workspace under the provider host's path semantics. Ambiguous URI
    // scheme, Windows drive, and leading-backslash shapes additionally require
    // proof that the sidecar resolved an existing workspace entry as POSIX filename data,
    // or that an edit's not-yet-created target has an in-workspace parent.
    if value.get("pathBoundary").and_then(Value::as_str)
        != Some("paperclip.workspace_relative_display.v2")
    {
        return Value::Null;
    }
    let raw_path = value
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if raw_path.is_empty()
        || raw_path.starts_with('/')
        || raw_path.contains('\0')
        || raw_path.split('/').any(|segment| segment == "..")
    {
        return Value::Null;
    }
    let requires_entry_attestation = raw_path.starts_with('\\')
        || has_windows_drive_prefix(raw_path)
        || has_rfc_uri_scheme_prefix(raw_path);
    if requires_entry_attestation {
        let attestation = value.get("pathAttestation").and_then(Value::as_str);
        if attestation != Some("paperclip.workspace_entry.v1")
            && !(allow_create_target && attestation == Some("paperclip.workspace_create_target.v1"))
        {
            return Value::Null;
        }
    }
    Value::String(raw_path.chars().take(4_000).collect())
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn has_rfc_uri_scheme_prefix(value: &str) -> bool {
    let Some((scheme, _rest)) = value.split_once(':') else {
        return false;
    };
    let mut characters = scheme.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_the_declared_safe_path_contract() {
        for location in [
            "/absolute/path",
            r"\server\share",
            r"C:\secret",
            "../secret",
            "src/../../secret",
            r"foo\..\bar",
            r"https:\host\secret",
            "https://example.test/private",
            "https:example.test/private",
            "file:secret.txt",
            "bad\0name",
        ] {
            assert_eq!(
                safe_acpx_location(Some(&json!({"path": location})), false),
                Value::Null
            );
        }
        assert_eq!(
            safe_acpx_location(Some(&json!({"uri": "https://example.test/private"})), false,),
            Value::Null,
        );
        for location in [
            "/absolute/path",
            "../secret",
            "src/../../secret",
            "custom:payload",
            "urn:isbn:9780131103627",
            r"C:Users\alice\secret.txt",
            "D:relative.txt",
            "bad\0name",
        ] {
            assert_eq!(
                safe_acpx_location(
                    Some(&json!({
                        "path": location,
                        "pathBoundary": "paperclip.workspace_relative_display.v2"
                    })),
                    false,
                ),
                Value::Null,
            );
        }
    }

    #[test]
    fn preserves_valid_posix_display_characters() {
        for location in [
            "src:main.rs",
            "foo:bar/baz",
            "src:/main.rs",
            "a:/foo",
            "A:b/file.txt",
            r"folder\literal",
            r"foo\..\bar",
            "reports/100%/summary.txt",
        ] {
            assert_eq!(
                safe_acpx_location(
                    Some(&json!({
                        "path": location,
                        "pathBoundary": "paperclip.workspace_relative_display.v2",
                        "pathAttestation": "paperclip.workspace_entry.v1"
                    })),
                    false,
                ),
                Value::String(location.to_owned()),
            );
        }
    }

    #[test]
    fn maps_codex_plan_without_retaining_native_envelope() {
        let events = normalize_codex_notification(
            "turn/plan/updated",
            &json!({
                "turnId": "turn-1",
                "revision": 2,
                "plan": [{"step": "Inspect", "status": "inProgress"}],
                "accessToken": "secret-value",
            }),
        );
        assert_eq!(events[0].event_type, "plan.updated");
        assert_eq!(events[0].payload["steps"][0]["status"], "in_progress");
        assert!(!events[0].payload.to_string().contains("secret-value"));
    }

    #[test]
    fn bounds_and_redacts_command_output() {
        let events = normalize_codex_notification(
            "item/completed",
            &json!({"item": {
                "id": "exec-1",
                "type": "commandExecution",
                "status": "completed",
                "command": "printenv",
                "aggregatedOutput": "Authorization: Bearer top-secret",
            }}),
        );
        assert_eq!(events[0].event_type, "tool.execution.completed");
        assert_eq!(events[0].payload["outputTruncated"], true);
        assert_eq!(events[0].payload["outputBytes"], 32);
        assert!(!events[0].payload.to_string().contains("top-secret"));
    }

    #[test]
    fn maps_terminal_and_usage_events_at_priority_zero() {
        let terminal = normalize_codex_notification(
            "turn/completed",
            &json!({"turn": {"id": "provider-turn", "status": "failed"}}),
        );
        assert_eq!(terminal[0].event_type, "turn.failed");
        assert_eq!(terminal[0].priority, EventPriority::P0);
        for (method, expected) in [
            ("turn/failed", "turn.failed"),
            ("turn/cancelled", "turn.cancelled"),
            ("turn/interrupted", "turn.interrupted"),
        ] {
            let terminal =
                normalize_codex_notification(method, &json!({"turnId": "provider-turn"}));
            assert_eq!(terminal[0].event_type, expected);
            assert_eq!(terminal[0].priority, EventPriority::P0);
        }

        let usage = normalize_codex_notification(
            "thread/tokenUsage/updated",
            &json!({"tokenUsage": {"total": {"inputTokens": 12, "outputTokens": 3}}}),
        );
        assert_eq!(usage[0].event_type, "usage.reported");
        assert_eq!(usage[0].payload["cumulative"]["inputTokens"], 12);
        assert_eq!(usage[0].payload["runDeltaAvailable"], false);
        assert_eq!(usage[0].payload["runDelta"]["inputTokens"], 0);
        assert_eq!(usage[0].priority, EventPriority::P0);
    }

    #[test]
    fn does_not_substitute_session_cumulative_usage_for_a_missing_run_delta() {
        let first = normalize_codex_notification(
            "thread/tokenUsage/updated",
            &json!({"tokenUsage": {"total": {"inputTokens": 12, "outputTokens": 3}}}),
        );
        let second = normalize_codex_notification(
            "thread/tokenUsage/updated",
            &json!({"tokenUsage": {"total": {"inputTokens": 20, "outputTokens": 5}}}),
        );

        assert_eq!(first[0].payload["runDelta"]["inputTokens"], 0);
        assert_eq!(first[0].payload["runDelta"]["outputTokens"], 0);
        assert_eq!(first[0].payload["runDeltaAvailable"], false);
        assert_eq!(second[0].payload["runDelta"]["inputTokens"], 0);
        assert_eq!(second[0].payload["runDelta"]["outputTokens"], 0);
        assert_eq!(second[0].payload["runDeltaAvailable"], false);
        assert_eq!(second[0].payload["cumulative"]["inputTokens"], 20);
    }

    #[test]
    fn preserves_proxy_shaped_current_run_usage_as_an_explicit_delta() {
        let usage = normalize_codex_notification(
            "thread/tokenUsage/updated",
            &json!({"tokenUsage": {
                "total": {
                    "inputTokens": 24,
                    "outputTokens": 14,
                    "cachedInputTokens": 3,
                    "requests": 3,
                    "providerCostUsd": 0.021
                },
                "last": {
                    "inputTokens": 7,
                    // The OpenCode proxy folds reasoning into output because
                    // PRP v1 has no separate reasoning field.
                    "outputTokens": 4,
                    "cachedInputTokens": 1,
                    "requests": 1,
                    "providerCostUsd": 0.004
                }
            }}),
        );

        assert_eq!(usage[0].payload["runDeltaAvailable"], true);
        assert_eq!(usage[0].payload["cumulative"]["inputTokens"], 24);
        assert_eq!(usage[0].payload["cumulative"]["outputTokens"], 14);
        assert_eq!(usage[0].payload["cumulative"]["providerCostUsd"], 0.021);
        assert_eq!(usage[0].payload["runDelta"]["inputTokens"], 7);
        assert_eq!(usage[0].payload["runDelta"]["outputTokens"], 4);
        assert_eq!(usage[0].payload["runDelta"]["providerCostUsd"], 0.004);
    }
}
