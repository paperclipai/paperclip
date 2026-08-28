use std::collections::BTreeSet;

use serde_json::Value;

use crate::acpx_event_scope::AcpxEventScope;
use crate::acpx_sidecar_transport::AcpxSidecarEvent;
use crate::durable::{redact_text, sanitize_value};
use crate::generated_acpx_sidecar_contract::GeneratedAcpxSidecarEventType;
use crate::local_runner::LocalRunnerError;

const MAX_EVENT_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_ID_CHARS: usize = 160;
const MAX_RUNTIME_TEXT_CHARS: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcpxRuntimeEventKind {
    TextDelta,
    Thinking,
    Plan,
    Status,
    ToolCall,
    SemanticResult,
    ProviderNotice,
    Error,
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcpxTurnStatus {
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AcpxEventPayload {
    Runtime {
        kind: AcpxRuntimeEventKind,
        payload: Value,
    },
    PermissionRequested {
        request_id: String,
        kind: String,
        title: String,
        details: Value,
    },
    InputRequested {
        request_id: String,
        question_set: Value,
        origin: Option<Value>,
    },
    ToolCalled {
        call_id: String,
        operation_id: String,
        input: Value,
    },
    TurnTerminal {
        status: AcpxTurnStatus,
        error: Option<Value>,
    },
    Process {
        details: Value,
    },
    Diagnostic {
        code: String,
        message: String,
    },
}

/// Validates event authority before it decodes the bounded sidecar payload.
pub fn decode_acpx_event(
    scope: &AcpxEventScope,
    event: &AcpxSidecarEvent,
) -> Result<AcpxEventPayload, LocalRunnerError> {
    scope.validate_event(event)?;
    let payload_bytes = serde_json::to_vec(&event.payload).map_err(|error| {
        LocalRunnerError::invalid(format!("ACPX event payload is invalid: {error}"))
    })?;
    if payload_bytes.len() > MAX_EVENT_PAYLOAD_BYTES {
        return Err(LocalRunnerError::invalid(
            "ACPX event payload exceeds the 256 KiB admission limit",
        ));
    }

    match event.event_type {
        GeneratedAcpxSidecarEventType::RuntimeEvent => decode_runtime_event(&event.payload),
        GeneratedAcpxSidecarEventType::RuntimePermissionRequested => {
            Ok(AcpxEventPayload::PermissionRequested {
                request_id: required_id(&event.payload, "requestId", "permission request")?,
                kind: bounded_optional_text(&event.payload, "kind", 160, "permission kind")?
                    .map(|value| redact_text(&value))
                    .unwrap_or_else(|| "permission".to_owned()),
                title: bounded_optional_text(&event.payload, "title", 4_000, "permission title")?
                    .map(|value| redact_text(&value))
                    .unwrap_or_else(|| "ACP permission request".to_owned()),
                details: sanitize_value(&event.payload),
            })
        }
        GeneratedAcpxSidecarEventType::RuntimeInputRequested => {
            let question_set = event.payload.get("questionSet").cloned().ok_or_else(|| {
                LocalRunnerError::invalid("ACPX input request omitted its question set")
            })?;
            validate_question_set(&question_set)?;
            let origin = optional_object(&event.payload, "origin", "input request origin")?;
            Ok(AcpxEventPayload::InputRequested {
                request_id: required_id(&event.payload, "requestId", "input request")?,
                question_set,
                origin: origin.map(|value| sanitize_value(&value)),
            })
        }
        GeneratedAcpxSidecarEventType::RuntimeToolCalled => {
            let input = event.payload.get("input").cloned().unwrap_or(Value::Null);
            if !input.is_object() {
                return Err(LocalRunnerError::invalid(
                    "ACPX tool call input must be an object",
                ));
            }
            Ok(AcpxEventPayload::ToolCalled {
                call_id: required_id(&event.payload, "callId", "tool call")?,
                operation_id: required_id(&event.payload, "operationId", "tool operation")?,
                input: sanitize_value(&input),
            })
        }
        GeneratedAcpxSidecarEventType::RuntimeTurnTerminal => {
            let status = match event.payload.get("status").and_then(Value::as_str) {
                Some("completed") => AcpxTurnStatus::Completed,
                Some("failed") => AcpxTurnStatus::Failed,
                Some("cancelled" | "canceled") => AcpxTurnStatus::Cancelled,
                Some("interrupted") => AcpxTurnStatus::Interrupted,
                _ => {
                    return Err(LocalRunnerError::invalid(
                        "ACPX terminal event has an unsupported status",
                    ))
                }
            };
            let error = optional_object(&event.payload, "error", "terminal error")?;
            Ok(AcpxEventPayload::TurnTerminal {
                status,
                error: error.map(|value| sanitize_value(&value)),
            })
        }
        GeneratedAcpxSidecarEventType::RuntimeProcess => Ok(AcpxEventPayload::Process {
            details: sanitize_value(&event.payload),
        }),
        GeneratedAcpxSidecarEventType::RuntimeDiagnostic => {
            let code = required_id(&event.payload, "code", "diagnostic code")?;
            let message = event
                .payload
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| LocalRunnerError::invalid("ACPX diagnostic omitted its message"))?;
            if message.chars().count() > 8_192 {
                return Err(LocalRunnerError::invalid(
                    "ACPX diagnostic message exceeds its bound",
                ));
            }
            Ok(AcpxEventPayload::Diagnostic {
                code,
                message: redact_text(message),
            })
        }
    }
}

fn decode_runtime_event(payload: &Value) -> Result<AcpxEventPayload, LocalRunnerError> {
    let runtime_type = payload
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid("ACPX runtime event omitted its type"))?;
    let kind = match runtime_type {
        "text_delta" => {
            bounded_required_text(payload, "text", MAX_RUNTIME_TEXT_CHARS, "runtime text")?;
            AcpxRuntimeEventKind::TextDelta
        }
        "thinking" => {
            bounded_required_text(payload, "text", MAX_RUNTIME_TEXT_CHARS, "runtime thought")?;
            AcpxRuntimeEventKind::Thinking
        }
        "plan" => {
            validate_plan(payload)?;
            AcpxRuntimeEventKind::Plan
        }
        "status" => {
            bounded_optional_text(payload, "tag", 160, "runtime status tag")?;
            bounded_optional_text(payload, "text", 4_000, "runtime status text")?;
            AcpxRuntimeEventKind::Status
        }
        "tool_call" => {
            bounded_optional_text(payload, "toolCallId", 240, "runtime tool call id")?;
            bounded_optional_text(payload, "title", 4_000, "runtime tool title")?;
            bounded_optional_text(payload, "status", 100, "runtime tool status")?;
            if let Some(locations) = optional_array(payload, "locations", "runtime tool locations")?
            {
                if locations.len() > 2_000 {
                    return Err(LocalRunnerError::invalid(
                        "ACPX runtime tool locations exceed their bound",
                    ));
                }
                for location in locations {
                    if !location.is_object() {
                        return Err(LocalRunnerError::invalid(
                            "ACPX runtime tool location must be an object",
                        ));
                    }
                    bounded_optional_text(location, "path", 4_000, "runtime tool path")?;
                }
            }
            AcpxRuntimeEventKind::ToolCall
        }
        "semantic_result" => {
            required_id(payload, "callId", "semantic result call")?;
            required_id(payload, "operationId", "semantic result operation")?;
            if !payload.get("result").is_some_and(Value::is_object) {
                return Err(LocalRunnerError::invalid(
                    "ACPX semantic result must contain an object result",
                ));
            }
            AcpxRuntimeEventKind::SemanticResult
        }
        "provider_notice" => {
            bounded_nonempty_text(payload, "category", 160, "provider notice category")?;
            bounded_nonempty_text(payload, "summary", 4_000, "provider notice summary")?;
            AcpxRuntimeEventKind::ProviderNotice
        }
        "error" => {
            bounded_optional_text(payload, "code", 160, "runtime error code")?;
            bounded_nonempty_text(payload, "message", 8_192, "runtime error message")?;
            AcpxRuntimeEventKind::Error
        }
        "done" => {
            bounded_optional_text(payload, "stopReason", 160, "runtime stop reason")?;
            AcpxRuntimeEventKind::Done
        }
        _ => {
            return Err(LocalRunnerError::invalid(
                "ACPX runtime event type is not admitted",
            ))
        }
    };
    Ok(AcpxEventPayload::Runtime {
        kind,
        payload: sanitize_value(payload),
    })
}

fn validate_plan(payload: &Value) -> Result<(), LocalRunnerError> {
    let entries = payload
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| LocalRunnerError::invalid("ACPX runtime plan must contain entries"))?;
    if entries.len() > 256 {
        return Err(LocalRunnerError::invalid(
            "ACPX runtime plan exceeds 256 entries",
        ));
    }
    for entry in entries {
        bounded_nonempty_text(entry, "content", 4_000, "runtime plan content")?;
        if !matches!(
            entry.get("status").and_then(Value::as_str),
            Some("pending" | "in_progress" | "completed")
        ) {
            return Err(LocalRunnerError::invalid(
                "ACPX runtime plan contains an unsupported status",
            ));
        }
    }
    Ok(())
}

fn validate_question_set(value: &Value) -> Result<(), LocalRunnerError> {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/question-set.schema.json"
    ))
    .map_err(|_| LocalRunnerError::invalid("embedded question-set schema is invalid"))?;
    let validator = jsonschema::validator_for(&schema)
        .map_err(|_| LocalRunnerError::invalid("embedded question-set schema cannot compile"))?;
    if !validator.is_valid(value) {
        return Err(LocalRunnerError::invalid(
            "ACPX input request failed the Paperclip question-set schema",
        ));
    }
    let mut ids = BTreeSet::new();
    for question in value
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = question
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| LocalRunnerError::invalid("ACPX input question omitted its id"))?;
        if !ids.insert(id) {
            return Err(LocalRunnerError::invalid(
                "ACPX input question ids must be unique",
            ));
        }
        let mut option_ids = BTreeSet::new();
        for option in question
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let option_id = option
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| LocalRunnerError::invalid("ACPX input option omitted its id"))?;
            if !option_ids.insert(option_id) {
                return Err(LocalRunnerError::invalid(
                    "ACPX input option ids must be unique within one question",
                ));
            }
        }
    }
    Ok(())
}

fn required_id(value: &Value, key: &str, label: &str) -> Result<String, LocalRunnerError> {
    let id = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid(format!("ACPX {label} omitted its identity")))?;
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS || id.chars().any(char::is_control) {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX {label} identity is invalid"
        )));
    }
    Ok(id.to_owned())
}

fn bounded_required_text<'a>(
    value: &'a Value,
    key: &str,
    max_chars: usize,
    label: &str,
) -> Result<&'a str, LocalRunnerError> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid(format!("ACPX {label} is required")))?;
    if text.chars().count() > max_chars {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX {label} exceeds its bound"
        )));
    }
    Ok(text)
}

fn bounded_nonempty_text<'a>(
    value: &'a Value,
    key: &str,
    max_chars: usize,
    label: &str,
) -> Result<&'a str, LocalRunnerError> {
    let text = bounded_required_text(value, key, max_chars, label)?;
    if text.trim().is_empty() {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX {label} must not be empty"
        )));
    }
    Ok(text)
}

fn bounded_optional_text(
    value: &Value,
    key: &str,
    max_chars: usize,
    label: &str,
) -> Result<Option<String>, LocalRunnerError> {
    let Some(field) = value.get(key) else {
        return Ok(None);
    };
    if field.is_null() {
        return Ok(None);
    }
    let text = field
        .as_str()
        .ok_or_else(|| LocalRunnerError::invalid(format!("ACPX {label} must be text")))?;
    if text.chars().count() > max_chars {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX {label} exceeds its bound"
        )));
    }
    Ok(Some(text.to_owned()))
}

fn optional_object(
    value: &Value,
    key: &str,
    label: &str,
) -> Result<Option<Value>, LocalRunnerError> {
    let Some(field) = value.get(key) else {
        return Ok(None);
    };
    if field.is_null() {
        return Ok(None);
    }
    if !field.is_object() {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX {label} must be an object"
        )));
    }
    Ok(Some(field.clone()))
}

fn optional_array<'a>(
    value: &'a Value,
    key: &str,
    label: &str,
) -> Result<Option<&'a Vec<Value>>, LocalRunnerError> {
    let Some(field) = value.get(key) else {
        return Ok(None);
    };
    if field.is_null() {
        return Ok(None);
    }
    field
        .as_array()
        .map(Some)
        .ok_or_else(|| LocalRunnerError::invalid(format!("ACPX {label} must be an array")))
}
