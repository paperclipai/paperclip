use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::acpx_provider_state::{
    is_reserved_terminal_operation, AcpxProviderState, AcpxProviderStateEvent, PRP_BLOCK_TOOL_NAME,
    PRP_COMPLETION_TOOL_NAME,
};
use crate::acpx_sidecar_transport::{AcpxSidecarTransport, AcpxSidecarTransportConfig};
use crate::generated_acpx_sidecar_contract::{
    GeneratedAcpxSidecarCommand, GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
};
use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet, ProviderToolBridge,
    ToolResult, TOOL_SET_SCHEMA,
};
use crate::question_response::validate_question_response;
use crate::stable_identity::{is_stable_id, DURABLE_STABLE_ID_CHARS, SHORT_STABLE_ID_CHARS};

const MAX_ID_CHARS: usize = 240;
const MAX_MODEL_CHARS: usize = 240;
const MAX_SYSTEM_INSTRUCTIONS_BYTES: usize = 1024 * 1024;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AcpxPermissionMode {
    ApproveAll,
    ApproveReads,
    DenyAll,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpxProviderSessionIdentity {
    pub kind: String,
    pub normalized_session_id: String,
    pub acpx_record_id: String,
    pub backend_session_id: String,
    pub agent_session_id: String,
    pub profile_digest: String,
    pub workspace_digest: String,
    pub requested_model: String,
    pub effective_model: String,
    #[serde(default)]
    pub permission_mode: Option<AcpxPermissionMode>,
}

#[derive(Clone, Debug)]
pub struct AcpxProviderSessionConfig {
    pub transport: AcpxSidecarTransportConfig,
    pub agent: String,
    pub model: String,
    pub run_id: String,
    pub catalog_revision: u64,
    pub runtime_directory: PathBuf,
    pub normalized_session_id: String,
    pub working_directory: PathBuf,
    pub permission_mode: AcpxPermissionMode,
    pub permission_mode_pinned: bool,
    pub system_instructions: String,
    pub tool_set: AuthorizedToolSet,
    pub expected_identity: Option<AcpxProviderSessionIdentity>,
}

impl AcpxProviderSessionConfig {
    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        self.transport.validate()?;
        let qualified_model = match self.agent.as_str() {
            "claude" => "claude-sonnet-5",
            "codex" => "gpt-5.6-sol",
            _ => {
                return Err(LocalRunnerError::invalid(
                    "ACPX agent must be claude or codex",
                ))
            }
        };
        if self.model != qualified_model {
            return Err(LocalRunnerError::invalid(format!(
                "ACPX {} profile requires exact model {qualified_model}",
                self.agent
            )));
        }
        validate_text(&self.model, MAX_MODEL_CHARS, "ACPX model")?;
        validate_stable_id(&self.run_id, SHORT_STABLE_ID_CHARS, "ACPX run id")?;
        validate_stable_id(
            &self.normalized_session_id,
            SHORT_STABLE_ID_CHARS,
            "ACPX normalized session id",
        )?;
        if self.catalog_revision == 0 || self.catalog_revision > MAX_JSON_SAFE_INTEGER {
            return Err(LocalRunnerError::invalid(
                "ACPX catalog revision must be a positive JSON-safe integer",
            ));
        }
        for (path, label) in [
            (&self.runtime_directory, "runtime directory"),
            (&self.working_directory, "working directory"),
        ] {
            if !path.is_absolute() {
                return Err(LocalRunnerError::invalid(format!(
                    "ACPX {label} must be an existing absolute directory"
                )));
            }
            if path.to_str().is_none() {
                return Err(LocalRunnerError::invalid(format!(
                    "ACPX {label} must be valid UTF-8"
                )));
            }
            if !path.is_dir() {
                return Err(LocalRunnerError::invalid(format!(
                    "ACPX {label} must be an existing absolute directory"
                )));
            }
        }
        if !self.permission_mode_pinned {
            return Err(LocalRunnerError::invalid(
                "ACPX permission mode must be pinned by the runner policy",
            ));
        }
        if self.system_instructions.len() > MAX_SYSTEM_INSTRUCTIONS_BYTES
            || self.system_instructions.contains('\0')
        {
            return Err(LocalRunnerError::invalid(
                "ACPX system instructions exceed their bounded contract",
            ));
        }
        if self
            .tool_set
            .operations
            .iter()
            .any(|tool| is_reserved_terminal_operation(&tool.operation_id))
        {
            return Err(LocalRunnerError::invalid(
                "ACPX run catalog cannot replace reserved terminal tools",
            ));
        }
        let mut bridge = ProviderToolBridge::default();
        bridge.prepare(self.tool_set.clone()).map_err(|error| {
            LocalRunnerError::invalid(format!("ACPX authorized tools are invalid: {error}"))
        })?;
        reserved_terminal_tool_bridge()?;
        if let Some(expected_identity) = self.expected_identity.as_ref() {
            expected_identity.validate()?;
            if expected_identity.normalized_session_id != self.normalized_session_id
                || expected_identity.requested_model != self.model
                || expected_identity.effective_model != self.model
                || expected_identity.permission_mode != Some(self.permission_mode)
            {
                return Err(LocalRunnerError::invalid(
                    "ACPX expected identity conflicts with the requested session",
                ));
            }
        }
        Ok(())
    }
}

impl AcpxProviderSessionIdentity {
    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        if self.kind != "acpx" {
            return Err(LocalRunnerError::invalid(
                "ACPX session identity kind is invalid",
            ));
        }
        for (value, label) in [
            (&self.normalized_session_id, "normalized session"),
            (&self.acpx_record_id, "record"),
            (&self.backend_session_id, "backend session"),
            (&self.agent_session_id, "agent session"),
            (&self.requested_model, "requested model"),
            (&self.effective_model, "effective model"),
        ] {
            validate_text(value, MAX_ID_CHARS, &format!("ACPX {label} identity"))?;
        }
        for (value, label) in [
            (&self.profile_digest, "profile"),
            (&self.workspace_digest, "workspace"),
        ] {
            if !is_sha256_digest(value) {
                return Err(LocalRunnerError::invalid(format!(
                    "ACPX {label} digest is invalid"
                )));
            }
        }
        Ok(())
    }
}

pub struct AcpxProviderSession {
    transport: AcpxSidecarTransport,
    config: AcpxProviderSessionConfig,
    state: AcpxProviderState,
    tool_bridge: ProviderToolBridge,
    reserved_tool_bridge: ProviderToolBridge,
    identity: AcpxProviderSessionIdentity,
    catalog_revision: u64,
    working_directory: PathBuf,
    closed: bool,
    transport_terminated: bool,
}

impl AcpxProviderSession {
    pub fn start(config: &AcpxProviderSessionConfig) -> Result<Self, LocalRunnerError> {
        config.validate()?;
        let mut tool_bridge = ProviderToolBridge::default();
        tool_bridge
            .prepare(config.tool_set.clone())
            .map_err(|error| {
                LocalRunnerError::invalid(format!("ACPX authorized tools are invalid: {error}"))
            })?;
        let reserved_tool_bridge = reserved_terminal_tool_bridge()?;
        let mut transport = AcpxSidecarTransport::start(&config.transport)?;
        let bootstrap = bootstrap(&mut transport, config);
        let (identity, state) = match bootstrap {
            Ok(value) => value,
            Err(error) => {
                let cleanup = transport.shutdown();
                return Err(with_cleanup_error(error, cleanup));
            }
        };
        Ok(Self {
            transport,
            config: config.clone(),
            state,
            tool_bridge,
            reserved_tool_bridge,
            identity,
            catalog_revision: config.catalog_revision,
            working_directory: config.working_directory.clone(),
            closed: false,
            transport_terminated: false,
        })
    }

    pub fn process_id(&self) -> u32 {
        self.transport.process_id()
    }

    pub fn identity(&self) -> &AcpxProviderSessionIdentity {
        &self.identity
    }

    pub fn state(&self) -> &AcpxProviderState {
        &self.state
    }

    pub fn catalog_revision(&self) -> u64 {
        self.catalog_revision
    }

    pub fn start_turn(
        &mut self,
        turn_id: &str,
        message: &str,
        working_directory: &Path,
    ) -> Result<Value, LocalRunnerError> {
        self.ensure_open()?;
        validate_stable_id(turn_id, DURABLE_STABLE_ID_CHARS, "ACPX turn id")?;
        validate_turn_message(message)?;
        if working_directory != self.working_directory {
            return Err(LocalRunnerError::invalid(
                "ACPX turn working directory differs from its immutable session workspace",
            ));
        }
        if self.state.active_turn_id().is_some() {
            return Err(LocalRunnerError::invalid(
                "ACPX provider session already has an active turn",
            ));
        }
        let rotate_turn_identity_ledger = self.state.settled_turn_identity_capacity_reached();
        let identity_validation = if rotate_turn_identity_ledger {
            self.state
                .validate_new_turn_identity_for_provider_restart(turn_id)
        } else {
            self.state.validate_new_turn_identity(turn_id)
        };
        if let Err(error) = identity_validation {
            // Reusing a settled identity would let a delayed event from the
            // old turn alias the new receipt epoch. A full sidecar restart is
            // required before an exhausted ledger can rotate, while an exact
            // identity reuse remains forbidden within the current ledger.
            return Err(self.fail_closed(error));
        }
        // The MCP endpoint is session-lifetime and cannot authenticate which
        // provider turn originated a late HTTP callback. Reap the old sidecar
        // and provider before releasing its call-ID tombstones, then resume
        // the same verified persistent session in a fresh process generation.
        let provider_restarted = self.state.has_settled_turns();
        if provider_restarted {
            if let Err(error) = self.restart_idle_provider() {
                return Err(self.fail_closed(error));
            }
        }
        if rotate_turn_identity_ledger {
            if let Err(error) = self
                .state
                .rotate_settled_turn_identities_after_provider_restart()
            {
                return Err(self.fail_closed(error));
            }
        }
        // Prepare cloned receipt epochs before asking the replacement sidecar
        // to start work, then publish them only after both the provider and
        // reducer accept the new turn.
        let mut next_tool_bridge = self.tool_bridge.clone();
        let dynamic_preparation = if provider_restarted {
            next_tool_bridge.prepare_turn_after_provider_restart()
        } else {
            next_tool_bridge.prepare_turn()
        };
        if let Err(error) = dynamic_preparation {
            return Err(self.fail_closed(LocalRunnerError::invalid(format!(
                "ACPX dynamic tool receipt rotation failed: {error}"
            ))));
        }
        let mut next_reserved_tool_bridge = self.reserved_tool_bridge.clone();
        let reserved_preparation = if provider_restarted {
            next_reserved_tool_bridge.prepare_turn_after_provider_restart()
        } else {
            next_reserved_tool_bridge.prepare_turn()
        };
        if let Err(error) = reserved_preparation {
            return Err(self.fail_closed(LocalRunnerError::invalid(format!(
                "ACPX reserved tool receipt rotation failed: {error}"
            ))));
        }
        let response = match self.transport.request(
            GeneratedAcpxSidecarCommand::TurnStart,
            json!({"turnId":turn_id,"message":message}),
        ) {
            Ok(response) => response,
            Err(error) => return Err(self.fail_closed(error)),
        };
        if response.get("turnId").and_then(Value::as_str) != Some(turn_id) {
            return Err(self.fail_closed(LocalRunnerError::invalid(
                "ACPX sidecar did not confirm the requested turn",
            )));
        }
        if let Err(error) = self.state.begin_turn(turn_id) {
            return Err(self.fail_closed(error));
        }
        self.tool_bridge = next_tool_bridge;
        self.reserved_tool_bridge = next_reserved_tool_bridge;
        Ok(response)
    }

    pub fn interrupt_turn(
        &mut self,
        turn_id: &str,
        reason: &str,
    ) -> Result<Value, LocalRunnerError> {
        self.ensure_open()?;
        validate_stable_id(turn_id, DURABLE_STABLE_ID_CHARS, "ACPX turn id")?;
        if self.state.active_turn_id() != Some(turn_id) {
            return Err(LocalRunnerError::invalid(
                "ACPX interruption named a stale or inactive turn",
            ));
        }
        let response = match self.transport.request(
            GeneratedAcpxSidecarCommand::TurnCancel,
            json!({"turnId":turn_id,"reason":bounded_reason(reason)}),
        ) {
            Ok(response) => response,
            Err(error) => return Err(self.fail_closed(error)),
        };
        if response.get("cancelled").and_then(Value::as_bool) != Some(true) {
            return Err(self.fail_closed(LocalRunnerError::invalid(
                "ACPX sidecar did not confirm turn cancellation",
            )));
        }
        Ok(response)
    }

    pub fn poll_event(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<Vec<AcpxProviderStateEvent>>, LocalRunnerError> {
        self.ensure_open()?;
        let event = match self.transport.poll_event(timeout) {
            Ok(event) => event,
            Err(error) => return Err(self.fail_closed(error)),
        };
        let Some(event) = event else {
            return Ok(None);
        };
        let mut next_state = self.state.clone();
        let events = match next_state.accept_event(&event) {
            Ok(events) => events,
            Err(error) => return Err(self.fail_closed(error)),
        };
        let mut next_bridge = self.tool_bridge.clone();
        let mut next_reserved_bridge = self.reserved_tool_bridge.clone();
        let mut reconciled_events = Vec::with_capacity(events.len());
        for event in events {
            let mut expose_event = true;
            match &event {
                AcpxProviderStateEvent::ToolCall {
                    call_id,
                    operation_id,
                    input,
                } => {
                    let bridge = if is_reserved_terminal_operation(operation_id) {
                        if let Err(error) = validate_reserved_terminal_value(operation_id, input) {
                            return Err(self.fail_closed(error));
                        }
                        // These built-ins are authorized by the same ledger as
                        // dynamic tools, but the server dispatcher must never
                        // execute them as ordinary semantic operations.
                        expose_event = false;
                        if next_bridge.has_call_receipt(call_id) {
                            return Err(self.fail_closed(LocalRunnerError::invalid(
                                "ACPX reused a dynamic call id for a reserved terminal invocation",
                            )));
                        }
                        &mut next_reserved_bridge
                    } else {
                        if next_reserved_bridge.has_call_receipt(call_id) {
                            return Err(self.fail_closed(LocalRunnerError::invalid(
                                "ACPX reused a reserved call id for a dynamic tool invocation",
                            )));
                        }
                        &mut next_bridge
                    };
                    if let Err(error) =
                        bridge.begin_call(call_id.clone(), operation_id.clone(), input.clone())
                    {
                        return Err(self.fail_closed(LocalRunnerError::invalid(format!(
                            "ACPX provider tool authorization failed: {error}"
                        ))));
                    }
                }
                AcpxProviderStateEvent::SemanticResult(result) => {
                    if is_reserved_terminal_result(result) {
                        if let Err(error) = validate_reserved_terminal_result(&next_state, result) {
                            return Err(self.fail_closed(error));
                        }
                        if let Err(error) =
                            next_reserved_bridge.apply_result(crate::provider_bridge::ToolResult {
                                call_id: result.call_id.clone(),
                                operation_id: result.operation_id.clone(),
                                result: result.result.clone(),
                                is_error: !result.ok,
                            })
                        {
                            return Err(self.fail_closed(LocalRunnerError::invalid(format!(
                                "ACPX reserved terminal result reconciliation failed: {error}"
                            ))));
                        }
                    } else {
                        let replayed = next_bridge.has_completed_call(&result.call_id);
                        if let Err(error) =
                            next_bridge.apply_result(crate::provider_bridge::ToolResult {
                                call_id: result.call_id.clone(),
                                operation_id: result.operation_id.clone(),
                                result: result.result.clone(),
                                is_error: !result.ok,
                            })
                        {
                            return Err(self.fail_closed(LocalRunnerError::invalid(format!(
                                "ACPX provider tool result reconciliation failed: {error}"
                            ))));
                        }
                        if replayed {
                            expose_event = false;
                        }
                    }
                    if next_state.pending_tool(&result.call_id).is_some() {
                        if let Err(error) =
                            next_state.complete_tool(&result.call_id, &result.operation_id)
                        {
                            return Err(self.fail_closed(LocalRunnerError::invalid(format!(
                                "ACPX provider tool completion reconciliation failed: {error}"
                            ))));
                        }
                    }
                }
                AcpxProviderStateEvent::TurnTerminal { .. } => {
                    let settlements = match next_bridge.settle_turn("acpx_turn_settled") {
                        Ok(settlements) => settlements,
                        Err(error) => {
                            return Err(self.fail_closed(LocalRunnerError::invalid(format!(
                                "ACPX provider tool settlement failed: {error}"
                            ))));
                        }
                    };
                    let reserved_settlements = match next_reserved_bridge
                        .settle_turn("acpx_reserved_terminal_unsettled")
                    {
                        Ok(settlements) => settlements,
                        Err(error) => {
                            return Err(self.fail_closed(LocalRunnerError::invalid(format!(
                                "ACPX reserved terminal settlement failed: {error}"
                            ))));
                        }
                    };
                    if !reserved_settlements.is_empty() {
                        return Err(self.fail_closed(LocalRunnerError::invalid(
                            "ACPX turn terminated before its reserved terminal invocation produced a correlated result",
                        )));
                    }
                    // `accept_event` clears the candidate reducer's pending
                    // tools while the bridge clones settle the corresponding
                    // calls above. Prove both halves reached the same terminal
                    // state before committing any of them to the reusable
                    // session.
                    if next_state.has_pending_tools()
                        || next_bridge.pending_calls().next().is_some()
                        || next_reserved_bridge.pending_calls().next().is_some()
                    {
                        return Err(self.fail_closed(LocalRunnerError::invalid(
                            "ACPX terminal settlement left provider tool state inconsistent",
                        )));
                    }
                    reconciled_events.extend(
                        settlements
                            .into_iter()
                            .map(AcpxProviderStateEvent::ToolResult),
                    );
                }
                AcpxProviderStateEvent::PermissionRequest { .. } => {
                    return Err(self.fail_closed(LocalRunnerError::invalid(
                        "ACPX permission request violated the pinned runner policy",
                    )));
                }
                _ => {}
            }
            if expose_event {
                reconciled_events.push(event);
            }
        }
        self.state = next_state;
        self.tool_bridge = next_bridge;
        self.reserved_tool_bridge = next_reserved_bridge;
        Ok(Some(reconciled_events))
    }

    pub fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError> {
        let turn_id = self.ensure_active_turn()?.to_owned();
        let mut next_state = self.state.clone();
        next_state.complete_tool(&result.call_id, &result.operation_id)?;
        let mut next_bridge = self.tool_bridge.clone();
        next_bridge.apply_result(result.clone()).map_err(|error| {
            LocalRunnerError::invalid(format!("ACPX tool result is invalid: {error}"))
        })?;
        let resolution = if result.is_error {
            // The durable result remains authoritative for correlation and
            // retry bookkeeping, but provider-facing failures expose only a
            // fixed diagnostic. Internal dispatcher payloads must not cross
            // the sidecar boundary on the separate success-result channel.
            json!({
                "callId":result.call_id,
                "turnId":turn_id,
                "error":{"message":"Paperclip semantic operation failed"},
            })
        } else {
            json!({
                "callId":result.call_id,
                "turnId":turn_id,
                "result":result.result,
                "error":Value::Null,
            })
        };
        let response = match self
            .transport
            .request(GeneratedAcpxSidecarCommand::ToolResolve, resolution)
        {
            Ok(response) => response,
            Err(error) => return Err(self.fail_closed(error)),
        };
        self.verify_resolution(&response, "tool")?;
        self.state = next_state;
        self.tool_bridge = next_bridge;
        Ok(())
    }

    pub fn resolve_input(
        &mut self,
        request_id: &str,
        turn_id: &str,
        resolution: &Value,
    ) -> Result<(), LocalRunnerError> {
        self.ensure_bound_turn(turn_id)?;
        validate_text(request_id, SHORT_STABLE_ID_CHARS, "ACPX input request id")?;
        if !is_stable_id(request_id, SHORT_STABLE_ID_CHARS) {
            return Err(LocalRunnerError::invalid(
                "ACPX input request id is not a stable runtime request identity",
            ));
        }
        let provider_request_id = self
            .state
            .pending_provider_input_request_id(request_id)
            .ok_or_else(|| LocalRunnerError::invalid("ACPX input request is stale or unknown"))?
            .to_owned();
        let question_set = self
            .state
            .pending_question_set(request_id)
            .ok_or_else(|| LocalRunnerError::invalid("ACPX input request is stale or unknown"))?;
        validate_input_resolution(question_set, resolution)?;
        let mut next_state = self.state.clone();
        next_state.complete_input(request_id)?;
        let response = match self.transport.request(
            GeneratedAcpxSidecarCommand::InputResolve,
            json!({"requestId":provider_request_id,"turnId":turn_id,"resolution":resolution}),
        ) {
            Ok(response) => response,
            Err(error) => return Err(self.fail_closed(error)),
        };
        self.verify_resolution(&response, "input")?;
        self.state = next_state;
        Ok(())
    }

    pub fn suspend(
        &mut self,
        reason: &str,
    ) -> Result<AcpxProviderSessionIdentity, LocalRunnerError> {
        self.ensure_open()?;
        if self.state.active_turn_id().is_some() || self.state.has_pending_requests() {
            return Err(LocalRunnerError::invalid(
                "ACPX provider session is not at a safe suspension point",
            ));
        }
        let response = match self.transport.request(
            GeneratedAcpxSidecarCommand::SessionSuspend,
            json!({"reason":bounded_reason(reason)}),
        ) {
            Ok(response) => response,
            Err(error) => return Err(self.fail_closed(error)),
        };
        let identity = response
            .get("identity")
            .cloned()
            .ok_or_else(|| LocalRunnerError::invalid("ACPX suspension omitted its identity"))
            .and_then(|value| {
                serde_json::from_value::<AcpxProviderSessionIdentity>(value).map_err(|error| {
                    LocalRunnerError::invalid(format!(
                        "ACPX suspension identity is invalid: {error}"
                    ))
                })
            });
        let identity = match identity {
            Ok(identity) => identity,
            Err(error) => return Err(self.fail_closed(error)),
        };
        if response.get("suspended").and_then(Value::as_bool) != Some(true)
            || identity != self.identity
        {
            return Err(self.fail_closed(LocalRunnerError::invalid(
                "ACPX sidecar did not confirm the exact suspended session",
            )));
        }
        self.closed = true;
        self.terminate_transport()?;
        Ok(identity)
    }

    pub fn shutdown(&mut self, reason: &str) -> Result<(), LocalRunnerError> {
        if self.closed {
            return self.terminate_transport();
        }
        self.closed = true;
        let close = self.transport.request(
            GeneratedAcpxSidecarCommand::SessionClose,
            json!({
                "reason": bounded_reason(reason),
                "discardPersistentState": false,
            }),
        );
        let terminate = self.terminate_transport();
        match (close, terminate) {
            (Ok(_), Ok(())) => Ok(()),
            (Err(error), cleanup) => Err(with_cleanup_error(error, cleanup)),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    fn terminate_transport(&mut self) -> Result<(), LocalRunnerError> {
        if self.transport_terminated {
            return Ok(());
        }
        self.transport.shutdown()?;
        self.transport_terminated = true;
        Ok(())
    }

    fn ensure_open(&self) -> Result<(), LocalRunnerError> {
        if self.closed {
            return Err(LocalRunnerError::invalid("ACPX provider session is closed"));
        }
        Ok(())
    }

    fn restart_idle_provider(&mut self) -> Result<(), LocalRunnerError> {
        let suspended = self.transport.request(
            GeneratedAcpxSidecarCommand::SessionSuspend,
            json!({"reason":"ACPX turn receipt epoch rotation"}),
        )?;
        verify_suspend_response(&suspended, &self.identity)?;
        self.transport.shutdown()?;
        self.transport_terminated = true;

        let mut restart_config = self.config.clone();
        restart_config.expected_identity = Some(self.identity.clone());
        let mut replacement = AcpxSidecarTransport::start(&restart_config.transport)?;
        let (replacement_identity, _) = match bootstrap(&mut replacement, &restart_config) {
            Ok(value) => value,
            Err(error) => {
                return Err(self.reject_replacement(replacement, error));
            }
        };
        if replacement_identity != self.identity {
            return Err(self.reject_replacement(
                replacement,
                LocalRunnerError::invalid(
                    "ACPX replacement provider changed its persistent session identity",
                ),
            ));
        }
        self.transport = replacement;
        self.transport_terminated = false;
        Ok(())
    }

    fn reject_replacement(
        &mut self,
        mut replacement: AcpxSidecarTransport,
        error: LocalRunnerError,
    ) -> LocalRunnerError {
        let cleanup = replacement.shutdown();
        if cleanup.is_err() {
            // Keep the exact failed generation reachable so fail_closed can
            // retry its process-group termination instead of dropping the
            // only remaining cleanup authority.
            self.transport = replacement;
            self.transport_terminated = false;
        }
        with_cleanup_error(error, cleanup)
    }

    fn ensure_active_turn(&self) -> Result<&str, LocalRunnerError> {
        self.ensure_open()?;
        self.state
            .active_turn_id()
            .ok_or_else(|| LocalRunnerError::invalid("ACPX provider session has no active turn"))
    }

    fn ensure_bound_turn(&self, turn_id: &str) -> Result<(), LocalRunnerError> {
        validate_stable_id(turn_id, DURABLE_STABLE_ID_CHARS, "ACPX turn id")?;
        if self.ensure_active_turn()? != turn_id {
            return Err(LocalRunnerError::invalid(
                "ACPX resolution named a stale or inactive turn",
            ));
        }
        Ok(())
    }

    fn verify_resolution(&mut self, response: &Value, kind: &str) -> Result<(), LocalRunnerError> {
        if response.get("resolved").and_then(Value::as_bool) != Some(true) {
            return Err(self.fail_closed(LocalRunnerError::invalid(format!(
                "ACPX sidecar did not confirm {kind} resolution"
            ))));
        }
        Ok(())
    }

    fn fail_closed(&mut self, error: LocalRunnerError) -> LocalRunnerError {
        self.closed = true;
        with_cleanup_error(error, self.terminate_transport())
    }
}

fn is_reserved_terminal_result(result: &crate::acpx_provider_state::AcpxSemanticResult) -> bool {
    is_reserved_terminal_operation(&result.operation_id)
}

fn validate_reserved_terminal_result(
    state: &AcpxProviderState,
    result: &crate::acpx_provider_state::AcpxSemanticResult,
) -> Result<(), LocalRunnerError> {
    if !result.ok {
        return Err(LocalRunnerError::invalid(
            "ACPX reserved semantic result reported a failed outcome",
        ));
    }
    let pending = state.pending_tool(&result.call_id).ok_or_else(|| {
        LocalRunnerError::invalid(
            "ACPX reserved semantic result has no authorized pending invocation",
        )
    })?;
    if pending.operation_id != result.operation_id || pending.input_digest != result.result_digest {
        return Err(LocalRunnerError::invalid(
            "ACPX reserved semantic result does not match its authorized invocation",
        ));
    }
    validate_reserved_terminal_value(&result.operation_id, &result.result)
}

fn validate_reserved_terminal_value(
    operation_id: &str,
    value: &Value,
) -> Result<(), LocalRunnerError> {
    validate_prp_run_result(value)?;
    let disposition = value.get("reportedWorkDisposition").and_then(Value::as_str);
    let disposition_matches = match operation_id {
        PRP_BLOCK_TOOL_NAME => disposition == Some("blocked"),
        PRP_COMPLETION_TOOL_NAME => {
            matches!(disposition, Some("done" | "needs_review" | "yielded"))
        }
        _ => false,
    };
    if !disposition_matches {
        return Err(LocalRunnerError::invalid(
            "ACPX reserved semantic result disposition does not match its operation",
        ));
    }
    Ok(())
}

fn reserved_terminal_tool_bridge() -> Result<ProviderToolBridge, LocalRunnerError> {
    let result_schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/result.schema.json"
    ))
    .map_err(|_| LocalRunnerError::invalid("embedded Paperclip result schema is invalid"))?;
    let operations = vec![
        AuthorizedTool {
            operation_id: PRP_COMPLETION_TOOL_NAME.to_owned(),
            version: 1,
            description: "Return the authoritative Paperclip completion result.".to_owned(),
            input_schema: result_schema.clone(),
            response_schema: result_schema.clone(),
        },
        AuthorizedTool {
            operation_id: PRP_BLOCK_TOOL_NAME.to_owned(),
            version: 1,
            description: "Return the authoritative Paperclip blocked result.".to_owned(),
            input_schema: result_schema.clone(),
            response_schema: result_schema,
        },
    ];
    let catalog_digest = authorized_tool_catalog_digest(&operations).map_err(|error| {
        LocalRunnerError::invalid(format!("ACPX reserved terminal tools are invalid: {error}"))
    })?;
    let mut bridge = ProviderToolBridge::default();
    bridge
        .prepare(AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest,
            operations,
        })
        .map_err(|error| {
            LocalRunnerError::invalid(format!("ACPX reserved terminal tools are invalid: {error}"))
        })?;
    Ok(bridge)
}

fn validate_prp_run_result(value: &Value) -> Result<(), LocalRunnerError> {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/result.schema.json"
    ))
    .map_err(|_| LocalRunnerError::invalid("embedded Paperclip result schema is invalid"))?;
    let validator = jsonschema::validator_for(&schema).map_err(|_| {
        LocalRunnerError::invalid("embedded Paperclip result schema cannot compile")
    })?;
    if !validator.is_valid(value) {
        return Err(LocalRunnerError::invalid(
            "ACPX reserved semantic result failed the Paperclip result schema",
        ));
    }
    Ok(())
}

impl Drop for AcpxProviderSession {
    fn drop(&mut self) {
        if !self.transport_terminated {
            self.closed = true;
            let _ = self.terminate_transport();
        }
    }
}

fn bootstrap(
    transport: &mut AcpxSidecarTransport,
    config: &AcpxProviderSessionConfig,
) -> Result<(AcpxProviderSessionIdentity, AcpxProviderState), LocalRunnerError> {
    let initialized = transport.request(
        GeneratedAcpxSidecarCommand::Initialize,
        json!({"agent": config.agent, "model": config.model}),
    )?;
    verify_initialize_response(&initialized, transport.process_id())?;

    let opened = transport.request(
        GeneratedAcpxSidecarCommand::SessionOpen,
        json!({
            "runtimeDirectory": config.runtime_directory,
            "normalizedSessionId": config.normalized_session_id,
            "workingDirectory": config.working_directory,
            "agent": config.agent,
            "model": config.model,
            "permissionMode": config.permission_mode,
            "permissionModePinned": config.permission_mode_pinned,
            "systemInstructions": config.system_instructions,
            "runtimeContext": Value::Null,
            "tools": config.tool_set.operations,
            "expectedIdentity": config.expected_identity,
        }),
    )?;
    let identity = verify_open_response(&opened, transport.process_id(), config)?;

    let attached = transport.request(
        GeneratedAcpxSidecarCommand::RunAttach,
        json!({
            "runId": config.run_id,
            "catalogRevision": config.catalog_revision,
            "tools": config.tool_set.operations,
        }),
    )?;
    if attached.get("runId").and_then(Value::as_str) != Some(config.run_id.as_str())
        || attached.get("catalogRevision").and_then(Value::as_u64) != Some(config.catalog_revision)
    {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar did not confirm the requested run attachment",
        ));
    }
    Ok((identity, AcpxProviderState::new(&config.run_id)?))
}

fn verify_initialize_response(value: &Value, process_id: u32) -> Result<(), LocalRunnerError> {
    if value.get("protocolVersion").and_then(Value::as_u64)
        != Some(GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION)
        || value.get("sidecarPid").and_then(Value::as_u64) != Some(u64::from(process_id))
        || !value.get("profile").is_some_and(Value::is_object)
        || value
            .pointer("/capabilities/persistentSessions")
            .and_then(Value::as_bool)
            != Some(true)
        || value
            .pointer("/capabilities/exactModelVerification")
            .and_then(Value::as_bool)
            != Some(true)
        || value
            .pointer("/capabilities/permissions")
            .and_then(Value::as_str)
            != Some("runner_policy")
        || value
            .pointer("/capabilities/semanticTools")
            .and_then(Value::as_str)
            != Some("runner_bridge")
        || value
            .pointer("/capabilities/structuredInput")
            .and_then(Value::as_str)
            != Some("paperclip.question_set.v1")
    {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar initialization capabilities are invalid",
        ));
    }
    Ok(())
}

fn verify_open_response(
    value: &Value,
    process_id: u32,
    config: &AcpxProviderSessionConfig,
) -> Result<AcpxProviderSessionIdentity, LocalRunnerError> {
    if value.get("sidecarPid").and_then(Value::as_u64) != Some(u64::from(process_id))
        || !value.get("status").is_some_and(Value::is_object)
    {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar session-open response is invalid",
        ));
    }
    let identity: AcpxProviderSessionIdentity = serde_json::from_value(
        value
            .get("identity")
            .cloned()
            .ok_or_else(|| LocalRunnerError::invalid("ACPX sidecar omitted its identity"))?,
    )
    .map_err(|error| {
        LocalRunnerError::invalid(format!("ACPX sidecar identity is invalid: {error}"))
    })?;
    identity.validate()?;
    if identity.normalized_session_id != config.normalized_session_id
        || identity.requested_model != config.model
        || identity.effective_model != config.model
        || identity.permission_mode != Some(config.permission_mode)
        || config
            .expected_identity
            .as_ref()
            .is_some_and(|expected| expected != &identity)
    {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar identity does not match the requested session",
        ));
    }
    Ok(identity)
}

fn verify_suspend_response(
    value: &Value,
    expected_identity: &AcpxProviderSessionIdentity,
) -> Result<(), LocalRunnerError> {
    if value.get("suspended").and_then(Value::as_bool) != Some(true) {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar did not confirm provider suspension",
        ));
    }
    let identity: AcpxProviderSessionIdentity = serde_json::from_value(
        value
            .get("identity")
            .cloned()
            .ok_or_else(|| LocalRunnerError::invalid("ACPX suspension omitted its identity"))?,
    )
    .map_err(|error| {
        LocalRunnerError::invalid(format!("ACPX suspension identity is invalid: {error}"))
    })?;
    identity.validate()?;
    if &identity != expected_identity {
        return Err(LocalRunnerError::invalid(
            "ACPX suspension changed its persistent session identity",
        ));
    }
    Ok(())
}

fn validate_text(value: &str, max_chars: usize, label: &str) -> Result<(), LocalRunnerError> {
    if value.trim().is_empty()
        || value.chars().count() > max_chars
        || value.chars().any(char::is_control)
    {
        return Err(LocalRunnerError::invalid(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_stable_id(value: &str, max_chars: usize, label: &str) -> Result<(), LocalRunnerError> {
    if !is_stable_id(value, max_chars) {
        return Err(LocalRunnerError::invalid(format!("{label} is invalid")));
    }
    Ok(())
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn bounded_reason(value: &str) -> String {
    value.chars().take(4_000).collect()
}

fn validate_turn_message(value: &str) -> Result<(), LocalRunnerError> {
    if value.trim().is_empty()
        || value.len() > MAX_SYSTEM_INSTRUCTIONS_BYTES
        || value.contains('\0')
    {
        return Err(LocalRunnerError::invalid(
            "ACPX turn message exceeds its bounded contract",
        ));
    }
    Ok(())
}

fn validate_input_resolution(
    question_set: &Value,
    resolution: &Value,
) -> Result<(), LocalRunnerError> {
    let object = resolution
        .as_object()
        .ok_or_else(|| LocalRunnerError::invalid("ACPX input resolution must be an object"))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "action" | "response"))
    {
        return Err(LocalRunnerError::invalid(
            "ACPX input resolution contains an unknown field",
        ));
    }
    let action = resolution
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid("ACPX input resolution requires an action"))?;
    match action {
        "submit" => validate_question_response(
            question_set,
            resolution.get("response").ok_or_else(|| {
                LocalRunnerError::invalid("ACPX submitted input resolution requires a response")
            })?,
        ),
        "decline" | "cancel" if !object.contains_key("response") => Ok(()),
        "decline" | "cancel" => Err(LocalRunnerError::invalid(
            "ACPX declined input resolution cannot contain a response",
        )),
        _ => Err(LocalRunnerError::invalid(
            "ACPX input resolution action is unsupported",
        )),
    }
}

fn with_cleanup_error(
    error: LocalRunnerError,
    cleanup: Result<(), LocalRunnerError>,
) -> LocalRunnerError {
    match cleanup {
        Ok(()) => error,
        Err(cleanup) => LocalRunnerError::invalid(format!(
            "{error}; ACPX sidecar cleanup also failed: {cleanup}"
        )),
    }
}
