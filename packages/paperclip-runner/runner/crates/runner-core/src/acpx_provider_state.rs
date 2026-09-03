use std::collections::BTreeMap;

use serde_json::Value;

use crate::acpx_event_payload::{
    decode_acpx_event, AcpxEventPayload, AcpxRuntimeEventKind, AcpxTurnStatus,
};
use crate::acpx_event_scope::AcpxEventScope;
use crate::acpx_sidecar_transport::AcpxSidecarEvent;
use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::ToolResult;
use crate::provider_events::{normalize_acpx_runtime_event, NormalizedProviderEvent};
use crate::stable_identity::project_acpx_runtime_request_id;

const MAX_ASSISTANT_TEXT_BYTES: usize = 1024 * 1024;
const MAX_PENDING_TOOLS: usize = 4_096;
const MAX_PENDING_TOOL_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PENDING_RUNTIME_REQUESTS: usize = 1_024;
const MAX_PENDING_RUNTIME_REQUEST_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const PRP_COMPLETION_TOOL_NAME: &str = "paperclip_finish";
pub(crate) const PRP_BLOCK_TOOL_NAME: &str = "paperclip_block";

pub(crate) fn is_reserved_terminal_operation(operation_id: &str) -> bool {
    matches!(operation_id, PRP_COMPLETION_TOOL_NAME | PRP_BLOCK_TOOL_NAME)
}

#[derive(Clone, Debug, PartialEq)]
pub struct AcpxPendingTool {
    pub operation_id: String,
    pub input: Value,
    pub(crate) input_digest: String,
    input_bytes: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AcpxSemanticResult {
    pub call_id: String,
    pub operation_id: String,
    pub ok: bool,
    pub result: Value,
    pub(crate) result_digest: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AcpxProviderStateEvent {
    Activity(NormalizedProviderEvent),
    ToolCall {
        call_id: String,
        operation_id: String,
        input: Value,
    },
    ToolResult(ToolResult),
    PermissionRequest {
        request_id: String,
        kind: String,
        title: String,
        details: Value,
    },
    InputRequest {
        request_id: String,
        question_set: Value,
        origin: Option<Value>,
    },
    SemanticResult(AcpxSemanticResult),
    AssistantMessage {
        turn_id: String,
        text: String,
    },
    TurnTerminal {
        turn_id: String,
        status: AcpxTurnStatus,
        error: Option<Value>,
    },
    Process(Value),
    Diagnostic {
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
struct PendingInput {
    runtime_request_id: String,
    value_bytes: usize,
    question_set: Value,
}

/// Reduces validated sidecar events into bounded provider state.
///
/// Raw sidecar values enter only through `accept_event`, which applies run and
/// turn authority before payload decoding. Transport commands remain outside
/// this reducer so callers can commit a pending resolution only after the
/// corresponding sidecar request succeeds.
#[derive(Clone, Debug, PartialEq)]
pub struct AcpxProviderState {
    scope: AcpxEventScope,
    provider_requests: u64,
    plan_revision: u64,
    assistant_text: String,
    assistant_message_id: Option<String>,
    pending_tools: BTreeMap<String, AcpxPendingTool>,
    pending_tool_input_bytes: usize,
    pending_permissions: BTreeMap<String, usize>,
    pending_inputs: BTreeMap<String, PendingInput>,
    pending_runtime_request_bytes: usize,
    semantic_result: Option<AcpxSemanticResult>,
}

impl AcpxProviderState {
    pub fn new(run_id: impl Into<String>) -> Result<Self, LocalRunnerError> {
        Ok(Self {
            scope: AcpxEventScope::new(run_id)?,
            provider_requests: 0,
            plan_revision: 0,
            assistant_text: String::new(),
            assistant_message_id: None,
            pending_tools: BTreeMap::new(),
            pending_tool_input_bytes: 0,
            pending_permissions: BTreeMap::new(),
            pending_inputs: BTreeMap::new(),
            pending_runtime_request_bytes: 0,
            semantic_result: None,
        })
    }

    pub fn run_id(&self) -> &str {
        self.scope.run_id()
    }

    pub fn active_turn_id(&self) -> Option<&str> {
        self.scope.active_turn_id()
    }

    pub(crate) fn has_settled_turns(&self) -> bool {
        self.scope.has_settled_turns()
    }

    pub(crate) fn validate_new_turn_identity(&self, turn_id: &str) -> Result<(), LocalRunnerError> {
        self.scope.validate_new_turn_identity(turn_id)
    }

    pub(crate) fn validate_new_turn_identity_for_provider_restart(
        &self,
        turn_id: &str,
    ) -> Result<(), LocalRunnerError> {
        self.scope
            .validate_new_turn_identity_for_provider_restart(turn_id)
    }

    pub(crate) fn settled_turn_identity_capacity_reached(&self) -> bool {
        self.scope.settled_turn_identity_capacity_reached()
    }

    pub(crate) fn rotate_settled_turn_identities_after_provider_restart(
        &mut self,
    ) -> Result<(), LocalRunnerError> {
        self.scope
            .rotate_settled_turn_identities_after_provider_restart()
    }

    pub fn has_pending_requests(&self) -> bool {
        !self.pending_tools.is_empty()
            || !self.pending_permissions.is_empty()
            || !self.pending_inputs.is_empty()
    }

    pub fn begin_turn(&mut self, turn_id: impl Into<String>) -> Result<(), LocalRunnerError> {
        if self.scope.active_turn_id().is_some()
            || !self.pending_tools.is_empty()
            || !self.pending_permissions.is_empty()
            || !self.pending_inputs.is_empty()
        {
            return Err(LocalRunnerError::invalid(
                "ACPX provider state cannot start a turn while work is active",
            ));
        }
        let next_provider_requests = self
            .provider_requests
            .checked_add(1)
            .ok_or_else(|| LocalRunnerError::invalid("ACPX provider request count is exhausted"))?;
        self.scope.bind_turn(turn_id)?;
        self.provider_requests = next_provider_requests;
        self.plan_revision = 0;
        self.assistant_text.clear();
        self.assistant_message_id = None;
        self.semantic_result = None;
        Ok(())
    }

    pub fn accept_event(
        &mut self,
        event: &AcpxSidecarEvent,
    ) -> Result<Vec<AcpxProviderStateEvent>, LocalRunnerError> {
        let payload = decode_acpx_event(&self.scope, event)?;
        match payload {
            AcpxEventPayload::Runtime {
                kind,
                tool_operation,
                payload,
                semantic_result_digest,
            } => self.accept_runtime_event(
                event,
                kind,
                tool_operation,
                payload,
                semantic_result_digest,
            ),
            AcpxEventPayload::PermissionRequested {
                request_id,
                kind,
                title,
                details,
            } => {
                let value_bytes = value_bytes(&details)?;
                self.admit_runtime_request(&request_id, value_bytes)?;
                if self
                    .pending_inputs
                    .values()
                    .any(|pending| pending.runtime_request_id == request_id)
                {
                    return Err(LocalRunnerError::invalid(
                        "ACPX permission request identity collides with a pending input projection",
                    ));
                }
                self.pending_permissions
                    .insert(request_id.clone(), value_bytes);
                self.pending_runtime_request_bytes += value_bytes;
                Ok(vec![AcpxProviderStateEvent::PermissionRequest {
                    request_id,
                    kind,
                    title,
                    details,
                }])
            }
            AcpxEventPayload::InputRequested {
                request_id,
                question_set,
                origin,
            } => {
                let value_bytes = value_bytes(&question_set)?;
                self.admit_runtime_request(&request_id, value_bytes)?;
                let runtime_request_id = project_acpx_runtime_request_id(&request_id)
                    .expect("a decoded ACPX input request has a bounded identity");
                if self
                    .pending_inputs
                    .values()
                    .any(|pending| pending.runtime_request_id == runtime_request_id)
                    || self.pending_permissions.contains_key(&runtime_request_id)
                {
                    return Err(LocalRunnerError::invalid(
                        "ACPX input request identity collides after durable projection",
                    ));
                }
                if self
                    .pending_inputs
                    .insert(
                        request_id.clone(),
                        PendingInput {
                            runtime_request_id,
                            value_bytes,
                            question_set: question_set.clone(),
                        },
                    )
                    .is_some()
                {
                    return Err(LocalRunnerError::invalid(
                        "ACPX reused a pending input request id",
                    ));
                }
                self.pending_runtime_request_bytes += value_bytes;
                Ok(vec![AcpxProviderStateEvent::InputRequest {
                    request_id,
                    question_set,
                    origin,
                }])
            }
            AcpxEventPayload::ToolCalled {
                call_id,
                operation_id,
                input,
                input_digest,
            } => {
                let input_bytes = value_bytes(&input)?;
                if self.pending_tools.len() >= MAX_PENDING_TOOLS
                    || self
                        .pending_tool_input_bytes
                        .checked_add(input_bytes)
                        .is_none_or(|bytes| bytes > MAX_PENDING_TOOL_INPUT_BYTES)
                {
                    return Err(LocalRunnerError::invalid(
                        "ACPX pending tool calls exceed their bounded capacity",
                    ));
                }
                if self.pending_tools.contains_key(&call_id) {
                    return Err(LocalRunnerError::invalid(
                        "ACPX reused a pending tool call id",
                    ));
                }
                self.pending_tools.insert(
                    call_id.clone(),
                    AcpxPendingTool {
                        operation_id: operation_id.clone(),
                        input: input.clone(),
                        input_digest,
                        input_bytes,
                    },
                );
                self.pending_tool_input_bytes += input_bytes;
                Ok(vec![AcpxProviderStateEvent::ToolCall {
                    call_id,
                    operation_id,
                    input,
                }])
            }
            AcpxEventPayload::TurnTerminal { status, error } => {
                let turn_id = event
                    .turn_id
                    .as_deref()
                    .expect("a decoded terminal event has a turn binding")
                    .to_owned();
                self.scope.clear_turn(&turn_id)?;
                self.clear_pending_requests();
                let mut events = Vec::new();
                if status == AcpxTurnStatus::Completed && !self.assistant_text.is_empty() {
                    events.push(AcpxProviderStateEvent::AssistantMessage {
                        turn_id: turn_id.clone(),
                        text: std::mem::take(&mut self.assistant_text),
                    });
                } else {
                    self.assistant_text.clear();
                }
                self.assistant_message_id = None;
                events.push(AcpxProviderStateEvent::TurnTerminal {
                    turn_id,
                    status,
                    error,
                });
                Ok(events)
            }
            AcpxEventPayload::Process { details } => {
                Ok(vec![AcpxProviderStateEvent::Process(details)])
            }
            AcpxEventPayload::Diagnostic { code, message } => {
                Ok(vec![AcpxProviderStateEvent::Diagnostic { code, message }])
            }
        }
    }

    pub fn pending_tool(&self, call_id: &str) -> Option<&AcpxPendingTool> {
        self.pending_tools.get(call_id)
    }

    pub fn has_pending_tools(&self) -> bool {
        !self.pending_tools.is_empty()
    }

    pub fn complete_tool(
        &mut self,
        call_id: &str,
        operation_id: &str,
    ) -> Result<(), LocalRunnerError> {
        let pending = self.pending_tools.get(call_id).ok_or_else(|| {
            LocalRunnerError::invalid("ACPX tool result has no pending sidecar call")
        })?;
        if pending.operation_id != operation_id {
            return Err(LocalRunnerError::invalid(
                "ACPX tool result operation mismatch",
            ));
        }
        let pending = self.pending_tools.remove(call_id).ok_or_else(|| {
            LocalRunnerError::invalid("ACPX pending tool disappeared during completion")
        })?;
        self.pending_tool_input_bytes = self
            .pending_tool_input_bytes
            .saturating_sub(pending.input_bytes);
        Ok(())
    }

    pub fn complete_permission(&mut self, request_id: &str) -> Result<(), LocalRunnerError> {
        let value_bytes = self.pending_permissions.remove(request_id).ok_or_else(|| {
            LocalRunnerError::invalid("ACPX permission result has no pending request")
        })?;
        self.pending_runtime_request_bytes = self
            .pending_runtime_request_bytes
            .saturating_sub(value_bytes);
        Ok(())
    }

    pub fn complete_input(&mut self, request_id: &str) -> Result<(), LocalRunnerError> {
        let provider_request_id = self
            .pending_inputs
            .iter()
            .find_map(|(provider_request_id, pending)| {
                (pending.runtime_request_id == request_id).then(|| provider_request_id.clone())
            })
            .ok_or_else(|| LocalRunnerError::invalid("ACPX input result has no pending request"))?;
        let pending = self
            .pending_inputs
            .remove(&provider_request_id)
            .ok_or_else(|| LocalRunnerError::invalid("ACPX input result has no pending request"))?;
        self.pending_runtime_request_bytes = self
            .pending_runtime_request_bytes
            .saturating_sub(pending.value_bytes);
        Ok(())
    }

    pub fn pending_question_set(&self, request_id: &str) -> Option<&Value> {
        self.pending_inputs
            .values()
            .find(|pending| pending.runtime_request_id == request_id)
            .map(|pending| &pending.question_set)
    }

    pub(crate) fn pending_provider_input_request_id(&self, request_id: &str) -> Option<&str> {
        self.pending_inputs
            .iter()
            .find(|(_, pending)| pending.runtime_request_id == request_id)
            .map(|(provider_request_id, _)| provider_request_id.as_str())
    }

    pub fn semantic_result(&self) -> Option<&AcpxSemanticResult> {
        self.semantic_result.as_ref()
    }

    fn accept_runtime_event(
        &mut self,
        event: &AcpxSidecarEvent,
        kind: AcpxRuntimeEventKind,
        tool_operation: Option<&'static str>,
        mut payload: Value,
        semantic_result_digest: Option<String>,
    ) -> Result<Vec<AcpxProviderStateEvent>, LocalRunnerError> {
        let next_plan_revision = if kind == AcpxRuntimeEventKind::Plan {
            let revision = self
                .plan_revision
                .checked_add(1)
                .ok_or_else(|| LocalRunnerError::invalid("ACPX plan revision is exhausted"))?;
            payload
                .as_object_mut()
                .expect("a decoded ACPX runtime plan is an object")
                .insert("revision".to_owned(), Value::from(revision));
            Some(revision)
        } else {
            None
        };
        if kind == AcpxRuntimeEventKind::TextDelta {
            let provider_message_id = payload
                .get("messageId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            let starts_new_message = provider_message_id.as_ref().is_some_and(|message_id| {
                self.assistant_message_id
                    .as_ref()
                    .is_some_and(|current| current != message_id)
            });
            let raw_text = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // ACP can produce more than one assistant message in a turn. All
            // deltas remain durable progress, but only the latest compatible
            // provider message is eligible to become the terminal reply.
            // Folding earlier messages into it duplicates the transcript in
            // the task UI and can promote intermediate prose as final output.
            if starts_new_message {
                self.assistant_text.clear();
            }
            if self
                .assistant_text
                .len()
                .checked_add(raw_text.len())
                .is_none_or(|bytes| bytes > MAX_ASSISTANT_TEXT_BYTES)
            {
                return Err(LocalRunnerError::invalid(
                    "ACPX assistant text exceeds its retained limit",
                ));
            }
            self.assistant_text.push_str(raw_text);
            if provider_message_id.is_some() {
                self.assistant_message_id = provider_message_id;
            }
        }
        if kind == AcpxRuntimeEventKind::SemanticResult {
            let result = AcpxSemanticResult {
                call_id: payload
                    .get("callId")
                    .and_then(Value::as_str)
                    .expect("decoded ACPX semantic result has a call id")
                    .to_owned(),
                operation_id: payload
                    .get("operationId")
                    .and_then(Value::as_str)
                    .expect("decoded ACPX semantic result has an operation id")
                    .to_owned(),
                ok: payload
                    .get("ok")
                    .and_then(Value::as_bool)
                    .expect("decoded ACPX semantic result has an outcome"),
                result: payload
                    .get("result")
                    .expect("decoded ACPX semantic result has a result")
                    .clone(),
                result_digest: semantic_result_digest
                    .expect("decoded ACPX semantic result has a raw correlation digest"),
            };
            if is_reserved_terminal_operation(&result.operation_id) {
                return match self.semantic_result.as_ref() {
                    None => {
                        self.semantic_result = Some(result.clone());
                        Ok(vec![AcpxProviderStateEvent::SemanticResult(result)])
                    }
                    Some(existing) if existing == &result => Ok(Vec::new()),
                    Some(_) => Err(LocalRunnerError::invalid(
                        "ACPX emitted conflicting terminal semantic results for one turn",
                    )),
                };
            }
            // Dynamic results are independently authorized and deduplicated
            // by call ID in ProviderToolBridge. They must not compete for the
            // turn-wide terminal-result slot.
            return Ok(vec![AcpxProviderStateEvent::SemanticResult(result)]);
        }
        let turn_id = event
            .turn_id
            .as_deref()
            .expect("a decoded runtime event has a turn binding");
        let fallback_item_id = format!("acpx-event-{}", event.sequence);
        let events = normalize_acpx_runtime_event(
            kind,
            &payload,
            tool_operation,
            &fallback_item_id,
            turn_id,
            self.provider_requests,
        );
        if let Some(revision) = next_plan_revision {
            self.plan_revision = revision;
        }
        Ok(events
            .into_iter()
            .map(AcpxProviderStateEvent::Activity)
            .collect())
    }

    fn admit_runtime_request(
        &self,
        request_id: &str,
        value_bytes: usize,
    ) -> Result<(), LocalRunnerError> {
        if self.pending_permissions.contains_key(request_id)
            || self.pending_inputs.contains_key(request_id)
        {
            return Err(LocalRunnerError::invalid(
                "ACPX reused a pending runtime request id",
            ));
        }
        if self.pending_permissions.len() + self.pending_inputs.len()
            >= MAX_PENDING_RUNTIME_REQUESTS
            || self
                .pending_runtime_request_bytes
                .checked_add(value_bytes)
                .is_none_or(|bytes| bytes > MAX_PENDING_RUNTIME_REQUEST_BYTES)
        {
            return Err(LocalRunnerError::invalid(
                "ACPX pending runtime requests exceed their bounded capacity",
            ));
        }
        Ok(())
    }

    fn clear_pending_requests(&mut self) {
        self.pending_tools.clear();
        self.pending_tool_input_bytes = 0;
        self.pending_permissions.clear();
        self.pending_inputs.clear();
        self.pending_runtime_request_bytes = 0;
    }
}

fn value_bytes(value: &Value) -> Result<usize, LocalRunnerError> {
    serde_json::to_vec(value)
        .map(|value| value.len())
        .map_err(|error| {
            LocalRunnerError::invalid(format!("ACPX retained value is invalid: {error}"))
        })
}
