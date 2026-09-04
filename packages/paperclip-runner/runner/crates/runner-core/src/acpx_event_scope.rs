use std::collections::BTreeSet;

use crate::acpx_sidecar_transport::AcpxSidecarEvent;
use crate::generated_acpx_sidecar_contract::GeneratedAcpxSidecarEventType;
use crate::local_runner::LocalRunnerError;
use crate::stable_identity::{is_stable_id, DURABLE_STABLE_ID_CHARS, SHORT_STABLE_ID_CHARS};

const MAX_SETTLED_TURN_IDS: usize = 4_096;

/// Holds the run and turn authority used to admit ACPX sidecar events.
///
/// The sidecar transport validates framing and sequence identity. This scope
/// validates that a well-formed event still belongs to the run and turn that
/// runnerd is currently executing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcpxEventScope {
    run_id: String,
    active_turn_id: Option<String>,
    settled_turn_ids: BTreeSet<String>,
}

impl AcpxEventScope {
    pub fn new(run_id: impl Into<String>) -> Result<Self, LocalRunnerError> {
        let run_id = run_id.into();
        validate_scope_id(&run_id, "run", SHORT_STABLE_ID_CHARS)?;
        Ok(Self {
            run_id,
            active_turn_id: None,
            settled_turn_ids: BTreeSet::new(),
        })
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn active_turn_id(&self) -> Option<&str> {
        self.active_turn_id.as_deref()
    }

    pub(crate) fn has_settled_turns(&self) -> bool {
        !self.settled_turn_ids.is_empty()
    }

    pub fn bind_turn(&mut self, turn_id: impl Into<String>) -> Result<(), LocalRunnerError> {
        let turn_id = turn_id.into();
        validate_scope_id(&turn_id, "turn", DURABLE_STABLE_ID_CHARS)?;
        match self.active_turn_id.as_deref() {
            Some(active_turn_id) if active_turn_id == turn_id.as_str() => Ok(()),
            Some(_) => Err(LocalRunnerError::invalid(
                "ACPX event scope already has a different active turn",
            )),
            None => {
                self.validate_new_turn_identity(&turn_id)?;
                self.active_turn_id = Some(turn_id);
                Ok(())
            }
        }
    }

    pub(crate) fn validate_new_turn_identity(&self, turn_id: &str) -> Result<(), LocalRunnerError> {
        self.validate_new_turn_identity_for_provider_restart(turn_id)?;
        if self.settled_turn_ids.len() >= MAX_SETTLED_TURN_IDS {
            return Err(LocalRunnerError::invalid(
                "ACPX event scope exhausted its settled turn identity capacity",
            ));
        }
        Ok(())
    }

    pub(crate) fn validate_new_turn_identity_for_provider_restart(
        &self,
        turn_id: &str,
    ) -> Result<(), LocalRunnerError> {
        validate_scope_id(turn_id, "turn", DURABLE_STABLE_ID_CHARS)?;
        if self.settled_turn_ids.contains(turn_id) {
            return Err(LocalRunnerError::invalid(
                "ACPX event scope reused a settled turn identity",
            ));
        }
        Ok(())
    }

    pub(crate) fn settled_turn_identity_capacity_reached(&self) -> bool {
        self.settled_turn_ids.len() >= MAX_SETTLED_TURN_IDS
    }

    pub(crate) fn rotate_settled_turn_identities_after_provider_restart(
        &mut self,
    ) -> Result<(), LocalRunnerError> {
        if self.active_turn_id.is_some() {
            return Err(LocalRunnerError::invalid(
                "ACPX event scope cannot rotate settled turn identities while a turn is active",
            ));
        }
        if !self.settled_turn_identity_capacity_reached() {
            return Err(LocalRunnerError::invalid(
                "ACPX event scope cannot rotate settled turn identities before capacity",
            ));
        }
        self.settled_turn_ids.clear();
        Ok(())
    }

    pub fn clear_turn(&mut self, turn_id: &str) -> Result<(), LocalRunnerError> {
        validate_scope_id(turn_id, "turn", DURABLE_STABLE_ID_CHARS)?;
        if self.active_turn_id.as_deref() != Some(turn_id) {
            return Err(LocalRunnerError::invalid(
                "ACPX event scope cannot clear a stale turn",
            ));
        }
        if self.settled_turn_ids.len() >= MAX_SETTLED_TURN_IDS {
            return Err(LocalRunnerError::invalid(
                "ACPX event scope exhausted its settled turn identity capacity",
            ));
        }
        if !self.settled_turn_ids.insert(turn_id.to_owned()) {
            return Err(LocalRunnerError::invalid(
                "ACPX event scope reused a settled turn identity",
            ));
        }
        self.active_turn_id = None;
        Ok(())
    }

    pub fn validate_event(&self, event: &AcpxSidecarEvent) -> Result<(), LocalRunnerError> {
        if let Some(run_id) = event.run_id.as_deref() {
            validate_scope_id(run_id, "event run", SHORT_STABLE_ID_CHARS)?;
        }
        if let Some(turn_id) = event.turn_id.as_deref() {
            validate_scope_id(turn_id, "event turn", DURABLE_STABLE_ID_CHARS)?;
        }
        let global_event = matches!(
            event.event_type,
            GeneratedAcpxSidecarEventType::RuntimeProcess
                | GeneratedAcpxSidecarEventType::RuntimeDiagnostic
        );

        match event.run_id.as_deref() {
            Some(run_id) if run_id != self.run_id => {
                return Err(LocalRunnerError::invalid(
                    "ACPX sidecar event named a stale run",
                ));
            }
            Some(_) => {}
            None if !global_event => {
                return Err(LocalRunnerError::invalid(
                    "ACPX sidecar event omitted its run binding",
                ));
            }
            None => {}
        }

        if global_event && event.turn_id.is_none() {
            return Ok(());
        }
        if global_event && event.run_id.is_none() {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar event named a turn without a run binding",
            ));
        }

        let turn_id = event.turn_id.as_deref().ok_or_else(|| {
            LocalRunnerError::invalid("ACPX sidecar event omitted its turn binding")
        })?;
        match self.active_turn_id.as_deref() {
            Some(active_turn_id) if active_turn_id == turn_id => Ok(()),
            Some(_) => Err(LocalRunnerError::invalid(
                "ACPX sidecar event named a stale turn",
            )),
            None => Err(LocalRunnerError::invalid(
                "ACPX sidecar event requires an active turn",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AcpxEventScope, MAX_SETTLED_TURN_IDS};

    #[test]
    fn rotates_a_full_ledger_only_after_revalidating_the_next_identity() {
        let mut scope = AcpxEventScope::new("run-1").unwrap();
        for index in 0..MAX_SETTLED_TURN_IDS {
            let turn_id = format!("turn-{index}");
            scope.bind_turn(&turn_id).unwrap();
            scope.clear_turn(&turn_id).unwrap();
        }

        assert!(scope.settled_turn_identity_capacity_reached());
        scope
            .validate_new_turn_identity_for_provider_restart("turn-next")
            .unwrap();
        assert!(scope
            .validate_new_turn_identity_for_provider_restart("turn-0")
            .is_err());
        scope
            .rotate_settled_turn_identities_after_provider_restart()
            .unwrap();
        scope.bind_turn("turn-next").unwrap();
        scope.clear_turn("turn-next").unwrap();
    }
}

fn validate_scope_id(value: &str, label: &str, max_chars: usize) -> Result<(), LocalRunnerError> {
    if !is_stable_id(value, max_chars) {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX event scope {label} id is invalid"
        )));
    }
    Ok(())
}
