use std::time::Instant;

use super::{
    await_provider_lifetime_fence, goal_is_dormant, AcpxCommandExecutor, AcpxProviderDescriptor,
    AcpxProviderSession,
};
use crate::durable::DurableRunnerError;
use crate::provider_bridge::AuthorizedToolSet;

impl AcpxCommandExecutor {
    fn generation_restartable(&self, session_ready: fn(&AcpxProviderSession) -> bool) -> bool {
        self.candidate_admission().is_none()
            && self.state.as_ref().is_some_and(|state| {
                state.descriptor.agent == "claude"
                    && state.lifecycle == "session_open"
                    && state.descriptor.run_id == self.context.run_id
                    && state.identity.is_some()
                    && state.active_turn_id.is_none()
                    && !state.provider_exit_unconfirmed
                    && state.pending_events.is_empty()
                    && state.pending_runtime_requests.is_empty()
                    && (state.goal_projection.is_null() || goal_is_dormant(&state.goal_projection))
            })
            && self.session.as_ref().is_some_and(session_ready)
    }

    pub(super) fn restart_session_after_turn(&mut self) -> Result<(), DurableRunnerError> {
        self.ensure_persistence_healthy()?;
        if !self.generation_restartable(AcpxProviderSession::can_restart_after_turn) {
            return Ok(());
        }
        let session = self.session.as_mut().expect("checked ACPX session");
        if session.settle_park_observation().is_err()
            || !self.generation_restartable(AcpxProviderSession::can_restart_after_turn)
        {
            return Ok(());
        }
        let restarted = self
            .session
            .as_mut()
            .expect("checked ACPX session")
            .restart_after_turn(None);
        let Err(error) = restarted else {
            return Ok(());
        };
        // Later turns of this run fail closed, exactly like a failed restart at
        // turn start. The saved session stays resumable: the reaped provider is
        // proven gone, then it is saved suspended, so the next run resumes the
        // same conversation instead of starting a new one.
        self.failed_turn_end_restart = Some(error.to_string());
        self.unreported_turn_end_restart_failure = Some(error.to_string());
        let run_id = self.context.run_id.clone();
        self.state
            .as_mut()
            .expect("ACPX state remains available after a failed turn-end restart")
            .turn_end_restart_failed_run = Some(run_id);
        self.recover_failed_generation_restart()
    }

    pub(super) fn prepare_session_for_park(
        &mut self,
        deadline: Instant,
    ) -> Result<bool, DurableRunnerError> {
        self.ensure_persistence_healthy()?;
        if !self.generation_restartable(AcpxProviderSession::can_prepare_next_generation) {
            return Ok(false);
        }
        let prepared = self
            .session
            .as_mut()
            .expect("checked ACPX session")
            .prepare_next_generation(deadline);
        match prepared {
            Ok(restarted) => Ok(restarted),
            Err(error) => {
                self.recover_failed_generation_restart()?;
                Err(DurableRunnerError::invalid(format!(
                    "ACPX park preparation failed: {error}"
                )))
            }
        }
    }

    /// A provider generation restart (at park or after a turn) failed: wait until
    /// the reaped provider loses its lifetime fence, then save the session
    /// suspended so a later run can resume it.
    fn recover_failed_generation_restart(&mut self) -> Result<(), DurableRunnerError> {
        self.session = None;
        self.context.provider_turn_id = None;
        let candidates = {
            let state = self
                .state
                .as_mut()
                .expect("ACPX state remains available after a failed generation restart");
            state.lifecycle = "prepared".to_owned();
            state.provider_exit_unconfirmed = true;
            state
                .identity
                .as_ref()
                .expect("a generation restart requires a provider identity")
                .provider_lifetime_fence_candidates
        };
        self.save_state()?;
        let _provider_lifetime_fence = await_provider_lifetime_fence(candidates)?;
        let state = self
            .state
            .as_mut()
            .expect("ACPX state remains available after a failed generation restart");
        state.provider_exit_unconfirmed = false;
        state.lifecycle = "suspended".to_owned();
        if let Err(error) = self.save_state() {
            let state = self
                .state
                .as_mut()
                .expect("ACPX state remains available after save failure");
            state.provider_exit_unconfirmed = true;
            state.lifecycle = "prepared".to_owned();
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn rebind_prepared_session(
        &mut self,
        descriptor: &AcpxProviderDescriptor,
        tool_set: &AuthorizedToolSet,
        next_candidate: bool,
    ) -> bool {
        if next_candidate
            || self.candidate_admission().is_some()
            || !self
                .session
                .as_ref()
                .is_some_and(AcpxProviderSession::awaits_run_rebind)
        {
            return false;
        }
        let Some(identity) = self.state.as_ref().and_then(|state| state.identity.clone()) else {
            return false;
        };
        let Ok(config) = descriptor.session_config(
            tool_set.clone(),
            Some(identity),
            self.launch_profile.as_ref(),
        ) else {
            return false;
        };
        self.session
            .as_mut()
            .is_some_and(|session| session.rebind_run(&config).unwrap_or(false))
    }
}
