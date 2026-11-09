use std::time::Instant;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    reserved_terminal_tool_bridge, sidecar_run_tool_operations, AcpxProviderSession,
    AcpxProviderSessionConfig,
};
use crate::acpx_provider_state::AcpxProviderState;
use crate::generated_acpx_sidecar_contract::{
    GeneratedAcpxSidecarCommand, GeneratedAcpxSidecarEventType,
};
use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::ProviderToolBridge;

fn generation_digest(config: &AcpxProviderSessionConfig) -> String {
    let mut runtime_context = config.runtime_context.clone();
    let mcp_bound = runtime_context
        .pointer("/mcp/bindingId")
        .is_some_and(|binding| !binding.is_null());
    if let Some(object) = runtime_context.as_object_mut() {
        object.remove("mcp");
        object.remove("aggregateDigest");
    }
    let shape = json!({
        "candidateAdmission": config.candidate_admission,
        "command": config.transport.command,
        "args": config.transport.args,
        "agent": config.agent,
        "model": config.model,
        "catalogRevision": config.catalog_revision,
        "runtimeDirectory": config.runtime_directory,
        "normalizedSessionId": config.normalized_session_id,
        "workingDirectory": config.working_directory,
        "permissionMode": config.permission_mode,
        "mode": config.mode,
        "piThinkingLevel": config.pi_thinking_level,
        "claudeEffort": config.claude_effort,
        "grokEffort": config.grok_effort,
        "grokDisableWebSearch": config.grok_disable_web_search,
        "permissionModePinned": config.permission_mode_pinned,
        "providerPolicy": config.provider_policy,
        "systemInstructions": config.system_instructions,
        "runtimeContext": runtime_context,
        "mcpBound": mcp_bound,
        "toolSet": config.tool_set,
    });
    format!("sha256:{:x}", Sha256::digest(shape.to_string().as_bytes()))
}

impl AcpxProviderSession {
    pub fn generation_has_run_turn(&self) -> bool {
        self.generation_has_run_turn
    }

    pub fn awaits_run_rebind(&self) -> bool {
        self.prepared_generation.is_some()
    }

    pub fn prepared_from_process_id(&self) -> Option<u32> {
        self.prepared_generation
            .as_ref()
            .map(|(_, process_id)| *process_id)
    }

    pub(super) fn park_tail_is_quiet(&self) -> bool {
        if self.prepared_generation.is_none() {
            return self.transport.buffered_events().len() == 0;
        }
        self.transport.buffered_events().all(|event| {
            event.turn_id.is_none()
                && matches!(
                    event.event_type,
                    GeneratedAcpxSidecarEventType::RuntimeProcess
                        | GeneratedAcpxSidecarEventType::RuntimeDiagnostic
                )
        })
    }

    pub fn can_prepare_next_generation(&self) -> bool {
        !self.closed
            && self.failure.is_none()
            && !self.transport_terminated
            && !self.runtime_retired
            && self.generation_has_run_turn
            && self.completed_turn_observed
            && self.prepared_generation.is_none()
            && self.config.candidate_admission.is_none()
            && self.state.active_turn_id().is_none()
            && !self.state.has_pending_requests()
            && !self.state.has_pending_tools()
            && self.transport.buffered_events().len() == 0
    }

    pub fn prepare_next_generation(&mut self, deadline: Instant) -> Result<(), LocalRunnerError> {
        if !self.can_prepare_next_generation() {
            return Err(LocalRunnerError::invalid(
                "ACPX provider is not at a reusable generation boundary",
            ));
        }
        let previous_process_id = self.process_id();
        let mut tool_bridge = self.tool_bridge.clone();
        let mut reserved_tool_bridge = self.reserved_tool_bridge.clone();
        tool_bridge
            .prepare_turn_after_provider_restart()
            .and_then(|()| reserved_tool_bridge.prepare_turn_after_provider_restart())
            .map_err(|error| {
                LocalRunnerError::invalid(format!(
                    "ACPX tool receipt rotation before park failed: {error}"
                ))
            })?;
        if let Err(error) = self.restart_idle_provider(Some(deadline)) {
            return Err(self.fail_closed(error));
        }
        if self.state.settled_turn_identity_capacity_reached() {
            if let Err(error) = self
                .state
                .rotate_settled_turn_identities_after_provider_restart()
            {
                return Err(self.fail_closed(error));
            }
        }
        self.tool_bridge = tool_bridge;
        self.reserved_tool_bridge = reserved_tool_bridge;
        self.completed_turn_observed = false;
        if let Err(error) = self.verify_dormant_session() {
            return Err(self.fail_closed(error));
        }
        self.transport.bound_requests_by(None);
        self.prepared_generation = Some((generation_digest(&self.config), previous_process_id));
        Ok(())
    }

    pub fn rebind_run(
        &mut self,
        next: &AcpxProviderSessionConfig,
    ) -> Result<bool, LocalRunnerError> {
        let Some((prepared, _)) = self.prepared_generation.as_ref() else {
            return Ok(false);
        };
        if self.closed
            || self.failure.is_some()
            || self.transport_terminated
            || self.runtime_retired
            || self.generation_has_run_turn
            || self.state.active_turn_id().is_some()
            || self.state.has_pending_requests()
            || next.run_id == self.config.run_id
            || next.expected_identity.as_ref() != Some(&self.identity)
            || &generation_digest(next) != prepared
            || next.validate().is_err()
        {
            return Ok(false);
        }
        let state = AcpxProviderState::new(&next.run_id)?;
        let mut tool_bridge = ProviderToolBridge::default();
        tool_bridge
            .prepare(next.tool_set.clone())
            .map_err(|error| {
                LocalRunnerError::invalid(format!("ACPX authorized tools are invalid: {error}"))
            })?;
        let reserved_tool_bridge = reserved_terminal_tool_bridge()?;
        let previous_run_id = self.config.run_id.clone();
        let attached = match self.transport.request(
            GeneratedAcpxSidecarCommand::RunAttach,
            json!({
                "runId": next.run_id,
                "catalogRevision": next.catalog_revision,
                "tools": sidecar_run_tool_operations(&next.tool_set),
            }),
        ) {
            Ok(attached) => attached,
            Err(error) => return Err(self.fail_closed(error)),
        };
        if attached.get("runId").and_then(Value::as_str) != Some(next.run_id.as_str())
            || attached.get("catalogRevision").and_then(Value::as_u64)
                != Some(next.catalog_revision)
        {
            return Err(self.fail_closed(LocalRunnerError::invalid(
                "ACPX sidecar did not confirm the rebound run",
            )));
        }
        if self.transport.buffered_events().any(|event| {
            event.turn_id.is_some() || event.run_id.as_deref() == Some(previous_run_id.as_str())
        }) {
            return Err(self.fail_closed(LocalRunnerError::invalid(
                "ACPX prepared provider emitted work bound to its previous run",
            )));
        }
        self.state = state;
        self.tool_bridge = tool_bridge;
        self.reserved_tool_bridge = reserved_tool_bridge;
        self.config = next.clone();
        self.catalog_revision = next.catalog_revision;
        self.working_directory = next.working_directory.clone();
        self.prepared_generation = None;
        if let Err(error) = self.verify_dormant_session() {
            return Err(self.fail_closed(error));
        }
        Ok(true)
    }
}
