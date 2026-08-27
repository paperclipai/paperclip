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

fn bounded_text(value: &str, max_chars: usize) -> String {
    redact_text(value).chars().take(max_chars).collect()
}

fn string(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn notice_summary(method: &str, params: &Value) -> String {
    let message = params
        .get("message")
        .or_else(|| params.pointer("/error/message"))
        .or_else(|| params.pointer("/error/detail"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let code = params
        .get("code")
        .or_else(|| params.pointer("/error/code"))
        .or_else(|| params.pointer("/error/type"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());

    let summary = match (code, message) {
        (Some(code), Some(message)) if !message.contains(code) => format!(
            "{}: {}",
            bounded_text(code, 240),
            bounded_text(message, MAX_TEXT_CHARS)
        ),
        (_, Some(message)) => bounded_text(message, MAX_TEXT_CHARS),
        (Some(code), None) => bounded_text(code, 240),
        (None, None) => match params {
            Value::Null => String::new(),
            Value::Object(values) if values.is_empty() => String::new(),
            Value::Array(values) if values.is_empty() => String::new(),
            _ => bounded_text(
                &serde_json::to_string(params).unwrap_or_default(),
                MAX_TEXT_CHARS,
            ),
        },
    };

    if summary.trim().is_empty() {
        bounded_text(
            &format!("Codex {method} notification contained no details"),
            MAX_TEXT_CHARS,
        )
    } else {
        summary.chars().take(MAX_TEXT_CHARS).collect()
    }
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
    let input_tokens = value
        .get("inputTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = value
        .get("outputTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read_tokens = value
        .get("cachedInputTokens")
        .or_else(|| value.get("cacheReadTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write_tokens = value
        .get("cacheWriteTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reported_requests = value.get("requests").and_then(Value::as_u64);
    let has_token_usage =
        input_tokens > 0 || output_tokens > 0 || cache_read_tokens > 0 || cache_write_tokens > 0;
    let (requests, request_count_source, request_count_exact) = match reported_requests {
        Some(0) if has_token_usage => (1, "token_bearing_turn_minimum", false),
        Some(requests) => (requests, "provider_reported", true),
        None if has_token_usage => (1, "token_bearing_turn_minimum", false),
        None => (0, "unavailable", false),
    };
    let reported_cost = value
        .get("providerCostUsd")
        .and_then(Value::as_f64)
        .filter(|value| *value >= 0.0);
    json!({
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": cache_read_tokens,
        "cacheWriteTokens": cache_write_tokens,
        "activeSeconds": value.get("activeSeconds").and_then(Value::as_f64).filter(|value| *value >= 0.0).unwrap_or(0.0),
        "requests": requests,
        "requestCountSource": request_count_source,
        "requestCountExact": request_count_exact,
        "providerCostUsd": reported_cost.unwrap_or(0.0),
        "providerCostStatus": if reported_cost.is_some() { "reported" } else { "unpriced" },
        "providerCostUnavailableReason": if reported_cost.is_some() {
            Value::Null
        } else {
            json!("codex_app_server_does_not_report_per_turn_cost")
        },
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
        "turn/completed" => {
            let status = string(
                params
                    .pointer("/turn/status")
                    .or_else(|| params.get("status")),
            );
            let event_type = match status {
                "failed" | "error" => "turn.failed",
                "cancelled" | "canceled" => "turn.cancelled",
                "interrupted" | "aborted" => "turn.interrupted",
                _ => "turn.completed",
            };
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
                .or_else(|| params.get("last"))
                .unwrap_or(cumulative);
            let provider_request_id = params
                .get("responseId")
                .or_else(|| params.get("requestId"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|value| bounded_text(value, 240));
            let provider_request_id_unavailable_reason = if provider_request_id.is_some() {
                Value::Null
            } else {
                json!("codex_app_server_does_not_expose_per_request_id")
            };
            push(
                &mut events,
                "usage.reported",
                EventPriority::P0,
                json!({
                    "provider": "codex",
                    "model": params.get("model").and_then(Value::as_str).map(|value| bounded_text(value, 240)),
                    "providerSessionId": params.get("threadId").and_then(Value::as_str).map(|value| bounded_text(value, 240)),
                    "providerTurnId": params.get("turnId").and_then(Value::as_str).map(|value| bounded_text(value, 240)),
                    "providerRequestId": provider_request_id,
                    "providerRequestIdUnavailableReason": provider_request_id_unavailable_reason,
                    "cumulative": measurement(cumulative),
                    "runDelta": measurement(run_delta),
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
                "summary": notice_summary(method, params),
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
    fn describes_error_notices_from_nested_fields_without_leaking_secrets() {
        let events = normalize_codex_notification(
            "error",
            &json!({
                "error": {
                    "code": "authentication_failed",
                    "message": "Authorization: Bearer top-secret"
                }
            }),
        );
        let summary = events[0].payload["summary"]
            .as_str()
            .expect("notice summary is text");
        assert!(summary.contains("authentication_failed"));
        assert!(!summary.contains("top-secret"));
    }

    #[test]
    fn gives_detail_free_fatal_notices_an_actionable_summary() {
        let events = normalize_codex_notification("error", &json!({}));
        assert_eq!(
            events[0].payload["summary"],
            "Codex error notification contained no details"
        );
    }

    #[test]
    fn maps_terminal_and_usage_events_at_priority_zero() {
        let terminal = normalize_codex_notification(
            "turn/completed",
            &json!({"turn": {"id": "provider-turn", "status": "failed"}}),
        );
        assert_eq!(terminal[0].event_type, "turn.failed");
        assert_eq!(terminal[0].priority, EventPriority::P0);

        let usage = normalize_codex_notification(
            "thread/tokenUsage/updated",
            &json!({"tokenUsage": {"total": {"inputTokens": 12, "outputTokens": 3}}}),
        );
        assert_eq!(usage[0].event_type, "usage.reported");
        assert_eq!(usage[0].payload["cumulative"]["inputTokens"], 12);
        assert_eq!(usage[0].payload["cumulative"]["requests"], 1);
        assert_eq!(
            usage[0].payload["cumulative"]["requestCountSource"],
            "token_bearing_turn_minimum"
        );
        assert_eq!(usage[0].payload["cumulative"]["requestCountExact"], false);
        assert_eq!(
            usage[0].payload["cumulative"]["providerCostStatus"],
            "unpriced"
        );
        assert_eq!(
            usage[0].payload["providerRequestIdUnavailableReason"],
            "codex_app_server_does_not_expose_per_request_id"
        );
        assert_eq!(usage[0].priority, EventPriority::P0);
    }

    #[test]
    fn treats_zero_requests_with_positive_tokens_as_an_inexact_lower_bound() {
        let usage = normalize_codex_notification(
            "thread/tokenUsage/updated",
            &json!({
                "turnId": "provider-turn-with-usage",
                "tokenUsage": {
                    "total": {"inputTokens": 12, "outputTokens": 3, "requests": 0}
                }
            }),
        );

        assert_eq!(
            usage[0].payload["providerTurnId"],
            "provider-turn-with-usage"
        );
        assert_eq!(usage[0].payload["cumulative"]["requests"], 1);
        assert_eq!(
            usage[0].payload["cumulative"]["requestCountSource"],
            "token_bearing_turn_minimum"
        );
        assert_eq!(usage[0].payload["cumulative"]["requestCountExact"], false);
        assert_eq!(
            usage[0].payload["cumulative"]["providerCostStatus"],
            "unpriced"
        );
        assert_eq!(
            usage[0].payload["cumulative"]["providerCostUnavailableReason"],
            "codex_app_server_does_not_report_per_turn_cost"
        );
    }

    #[test]
    fn preserves_provider_reported_request_and_cost_receipts() {
        let usage = normalize_codex_notification(
            "thread/tokenUsage/updated",
            &json!({
                "turnId": "provider-turn-with-two-requests",
                "responseId": "resp_123",
                "tokenUsage": {
                    "total": {"inputTokens": 12, "outputTokens": 3, "requests": 2, "providerCostUsd": 0.04},
                    "last": {"inputTokens": 5, "outputTokens": 1, "requests": 1, "providerCostUsd": 0.01}
                }
            }),
        );
        assert_eq!(
            usage[0].payload["providerTurnId"],
            "provider-turn-with-two-requests"
        );
        assert_eq!(usage[0].payload["cumulative"]["requests"], 2);
        assert_eq!(
            usage[0].payload["cumulative"]["requestCountSource"],
            "provider_reported"
        );
        assert_eq!(usage[0].payload["cumulative"]["requestCountExact"], true);
        assert_eq!(usage[0].payload["providerRequestId"], "resp_123");
        assert_eq!(
            usage[0].payload["providerRequestIdUnavailableReason"],
            Value::Null
        );
        assert_eq!(usage[0].payload["runDelta"]["requests"], 1);
        assert_eq!(
            usage[0].payload["runDelta"]["requestCountSource"],
            "provider_reported"
        );
        assert_eq!(usage[0].payload["runDelta"]["requestCountExact"], true);
        assert_eq!(usage[0].payload["runDelta"]["providerCostUsd"], 0.01);
        assert_eq!(
            usage[0].payload["runDelta"]["providerCostStatus"],
            "reported"
        );
        assert_eq!(
            usage[0].payload["runDelta"]["providerCostUnavailableReason"],
            Value::Null
        );
    }
}
