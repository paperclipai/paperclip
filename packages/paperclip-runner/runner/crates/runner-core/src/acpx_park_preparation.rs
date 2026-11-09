use std::time::Instant;

use super::{
    await_provider_lifetime_fence, AcpxCommandExecutor, AcpxProviderDescriptor, AcpxProviderSession,
};
use crate::durable::DurableRunnerError;
use crate::provider_bridge::AuthorizedToolSet;

impl AcpxCommandExecutor {
    pub(super) fn prepare_session_for_park(
        &mut self,
        deadline: Instant,
    ) -> Result<bool, DurableRunnerError> {
        self.ensure_persistence_healthy()?;
        let eligible = self.candidate_admission().is_none()
            && self.state.as_ref().is_some_and(|state| {
                state.descriptor.agent == "claude"
                    && state.lifecycle == "session_open"
                    && state.descriptor.run_id == self.context.run_id
                    && state.identity.is_some()
                    && state.active_turn_id.is_none()
                    && !state.provider_exit_unconfirmed
                    && state.pending_events.is_empty()
                    && state.pending_runtime_requests.is_empty()
            })
            && self
                .session
                .as_ref()
                .is_some_and(AcpxProviderSession::can_prepare_next_generation);
        if !eligible {
            return Ok(false);
        }
        let prepared = self
            .session
            .as_mut()
            .expect("checked ACPX session")
            .prepare_next_generation(deadline);
        match prepared {
            Ok(()) => Ok(true),
            Err(error) => {
                self.recover_failed_park_preparation()?;
                Err(DurableRunnerError::invalid(format!(
                    "ACPX park preparation failed: {error}"
                )))
            }
        }
    }

    fn recover_failed_park_preparation(&mut self) -> Result<(), DurableRunnerError> {
        self.session = None;
        self.context.provider_turn_id = None;
        let candidates = {
            let state = self
                .state
                .as_mut()
                .expect("ACPX state remains available after park preparation");
            state.lifecycle = "prepared".to_owned();
            state.provider_exit_unconfirmed = true;
            state
                .identity
                .as_ref()
                .expect("park preparation requires a provider identity")
                .provider_lifetime_fence_candidates
        };
        self.save_state()?;
        let _provider_lifetime_fence = await_provider_lifetime_fence(candidates)?;
        let state = self
            .state
            .as_mut()
            .expect("ACPX state remains available after park preparation");
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
