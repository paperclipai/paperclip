use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const TOOL_SET_SCHEMA: &str = "paperclip.runner.authorized-tools.v1";
pub const TOOL_CALL_SCHEMA: &str = "paperclip.prp.semantic_tool.v1";
pub const TOOL_RESULT_COMMAND: &str = "semantic_tool.result";
const MAX_AUTHORIZED_TOOLS: usize = 256;
const MAX_DESCRIPTION_BYTES: usize = 16 * 1024;
const MAX_SCHEMA_BYTES: usize = 1024 * 1024;
const MAX_TOOL_SET_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOOL_VALUE_BYTES: usize = 1024 * 1024;
const MAX_RETAINED_CALLS: usize = 4_096;
const MAX_SETTLED_CALL_IDS: usize = 65_536;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedTool {
    pub operation_id: String,
    pub version: u64,
    pub description: String,
    pub input_schema: Value,
    pub response_schema: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedToolSet {
    pub schema: String,
    pub schema_version: u64,
    pub catalog_digest: String,
    pub operations: Vec<AuthorizedTool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingToolCall {
    pub call_id: String,
    pub operation_id: String,
    pub input: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub call_id: String,
    pub operation_id: String,
    pub result: Value,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToolBridge {
    authorized: BTreeMap<String, AuthorizedTool>,
    catalog_digest: Option<String>,
    pending: BTreeMap<String, PendingToolCall>,
    completed: BTreeMap<String, ToolResult>,
    #[serde(default)]
    settled_call_ids: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderBridgeError(String);

impl ProviderBridgeError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for ProviderBridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ProviderBridgeError {}

impl ProviderToolBridge {
    pub fn prepare(&mut self, tool_set: AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        self.prepare_internal(tool_set, false)
    }

    pub fn attach_run(&mut self, tool_set: AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot attach a new run while provider tool calls are pending",
            ));
        }
        self.prepare_internal(tool_set, true)?;
        self.completed.clear();
        self.settled_call_ids.clear();
        Ok(())
    }

    pub fn attach_existing_run(&mut self) -> Result<(), ProviderBridgeError> {
        // Pending calls are durable run state. Re-attaching the same run must
        // preserve them so an interrupted dispatcher can resume or replay the
        // authoritative result. `attach_run` remains the boundary that rejects
        // carrying pending calls into a different run.
        if self.settled_call_ids.len() > MAX_SETTLED_CALL_IDS
            || self
                .settled_call_ids
                .iter()
                .any(|call_id| !is_stable_call_id(call_id))
            || self.settled_call_ids.iter().any(|call_id| {
                self.pending.contains_key(call_id) || self.completed.contains_key(call_id)
            })
        {
            return Err(ProviderBridgeError::invalid(
                "recovered settled provider tool call identities are invalid",
            ));
        }
        Ok(())
    }

    fn prepare_internal(
        &mut self,
        tool_set: AuthorizedToolSet,
        allow_catalog_change: bool,
    ) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot change authorized tools while provider calls are pending",
            ));
        }
        if tool_set.schema != TOOL_SET_SCHEMA || tool_set.schema_version != 1 {
            return Err(ProviderBridgeError::invalid(
                "unsupported authorized tool-set contract",
            ));
        }
        if !is_sha256_digest(&tool_set.catalog_digest) {
            return Err(ProviderBridgeError::invalid(
                "authorized tool set requires a canonical sha256 catalog digest",
            ));
        }
        if tool_set.operations.len() > MAX_AUTHORIZED_TOOLS {
            return Err(ProviderBridgeError::invalid(
                "authorized tool set exceeds the operation limit",
            ));
        }
        bounded_json(&tool_set, MAX_TOOL_SET_BYTES, "authorized tool set")?;
        let mut names = BTreeSet::new();
        for tool in &tool_set.operations {
            validate_operation_id(&tool.operation_id)?;
            if tool.version != 1 {
                return Err(ProviderBridgeError::invalid(format!(
                    "unsupported tool version for {}",
                    tool.operation_id
                )));
            }
            if tool.description.trim().is_empty()
                || tool.description.len() > MAX_DESCRIPTION_BYTES
                || tool.description.contains('\0')
                || !tool.input_schema.is_object()
                || !tool.response_schema.is_object()
            {
                return Err(ProviderBridgeError::invalid(format!(
                    "tool {} has an incomplete provider contract",
                    tool.operation_id
                )));
            }
            bounded_json(
                &tool.input_schema,
                MAX_SCHEMA_BYTES,
                "tool input JSON Schema",
            )?;
            bounded_json(
                &tool.response_schema,
                MAX_SCHEMA_BYTES,
                "tool response JSON Schema",
            )?;
            jsonschema::validator_for(&tool.input_schema).map_err(|_| {
                ProviderBridgeError::invalid(format!(
                    "tool {} has an invalid input JSON Schema",
                    tool.operation_id
                ))
            })?;
            jsonschema::validator_for(&tool.response_schema).map_err(|_| {
                ProviderBridgeError::invalid(format!(
                    "tool {} has an invalid response JSON Schema",
                    tool.operation_id
                ))
            })?;
            if !names.insert(tool.operation_id.clone()) {
                return Err(ProviderBridgeError::invalid(
                    "authorized tool names must be unique",
                ));
            }
        }
        let computed_digest = authorized_tool_catalog_digest(&tool_set.operations)?;
        if tool_set.catalog_digest != computed_digest {
            return Err(ProviderBridgeError::invalid(
                "authorized tool catalog digest does not match its operations",
            ));
        }
        if !allow_catalog_change {
            if let Some(existing) = &self.catalog_digest {
                if existing != &tool_set.catalog_digest {
                    return Err(ProviderBridgeError::invalid(
                        "authorized tool set changed across a durable session",
                    ));
                }
            }
        }
        self.catalog_digest = Some(tool_set.catalog_digest);
        self.authorized = tool_set
            .operations
            .into_iter()
            .map(|tool| (tool.operation_id.clone(), tool))
            .collect();
        Ok(())
    }

    pub fn authorized_tools(&self) -> impl Iterator<Item = &AuthorizedTool> {
        self.authorized.values()
    }

    pub fn begin_call(
        &mut self,
        call_id: String,
        operation_id: String,
        input: Value,
    ) -> Result<PendingToolCall, ProviderBridgeError> {
        if !is_stable_call_id(&call_id) {
            return Err(ProviderBridgeError::invalid("tool call id is invalid"));
        }
        validate_operation_id(&operation_id)?;
        let authorized = self.authorized.get(&operation_id).ok_or_else(|| {
            ProviderBridgeError::invalid(format!(
                "provider requested unauthorized tool {operation_id}"
            ))
        })?;
        let validator = jsonschema::validator_for(&authorized.input_schema).map_err(|_| {
            ProviderBridgeError::invalid(format!(
                "tool {operation_id} has an invalid durable input JSON Schema"
            ))
        })?;
        if !validator.is_valid(&input) {
            return Err(ProviderBridgeError::invalid(format!(
                "provider arguments for {operation_id} failed JSON Schema validation"
            )));
        }
        bounded_json(&input, MAX_TOOL_VALUE_BYTES, "provider tool input")?;
        let call = PendingToolCall {
            call_id: call_id.clone(),
            operation_id,
            input,
        };
        if let Some(existing) = self.pending.get(&call_id) {
            return if existing == &call {
                Ok(existing.clone())
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate provider tool call",
                ))
            };
        }
        if self.completed.contains_key(&call_id) || self.settled_call_ids.contains(&call_id) {
            return Err(ProviderBridgeError::invalid(
                "provider reused a completed tool call id",
            ));
        }
        if self.pending.len().saturating_add(self.completed.len()) >= MAX_RETAINED_CALLS {
            return Err(ProviderBridgeError::invalid(
                "provider tool receipt limit reached for the active turn",
            ));
        }
        self.pending.insert(call_id, call.clone());
        Ok(call)
    }

    pub fn apply_result(&mut self, result: ToolResult) -> Result<Value, ProviderBridgeError> {
        if result.call_id.is_empty()
            || result.call_id.len() > 160
            || result.call_id.chars().any(char::is_control)
        {
            return Err(ProviderBridgeError::invalid(
                "tool result call id is invalid",
            ));
        }
        validate_operation_id(&result.operation_id)?;
        bounded_json(&result.result, MAX_TOOL_VALUE_BYTES, "provider tool result")?;
        if let Some(existing) = self.completed.get(&result.call_id) {
            return if existing == &result {
                Ok(existing.result.clone())
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate tool result",
                ))
            };
        }
        let pending = self.pending.get(&result.call_id).ok_or_else(|| {
            ProviderBridgeError::invalid("tool result does not match a pending provider call")
        })?;
        if pending.operation_id != result.operation_id {
            return Err(ProviderBridgeError::invalid(
                "tool result operation does not match its call",
            ));
        }
        let authorized = self.authorized.get(&result.operation_id).ok_or_else(|| {
            ProviderBridgeError::invalid("tool result operation is no longer authorized")
        })?;
        let validator = jsonschema::validator_for(&authorized.response_schema).map_err(|_| {
            ProviderBridgeError::invalid(format!(
                "tool {} has an invalid durable response JSON Schema",
                result.operation_id
            ))
        })?;
        let response = semantic_response_value(&result)?;
        if !result.is_error {
            // Paperclip semantic dispatchers return an authoritative envelope;
            // provider contracts describe the operation-specific value inside
            // `result`. Direct values remain valid for compatibility with v1
            // peers that do not wrap their semantic result.
            if let Some(response) = response {
                if !validator.is_valid(response) {
                    return Err(ProviderBridgeError::invalid(format!(
                        "tool result for {} failed JSON Schema validation",
                        result.operation_id
                    )));
                }
            }
        }
        self.pending.remove(&result.call_id);
        self.completed
            .insert(result.call_id.clone(), result.clone());
        Ok(result.result)
    }

    pub fn settle_turn(&mut self) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot settle provider tool receipts while calls are pending",
            ));
        }
        if self
            .settled_call_ids
            .len()
            .checked_add(self.completed.len())
            .is_none_or(|total| total > MAX_SETTLED_CALL_IDS)
        {
            return Err(ProviderBridgeError::invalid(
                "durable provider tool call identity limit reached",
            ));
        }
        // Exact results are turn-scoped, but their IDs remain durable for the
        // lifetime of the run so a provider retry cannot dispatch the same
        // semantic action again after a turn boundary or recovery.
        self.settled_call_ids.extend(self.completed.keys().cloned());
        self.completed.clear();
        Ok(())
    }

    pub fn pending_calls(&self) -> impl Iterator<Item = &PendingToolCall> {
        self.pending.values()
    }
}

fn is_stable_call_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160 && !value.chars().any(char::is_control)
}

pub fn authorized_tool_catalog_digest(
    operations: &[AuthorizedTool],
) -> Result<String, ProviderBridgeError> {
    let value = serde_json::to_value(operations)
        .map_err(|_| ProviderBridgeError::invalid("authorized tool catalog is not serializable"))?;
    let canonical = canonical_json(&value);
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(format!("sha256:{digest:x}"))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => {
            serde_json::to_string(value).expect("serializing an in-memory JSON string cannot fail")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key)
                            .expect("serializing an in-memory JSON key cannot fail"),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn semantic_response_value(result: &ToolResult) -> Result<Option<&Value>, ProviderBridgeError> {
    let Some(envelope) = result.result.as_object() else {
        return Ok(Some(&result.result));
    };
    let Some(ok) = envelope.get("ok").and_then(Value::as_bool) else {
        return Ok(Some(&result.result));
    };
    if !envelope.contains_key("operationId") && !envelope.contains_key("callId") {
        return Ok(Some(&result.result));
    }
    if envelope.get("operationId").and_then(Value::as_str) != Some(&result.operation_id)
        || envelope.get("callId").and_then(Value::as_str) != Some(&result.call_id)
    {
        return Err(ProviderBridgeError::invalid(
            "semantic result envelope does not match its provider call",
        ));
    }
    if ok {
        envelope.get("result").map(Some).ok_or_else(|| {
            ProviderBridgeError::invalid("successful semantic result omitted result")
        })
    } else if envelope.get("denial").is_some() || envelope.get("error").is_some() {
        Ok(None)
    } else {
        Err(ProviderBridgeError::invalid(
            "failed semantic result omitted denial or error",
        ))
    }
}

fn validate_operation_id(value: &str) -> Result<(), ProviderBridgeError> {
    let mut chars = value.chars();
    let first = chars
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric());
    let rest = chars.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
    });
    if first && rest && value.len() <= 160 {
        Ok(())
    } else {
        Err(ProviderBridgeError::invalid("tool operation id is invalid"))
    }
}

fn is_sha256_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_json(
    value: &impl Serialize,
    max_bytes: usize,
    label: &str,
) -> Result<(), ProviderBridgeError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| ProviderBridgeError::invalid(format!("{label} is not serializable")))?;
    if bytes.len() > max_bytes {
        return Err(ProviderBridgeError::invalid(format!(
            "{label} exceeds the {max_bytes} byte limit"
        )));
    }
    Ok(())
}
