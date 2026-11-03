use std::collections::BTreeSet;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

use crate::durable::DurableRunnerError;

use super::{invalid, MAX_FRAME_BYTES, WIRE_SCHEMA};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WireEvent {
    pub(super) schema: String,
    pub(super) sequence: u64,
    pub(super) event_type: String,
    pub(super) priority: String,
    #[serde(default)]
    pub(super) turn_id: Option<String>,
    #[serde(default)]
    pub(super) item_id: Option<String>,
    pub(super) payload: Value,
}

pub(super) fn parse_frame(line: &str) -> Result<Value, DurableRunnerError> {
    if line.len() > MAX_FRAME_BYTES {
        return Err(invalid("extension frame exceeds its bound"));
    }
    let value: Value =
        serde_json::from_str(line).map_err(|_| invalid("extension emitted malformed JSON"))?;
    validate_json_bound(&value, 0, &mut 0)?;
    if value.get("schema").and_then(Value::as_str) != Some(WIRE_SCHEMA) {
        return Err(invalid("unsupported extension protocol schema"));
    }
    Ok(value)
}
pub(super) fn validate_json_bound(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), DurableRunnerError> {
    *nodes += 1;
    if depth > 64 || *nodes > 65_536 {
        return Err(invalid("extension JSON exceeds its structural bounds"));
    }
    match value {
        Value::Object(values) => {
            for value in values.values() {
                validate_json_bound(value, depth + 1, nodes)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_json_bound(value, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn provider_event(event: &str) -> bool {
    // The language-neutral PRP inventory remains authoritative. The extension
    // supplies provider facts, never transport or control-plane decisions.
    static PROVIDER_EVENTS: OnceLock<BTreeSet<String>> = OnceLock::new();
    let known = PROVIDER_EVENTS.get_or_init(|| {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../../protocol/schemas/event.schema.json"
        ))
        .expect("checked-in event schema is valid JSON");
        schema
            .pointer("/properties/eventType/enum")
            .and_then(Value::as_array)
            .expect("event schema declares its inventory")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    });
    known.contains(event)
        && ![
            "runner.",
            "auth.",
            "issue.",
            "work.",
            "attention.",
            "interaction.",
        ]
        .iter()
        .any(|prefix| event.starts_with(prefix))
        && !matches!(
            event,
            "run.terminal"
                | "run.result.accepted"
                | "run.result.rejected"
                | "run.attached"
                | "run.detached"
                | "harness.exited"
        )
}
pub(super) fn terminal_state(event: &str) -> Option<(&'static str, &'static str)> {
    match event {
        "turn.completed" => Some(("completed", "succeeded")),
        "turn.failed" => Some(("failed", "failed")),
        "turn.interrupted" => Some(("interrupted", "cancelled")),
        "turn.cancelled" => Some(("cancelled", "cancelled")),
        _ => None,
    }
}
