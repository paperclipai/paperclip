use std::time::Instant;

use serde_json::{json, Value};

use super::AcpxProviderSession;
use crate::acpx_provider_state::AcpxProviderStateEvent;
use crate::acpx_sidecar_transport::AcpxSidecarEvent;
use crate::generated_acpx_sidecar_contract::{
    read_generated_acpx_background_tasks, GeneratedAcpxSidecarCommand,
    GENERATED_ACPX_PROVIDER_TURN_ORIGIN,
};
use crate::local_runner::LocalRunnerError;

pub(super) fn reported_live_background_tasks(payload: &Value) -> Option<u64> {
    payload
        .get("backgroundTasks")
        .and_then(read_generated_acpx_background_tasks)
}

impl AcpxProviderSession {
    pub fn run_result_reported(&self) -> bool {
        self.run_result_reported.as_deref() == Some(self.state.run_id())
    }

    pub(super) fn record_run_result(&mut self) {
        self.run_result_reported = Some(self.state.run_id().to_owned());
    }

    pub fn take_provider_turn_offer(&mut self) -> Option<String> {
        self.provider_turn_offer.take()
    }

    pub fn arm_provider_turn(&mut self, turn_id: &str) -> bool {
        self.request_provider_turn(turn_id, true)
            .is_some_and(|response| response.get("armed").and_then(Value::as_bool) == Some(true))
    }

    pub fn disarm_provider_turn(&mut self, turn_id: &str) {
        if !self.transport_terminated {
            self.request_provider_turn(turn_id, false);
        }
    }

    fn request_provider_turn(&mut self, turn_id: &str, armed: bool) -> Option<Value> {
        let deadline = Instant::now()
            + super::ACPX_TURN_CANCEL_ACK_TIMEOUT.min(self.config.transport.request_timeout);
        match self.transport.request_by(
            GeneratedAcpxSidecarCommand::SessionProviderTurn,
            json!({"turnId": turn_id, "armed": armed}),
            deadline,
        ) {
            Ok(Ok(response)) => Some(response),
            Ok(Err(_)) => None,
            Err(error) => {
                self.fail_closed(error);
                None
            }
        }
    }

    pub(super) fn offer_provider_turn(
        &mut self,
        turn_id: &str,
        completed: bool,
        live: Option<u64>,
    ) {
        let eligible = completed
            && live.is_some_and(|live| live > 0)
            && !self.run_result_reported()
            && self.config.agent == "claude"
            && self.config.candidate_admission.is_none()
            && !self.runtime_retired
            && self.failure.is_none()
            && !self.state.has_pending_requests()
            && !self.state.has_pending_tools()
            && !self.state.settled_turn_identity_capacity_reached()
            && !self.tool_bridge.replay_history_blocks_admission()
            && !self.reserved_tool_bridge.replay_history_blocks_admission();
        self.provider_turn_offer = eligible.then(|| turn_id.to_owned());
    }

    pub(super) fn admit_provider_turn(
        &mut self,
        event: &AcpxSidecarEvent,
        awaited: bool,
    ) -> Result<AcpxProviderStateEvent, LocalRunnerError> {
        if !awaited
            || self.config.agent != "claude"
            || self.state.active_turn_id().is_some()
            || self.state.has_pending_tools()
        {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar started a provider turn outside an awaited continuation",
            ));
        }
        if event.payload != json!({"origin": GENERATED_ACPX_PROVIDER_TURN_ORIGIN})
            || event.run_id.as_deref() != Some(self.state.run_id())
        {
            return Err(LocalRunnerError::invalid(
                "ACPX provider turn start violated its bounded contract",
            ));
        }
        let turn_id = event.turn_id.clone().ok_or_else(|| {
            LocalRunnerError::invalid("ACPX provider turn start omitted its turn binding")
        })?;
        self.state.validate_new_turn_identity(&turn_id)?;
        let mut next_tool_bridge = self.tool_bridge.clone();
        next_tool_bridge.prepare_turn().map_err(|error| {
            LocalRunnerError::invalid(format!(
                "ACPX dynamic tool receipt rotation failed: {error}"
            ))
        })?;
        let mut next_reserved_tool_bridge = self.reserved_tool_bridge.clone();
        next_reserved_tool_bridge.prepare_turn().map_err(|error| {
            LocalRunnerError::invalid(format!(
                "ACPX reserved tool receipt rotation failed: {error}"
            ))
        })?;
        let mut next_state = self.state.clone();
        next_state.begin_turn(turn_id.clone())?;
        self.state = next_state;
        self.tool_bridge = next_tool_bridge;
        self.reserved_tool_bridge = next_reserved_tool_bridge;
        self.provider_turn_offer = None;
        self.completed_turn_observed = false;
        self.quiet_turn_observed = false;
        self.continues_in_process = false;
        self.cancelled_turn_id = None;
        Ok(AcpxProviderStateEvent::ProviderTurnStarted { turn_id })
    }
}
