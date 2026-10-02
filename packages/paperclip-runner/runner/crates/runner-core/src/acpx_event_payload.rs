use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde_json::Value;

use crate::acpx_event_scope::AcpxEventScope;
use crate::acpx_sidecar_transport::AcpxSidecarEvent;
use crate::durable::{
    redact_sensitive_text_values, redact_text, sanitize_semantic_tool_input, sanitize_value,
};
use crate::generated_acpx_sidecar_contract::{
    classify_generated_acpx_tool_operation, GeneratedAcpxSidecarEventType,
};
use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::semantic_value_digest;
use crate::stable_identity::{is_stable_id, SHORT_STABLE_ID_CHARS};

const MAX_EVENT_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_ID_CHARS: usize = 160;
const MAX_RUNTIME_ITEM_ID_CHARS: usize = 240;
const MAX_INPUT_REQUEST_ID_CHARS: usize = 240;
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
    RichActivity {
        event_type: String,
        payload: Value,
    },
    Runtime {
        kind: AcpxRuntimeEventKind,
        tool_operation: Option<&'static str>,
        payload: Value,
        semantic_result_digest: Option<String>,
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
        input_digest: String,
    },
    TurnTerminal {
        status: AcpxTurnStatus,
        error: Option<Value>,
    },
    Process {
        details: Value,
    },
    Goal {
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
        GeneratedAcpxSidecarEventType::RuntimeRichEvent => decode_rich_event(&event.payload),
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
            let question_set = sanitize_question_set(question_set)?;
            let origin = optional_object(&event.payload, "origin", "input request origin")?;
            Ok(AcpxEventPayload::InputRequested {
                request_id: required_id_with_limit(
                    &event.payload,
                    "requestId",
                    "input request",
                    MAX_INPUT_REQUEST_ID_CHARS,
                )?,
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
            let operation_id = required_id(&event.payload, "operationId", "tool operation")?;
            // This input is dispatched as a mutation, not merely displayed in
            // the event feed. Use the same declared-prose policy as native
            // semantic_tool.input before any generic diagnostic scrub can
            // irreversibly change the task's requirements.
            let safe_input = sanitize_semantic_tool_input(&operation_id, &input)
                .map_err(|error| LocalRunnerError::invalid(error.to_string()))?;
            Ok(AcpxEventPayload::ToolCalled {
                call_id: required_id(&event.payload, "callId", "tool call")?,
                operation_id,
                // Keep the original digest for the sidecar's result binding.
                input_digest: semantic_value_digest(&input),
                input: safe_input,
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
        GeneratedAcpxSidecarEventType::RuntimeGoal => Ok(AcpxEventPayload::Goal {
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

// This boundary accepts display activity only. Terminal outcomes, tool dispatch,
// runtime requests and source references retain their separate authority paths.
fn rich_event_schema(event_type: &str) -> Option<&'static str> {
    Some(match event_type {
        "plan.updated" => "plan",
        "tool.execution.started" | "tool.execution.progressed" | "tool.execution.completed" => {
            "toolExecution"
        }
        "research.started" | "research.progressed" | "research.completed" => "research",
        "delegation.started" | "delegation.updated" | "delegation.completed" => "delegation",
        "model.route.changed" => "modelRoute",
        "model.verification.updated" => "modelVerification",
        "context.compacted" => "contextCompacted",
        "artifact.viewed" => "artifactViewed",
        "artifact.generated" => "artifactGenerated",
        "review.mode.changed" => "reviewMode",
        "hook.started" | "hook.completed" => "hook",
        "memory.citation.referenced" => "memoryCitation",
        "safety.review.started" | "safety.review.completed" => "safetyReview",
        "terminal.input.sent" => "terminalInput",
        "wait.started" | "wait.completed" => "wait",
        "provider.notice.recorded" => "providerNotice",
        _ => return None,
    })
}

fn rich_event_validators(
) -> Result<&'static BTreeMap<String, jsonschema::Validator>, LocalRunnerError> {
    static VALIDATORS: OnceLock<Result<BTreeMap<String, jsonschema::Validator>, String>> =
        OnceLock::new();
    VALIDATORS.get_or_init(|| {
        let schema: Value = serde_json::from_str(include_str!("../../../../protocol/schemas/provider-event.schema.json"))
            .map_err(|_| "embedded provider-event schema is invalid".to_owned())?;
        fn internal_refs(value: &Value) -> bool {
            match value {
                Value::Object(object) => object.iter().all(|(key, value)| {
                    (key != "$ref" || value.as_str().is_some_and(|reference| reference.starts_with("#/"))) && internal_refs(value)
                }),
                Value::Array(values) => values.iter().all(internal_refs),
                _ => true,
            }
        }
        if !internal_refs(&schema) { return Err("provider-event schema may use only internal references".to_owned()); }
        let definitions = schema.get("$defs").and_then(Value::as_object).ok_or_else(|| "provider-event schema has no definitions".to_owned())?;
        let mut validators = BTreeMap::new();
        for name in ["plan", "toolExecution", "research", "delegation", "modelRoute", "modelVerification", "contextCompacted", "artifactViewed", "artifactGenerated", "reviewMode", "hook", "memoryCitation", "safetyReview", "terminalInput", "wait", "providerNotice"] {
            if !definitions.contains_key(name) { return Err("provider-event schema is missing an admitted definition".to_owned()); }
            let selected = serde_json::json!({"$schema":"https://json-schema.org/draft/2020-12/schema", "$ref":format!("#/$defs/{name}"), "$defs":definitions});
            let validator = jsonschema::validator_for(&selected).map_err(|_| "embedded provider-event schema cannot compile".to_owned())?;
            validators.insert(name.to_owned(), validator);
        }
        Ok(validators)
    }).as_ref().map_err(|message| LocalRunnerError::invalid(message.clone()))
}

fn decode_rich_event(value: &Value) -> Result<AcpxEventPayload, LocalRunnerError> {
    let wrapper = value
        .as_object()
        .ok_or_else(|| LocalRunnerError::invalid("ACPX rich event must be an object"))?;
    if wrapper
        .keys()
        .any(|key| !matches!(key.as_str(), "eventType" | "itemId" | "payload"))
    {
        return Err(LocalRunnerError::invalid(
            "ACPX rich event cannot supply source references or authority fields",
        ));
    }
    let item_id = wrapper
        .get("itemId")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid("ACPX rich event omitted its display identity"))?;
    if !is_stable_id(item_id, SHORT_STABLE_ID_CHARS) {
        return Err(LocalRunnerError::invalid(
            "ACPX rich event display identity is invalid",
        ));
    }
    let event_type = wrapper
        .get("eventType")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid("ACPX rich event omitted its type"))?;
    let schema = rich_event_schema(event_type).ok_or_else(|| {
        LocalRunnerError::invalid("ACPX rich event type is not admitted display activity")
    })?;
    let payload = wrapper
        .get("payload")
        .ok_or_else(|| LocalRunnerError::invalid("ACPX rich event omitted its payload"))?;
    let validators = rich_event_validators()?;
    let validator = validators
        .get(schema)
        .ok_or_else(|| LocalRunnerError::invalid("ACPX rich event schema is unavailable"))?;
    if !validator.is_valid(payload) {
        return Err(LocalRunnerError::invalid(
            "ACPX rich event failed its exact provider-event schema",
        ));
    }
    if event_type == "artifact.generated" && payload.get("registered") != Some(&Value::Bool(false))
    {
        return Err(LocalRunnerError::invalid(
            "ACPX display activity cannot register an artifact",
        ));
    }
    if event_type == "plan.updated"
        && (payload.get("syncStatus").and_then(Value::as_str) != Some("not_applicable")
            || payload
                .get("documentRevision")
                .is_some_and(|revision| !revision.is_null()))
    {
        return Err(LocalRunnerError::invalid(
            "ACPX display activity cannot synchronize a durable plan",
        ));
    }
    for field in ["reference", "target"] {
        if payload
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|path| {
                path.contains('\\') || path.contains(':') || path.chars().any(char::is_control)
            })
        {
            return Err(LocalRunnerError::invalid(
                "ACPX activity reference must be a workspace-relative path",
            ));
        }
    }
    fn sanitize_display(value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(redact_sensitive_text_values(text)),
            Value::Array(values) => Value::Array(values.iter().map(sanitize_display).collect()),
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (key.clone(), sanitize_display(value)))
                    .collect(),
            ),
            value => value.clone(),
        }
    }
    let payload = sanitize_display(payload);
    if !validator.is_valid(&payload) {
        return Err(LocalRunnerError::invalid(
            "ACPX rich event redaction exceeded its schema bounds",
        ));
    }
    Ok(AcpxEventPayload::RichActivity {
        event_type: event_type.to_owned(),
        payload,
    })
}

// Durable storage uses this same exact schema gate before lifting diagnostic
// preview limits. This does not admit an event or grant mutation authority.
pub(crate) fn has_bounded_rich_display_shape(event_type: &str, payload: &Value) -> bool {
    let Some(schema) = rich_event_schema(event_type) else {
        return false;
    };
    serde_json::to_vec(payload).is_ok_and(|bytes| bytes.len() <= MAX_EVENT_PAYLOAD_BYTES)
        && rich_event_validators().is_ok_and(|validators| {
            validators
                .get(schema)
                .is_some_and(|validator| validator.is_valid(payload))
        })
}

fn sanitize_question_set(mut value: Value) -> Result<Value, LocalRunnerError> {
    let original = value.clone();
    let Some(question_set) = value.as_object_mut() else {
        return Ok(value);
    };
    redact_object_text(question_set, &["title", "description", "submitLabel"]);
    if let Some(questions) = question_set
        .get_mut("questions")
        .and_then(Value::as_array_mut)
    {
        for question in questions {
            let Some(question) = question.as_object_mut() else {
                continue;
            };
            // IDs, answer modes, and validation patterns are protocol values:
            // changing them would break response correlation or semantics.
            redact_object_text(question, &["header", "prompt", "helpText"]);
            if let Some(options) = question.get_mut("options").and_then(Value::as_array_mut) {
                for option in options {
                    if let Some(option) = option.as_object_mut() {
                        redact_object_text(option, &["label", "description"]);
                    }
                }
            }
            if let Some(custom_answer) = question
                .get_mut("customAnswer")
                .and_then(Value::as_object_mut)
            {
                redact_object_text(custom_answer, &["label", "placeholder"]);
            }
        }
    }
    if value != original {
        let description = value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("");
        value["description"] = Value::String(format!(
            "Sensitive values were redacted from this request.\n\n{description}"
        ));
    }
    validate_question_set(&value)?;
    Ok(value)
}

fn redact_object_text(object: &mut serde_json::Map<String, Value>, keys: &[&str]) {
    for key in keys {
        let Some(text) = object.get(*key).and_then(Value::as_str) else {
            continue;
        };
        let redacted = redact_sensitive_text_values(text);
        object.insert((*key).to_owned(), Value::String(redacted));
    }
}

fn decode_runtime_event(payload: &Value) -> Result<AcpxEventPayload, LocalRunnerError> {
    let runtime_type = payload
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid("ACPX runtime event omitted its type"))?;
    let mut tool_operation = None;
    let mut semantic_result_digest = None;
    let kind = match runtime_type {
        "text_delta" => {
            bounded_required_text(payload, "text", MAX_RUNTIME_TEXT_CHARS, "runtime text")?;
            bounded_optional_text(
                payload,
                "messageId",
                MAX_RUNTIME_ITEM_ID_CHARS,
                "runtime message id",
            )?;
            AcpxRuntimeEventKind::TextDelta
        }
        "thinking" => {
            bounded_required_text(payload, "text", MAX_RUNTIME_TEXT_CHARS, "runtime thought")?;
            bounded_optional_text(
                payload,
                "messageId",
                MAX_RUNTIME_ITEM_ID_CHARS,
                "runtime thought message id",
            )?;
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
            // Tool lifecycle updates cannot be coalesced safely without the
            // provider's opaque identity. The qualified sidecar turns an
            // identity-less ACP update into an explicit unsupported notice,
            // and runner-core rejects any malformed frame that bypasses it.
            required_id_with_limit(
                payload,
                "toolCallId",
                "runtime tool call",
                MAX_RUNTIME_ITEM_ID_CHARS,
            )?;
            let title = bounded_optional_text(payload, "title", 4_000, "runtime tool title")?;
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
            tool_operation = Some(match payload.get("toolOperation") {
                Some(Value::String(operation)) => {
                    bounded_optional_text(payload, "kind", 4_000, "runtime tool kind")?;
                    admitted_tool_operation(operation).ok_or_else(|| {
                        LocalRunnerError::invalid("ACPX runtime tool operation is not admitted")
                    })?
                }
                Some(_) => {
                    return Err(LocalRunnerError::invalid(
                        "ACPX runtime tool operation must be text",
                    ))
                }
                None => classify_generated_acpx_tool_operation(
                    payload.get("kind").and_then(Value::as_str).unwrap_or(""),
                    title.as_deref().unwrap_or(""),
                ),
            });
            AcpxRuntimeEventKind::ToolCall
        }
        "semantic_result" => {
            required_id(payload, "callId", "semantic result call")?;
            required_id(payload, "operationId", "semantic result operation")?;
            if !payload.get("ok").is_some_and(Value::is_boolean) {
                return Err(LocalRunnerError::invalid(
                    "ACPX semantic result must contain a boolean outcome",
                ));
            }
            if !payload.get("result").is_some_and(Value::is_object) {
                return Err(LocalRunnerError::invalid(
                    "ACPX semantic result must contain an object result",
                ));
            }
            semantic_result_digest = payload.get("result").map(semantic_value_digest);
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
        tool_operation,
        payload: sanitize_value(payload),
        semantic_result_digest,
    })
}

fn admitted_tool_operation(operation: &str) -> Option<&'static str> {
    if operation == "unknown" {
        return Some("unknown");
    }
    let classified = classify_generated_acpx_tool_operation(operation, "");
    (classified == operation).then_some(classified)
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

pub(crate) fn validate_question_set(value: &Value) -> Result<(), LocalRunnerError> {
    if serde_json::to_vec(value)
        .map_err(|_| LocalRunnerError::invalid("ACPX question set is invalid"))?
        .len()
        > 196 * 1024
    {
        return Err(LocalRunnerError::invalid(
            "ACPX question set exceeds its 196 KiB durable byte bound",
        ));
    }
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
    required_id_with_limit(value, key, label, MAX_ID_CHARS)
}

fn required_id_with_limit(
    value: &Value,
    key: &str,
    label: &str,
    max_chars: usize,
) -> Result<String, LocalRunnerError> {
    let id = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid(format!("ACPX {label} omitted its identity")))?;
    if id.is_empty() || id.chars().count() > max_chars || id.chars().any(char::is_control) {
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
