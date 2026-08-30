use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::durable::{redact_text, EventPriority};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
