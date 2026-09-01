use std::path::PathBuf;

use serde_json::Value;

use crate::acpx_provider_backend::{AcpxCommandExecutor, ACPX_PROVIDER_STATE_FILE};
use crate::durable::{
    Command, CommandExecution, CommandExecutor, DurableRunnerConfig, DurableRunnerError,
    PolledEvent,
};
use crate::provider_backend::{CodexCommandExecutor, CODEX_PROVIDER_STATE_FILE};

enum SelectedExecutor {
    LocalFacade(CodexCommandExecutor),
    Acpx(AcpxCommandExecutor),
}

impl CommandExecutor for SelectedExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.execute(command),
            Self::Acpx(executor) => executor.execute(command),
        }
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.poll_events(),
            Self::Acpx(executor) => executor.poll_events(),
        }
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.acknowledge_events(count),
            Self::Acpx(executor) => executor.acknowledge_events(count),
        }
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.shutdown(),
            Self::Acpx(executor) => executor.shutdown(),
        }
    }
}

/// Selects one durable provider implementation for the lifetime of a runner.
/// Recovery selection comes only from mutually exclusive private state files;
/// fresh selection comes only from the controller's run.prepare descriptor.
pub struct NativeProviderCommandExecutor {
    state_dir: PathBuf,
    config: DurableRunnerConfig,
    selected: Option<SelectedExecutor>,
    recovery_checked: bool,
}

impl NativeProviderCommandExecutor {
    pub fn with_runner_config(state_dir: impl Into<PathBuf>, config: &DurableRunnerConfig) -> Self {
        Self {
            state_dir: state_dir.into(),
            config: config.clone(),
            selected: None,
            recovery_checked: false,
        }
    }

    fn select_recovery(&mut self) -> Result<(), DurableRunnerError> {
        if self.recovery_checked {
            return Ok(());
        }
        self.recovery_checked = true;
        let codex = self.state_dir.join(CODEX_PROVIDER_STATE_FILE).exists();
        let acpx = self.state_dir.join(ACPX_PROVIDER_STATE_FILE).exists();
        if codex && acpx {
            return Err(DurableRunnerError::invalid(
                "runner state contains conflicting local provider authorities",
            ));
        }
        self.selected = if acpx {
            Some(SelectedExecutor::Acpx(
                AcpxCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ))
        } else if codex {
            Some(SelectedExecutor::LocalFacade(
                CodexCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ))
        } else {
            None
        };
        Ok(())
    }

    fn select_from_payload(&mut self, payload: &Value) -> Result<(), DurableRunnerError> {
        let kind = payload
            .pointer("/provider/kind")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "run.prepare requires a supported provider kind before runner execution",
                )
            })?;
        self.selected = Some(match kind {
            "codex" | "opencode" => SelectedExecutor::LocalFacade(
                CodexCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ),
            "acpx" => SelectedExecutor::Acpx(AcpxCommandExecutor::with_runner_config(
                &self.state_dir,
                &self.config,
            )),
            _ => {
                return Err(DurableRunnerError::invalid(format!(
                    "provider kind {kind} is not executable through the local runnerd boundary"
                )))
            }
        });
        Ok(())
    }
}

impl CommandExecutor for NativeProviderCommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        self.select_recovery()?;
        if self.selected.is_none()
            && matches!(command.command_type.as_str(), "run.prepare" | "run.attach")
        {
            self.select_from_payload(&command.payload)?;
        }
        self.selected
            .as_mut()
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "run.prepare must select a provider before provider commands execute",
                )
            })?
            .execute(command)
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.select_recovery()?;
        self.selected
            .as_mut()
            .map_or_else(|| Ok(Vec::new()), CommandExecutor::poll_events)
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        self.select_recovery()?;
        if let Some(executor) = self.selected.as_mut() {
            executor.acknowledge_events(count)
        } else if count == 0 {
            Ok(())
        } else {
            Err(DurableRunnerError::invalid(
                "cannot acknowledge provider events before provider selection",
            ))
        }
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        if let Some(executor) = self.selected.as_mut() {
            executor.shutdown()
        } else {
            Ok(())
        }
    }
}
