use crate::acpx_sidecar_transport::AcpxSidecarEvent;
use crate::generated_acpx_sidecar_contract::GeneratedAcpxSidecarEventType;
use crate::local_runner::LocalRunnerError;

const MAX_SCOPE_ID_CHARS: usize = 160;

/// Holds the run and turn authority used to admit ACPX sidecar events.
///
/// The sidecar transport validates framing and sequence identity. This scope
/// validates that a well-formed event still belongs to the run and turn that
/// runnerd is currently executing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcpxEventScope {
    run_id: String,
    active_turn_id: Option<String>,
}

impl AcpxEventScope {
    pub fn new(run_id: impl Into<String>) -> Result<Self, LocalRunnerError> {
        let run_id = run_id.into();
        validate_scope_id(&run_id, "run")?;
        Ok(Self {
            run_id,
            active_turn_id: None,
        })
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn active_turn_id(&self) -> Option<&str> {
        self.active_turn_id.as_deref()
    }

    pub fn bind_turn(&mut self, turn_id: impl Into<String>) -> Result<(), LocalRunnerError> {
        let turn_id = turn_id.into();
        validate_scope_id(&turn_id, "turn")?;
        match self.active_turn_id.as_deref() {
            Some(active_turn_id) if active_turn_id == turn_id.as_str() => Ok(()),
            Some(_) => Err(LocalRunnerError::invalid(
                "ACPX event scope already has a different active turn",
            )),
            None => {
                self.active_turn_id = Some(turn_id);
                Ok(())
            }
        }
    }

    pub fn clear_turn(&mut self, turn_id: &str) -> Result<(), LocalRunnerError> {
        validate_scope_id(turn_id, "turn")?;
        if self.active_turn_id.as_deref() != Some(turn_id) {
            return Err(LocalRunnerError::invalid(
                "ACPX event scope cannot clear a stale turn",
            ));
        }
        self.active_turn_id = None;
        Ok(())
    }

    pub fn validate_event(&self, event: &AcpxSidecarEvent) -> Result<(), LocalRunnerError> {
        if let Some(run_id) = event.run_id.as_deref() {
            validate_scope_id(run_id, "event run")?;
        }
        if let Some(turn_id) = event.turn_id.as_deref() {
            validate_scope_id(turn_id, "event turn")?;
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

fn validate_scope_id(value: &str, label: &str) -> Result<(), LocalRunnerError> {
    if value.is_empty()
        || value.chars().count() > MAX_SCOPE_ID_CHARS
        || value.chars().any(char::is_control)
    {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX event scope {label} id is invalid"
        )));
    }
    Ok(())
}
