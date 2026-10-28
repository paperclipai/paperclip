use std::path::PathBuf;

use serde_json::Value;

use crate::acpx_provider_backend::{AcpxCommandExecutor, ACPX_PROVIDER_STATE_FILE};
use crate::credential_observer::CredentialObserver;
use crate::durable::{
    Command, CommandExecution, CommandExecutor, DurableRunnerConfig, DurableRunnerError,
    PolledEvent, TerminalDeliveryReconciliation,
};
use crate::external_provider_backend::{
    ExternalCommandExecutor, ExternalProviderCodec, DOT_PROVIDER_STATE_FILE,
    MUSE_PROVIDER_STATE_FILE,
};
use crate::managed_provider_backend::{
    ManagedProviderCommandExecutor, MANAGED_PROVIDER_STATE_FILE,
};
use crate::provider_backend::{CodexCommandExecutor, CODEX_PROVIDER_STATE_FILE};

enum SelectedExecutor {
    LocalFacade(CodexCommandExecutor),
    Acpx(AcpxCommandExecutor),
    Managed(ManagedProviderCommandExecutor),
    Dot(ExternalCommandExecutor),
}

impl CommandExecutor for SelectedExecutor {
    fn can_reconcile_result_delivery(&mut self) -> Result<bool, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.can_reconcile_result_delivery(),
            Self::Acpx(executor) => executor.can_reconcile_result_delivery(),
            Self::Managed(executor) => executor.can_reconcile_result_delivery(),
            Self::Dot(executor) => executor.can_reconcile_result_delivery(),
        }
    }

    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.retained_events(),
            Self::Acpx(executor) => executor.retained_events(),
            Self::Managed(executor) => executor.retained_events(),
            Self::Dot(executor) => executor.retained_events(),
        }
    }
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.execute(command),
            Self::Acpx(executor) => executor.execute(command),
            Self::Managed(executor) => executor.execute(command),
            Self::Dot(executor) => executor.execute(command),
        }
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.poll_events(),
            Self::Acpx(executor) => executor.poll_events(),
            Self::Managed(executor) => executor.poll_events(),
            Self::Dot(executor) => executor.poll_events(),
        }
    }

    fn rotate_authority(&mut self, config: &DurableRunnerConfig) {
        match self {
            Self::LocalFacade(executor) => executor.rotate_authority(config),
            Self::Acpx(executor) => executor.rotate_authority(config),
            Self::Managed(executor) => executor.rotate_authority(config),
            Self::Dot(executor) => executor.rotate_authority(config),
        }
    }

    fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.maintain_backpressured_provider(),
            Self::Acpx(executor) => executor.maintain_backpressured_provider(),
            Self::Managed(executor) => executor.maintain_backpressured_provider(),
            Self::Dot(executor) => executor.maintain_backpressured_provider(),
        }
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.acknowledge_events(count),
            Self::Acpx(executor) => executor.acknowledge_events(count),
            Self::Managed(executor) => executor.acknowledge_events(count),
            Self::Dot(executor) => executor.acknowledge_events(count),
        }
    }

    fn reconcile_terminal_delivery(
        &mut self,
    ) -> Result<TerminalDeliveryReconciliation, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.reconcile_terminal_delivery(),
            Self::Acpx(executor) => executor.reconcile_terminal_delivery(),
            Self::Managed(executor) => executor.reconcile_terminal_delivery(),
            Self::Dot(executor) => executor.reconcile_terminal_delivery(),
        }
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.shutdown(),
            Self::Acpx(executor) => executor.shutdown(),
            Self::Managed(executor) => executor.shutdown(),
            Self::Dot(executor) => executor.shutdown(),
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
    credentials: CredentialObserver,
}

impl NativeProviderCommandExecutor {
    pub fn with_runner_config(state_dir: impl Into<PathBuf>, config: &DurableRunnerConfig) -> Self {
        let state_dir = state_dir.into();
        let credentials = CredentialObserver::new(&state_dir, &config.normalized_session_id);
        Self {
            state_dir,
            config: config.clone(),
            selected: None,
            recovery_checked: false,
            credentials,
        }
    }

    fn select_recovery(&mut self) -> Result<(), DurableRunnerError> {
        self.credentials.restore()?;
        if self.recovery_checked {
            return Ok(());
        }
        self.recovery_checked = true;
        let codex = self.state_dir.join(CODEX_PROVIDER_STATE_FILE).exists();
        let acpx = self.state_dir.join(ACPX_PROVIDER_STATE_FILE).exists();
        let managed = self.state_dir.join(MANAGED_PROVIDER_STATE_FILE).exists();
        let dot = self.state_dir.join(DOT_PROVIDER_STATE_FILE).exists();
        let muse = self.state_dir.join(MUSE_PROVIDER_STATE_FILE).exists();
        if [codex, acpx, managed, dot, muse]
            .into_iter()
            .filter(|present| *present)
            .count()
            > 1
        {
            return Err(DurableRunnerError::invalid(
                "runner state contains conflicting provider authorities",
            ));
        }
        self.selected = if muse {
            Some(SelectedExecutor::Dot(ExternalCommandExecutor::with_codec(
                &self.state_dir,
                &self.config,
                ExternalProviderCodec::Muse,
            )))
        } else if dot {
            Some(SelectedExecutor::Dot(
                ExternalCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ))
        } else if managed {
            Some(SelectedExecutor::Managed(
                ManagedProviderCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ))
        } else if acpx {
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
            "muse" => SelectedExecutor::Dot(ExternalCommandExecutor::with_codec(
                &self.state_dir,
                &self.config,
                ExternalProviderCodec::Muse,
            )),
            "openai_dot" => SelectedExecutor::Dot(ExternalCommandExecutor::with_runner_config(
                &self.state_dir,
                &self.config,
            )),
            "grok_bot" => SelectedExecutor::Dot(ExternalCommandExecutor::with_codec(
                &self.state_dir,
                &self.config,
                ExternalProviderCodec::Grok,
            )),
            "codex" | "opencode" => SelectedExecutor::LocalFacade(
                CodexCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ),
            "acpx" => SelectedExecutor::Acpx(AcpxCommandExecutor::with_runner_config(
                &self.state_dir,
                &self.config,
            )),
            "claude_managed" | "aws_agentcore" => SelectedExecutor::Managed(
                ManagedProviderCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ),
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
    fn can_reconcile_result_delivery(&mut self) -> Result<bool, DurableRunnerError> {
        self.select_recovery()?;
        self.selected
            .as_mut()
            .map_or(Ok(false), CommandExecutor::can_reconcile_result_delivery)
    }

    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.credentials.restore()?;
        if let Some(event) = self.credentials.pending() {
            return Ok(vec![event]);
        }
        self.selected
            .as_mut()
            .map_or_else(|| Ok(Vec::new()), CommandExecutor::retained_events)
    }
    fn retained_runner_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.credentials.restore()?;
        Ok(self.credentials.pending().into_iter().collect())
    }
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        self.select_recovery()?;
        if self.selected.is_none()
            && matches!(command.command_type.as_str(), "run.prepare" | "run.attach")
        {
            self.select_from_payload(&command.payload)?;
        }
        if matches!(
            command.command_type.as_str(),
            "session.close"
                | "session.destroy"
                | "runner.suspend"
                | "runner.shutdown"
                | "turn.stop"
                | "run.cancel"
        ) {
            self.credentials.poll(true)?;
        }
        let result = self
            .selected
            .as_mut()
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "run.prepare must select a provider before provider commands execute",
                )
            })?
            .execute(command);
        if result.is_ok() && matches!(command.command_type.as_str(), "run.prepare" | "run.attach") {
            self.credentials.configure(&command.payload)?;
        }
        if matches!(command.command_type.as_str(), "session.open" | "run.attach") {
            self.credentials.activate()?;
        }
        if !matches!(command.command_type.as_str(), "run.prepare") {
            self.credentials.poll(true)?;
        }
        result
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.select_recovery()?;
        self.credentials.poll(false)?;
        if let Some(event) = self.credentials.pending() {
            return Ok(vec![event]);
        }
        let events = self
            .selected
            .as_mut()
            .map_or_else(|| Ok(Vec::new()), CommandExecutor::poll_events)?;
        let terminal = events.iter().any(|event| {
            matches!(
                event.event_type.as_str(),
                "turn.completed"
                    | "turn.failed"
                    | "turn.interrupted"
                    | "turn.cancelled"
                    | "harness.exited"
            )
        });
        self.credentials.poll(terminal)?;
        Ok(self
            .credentials
            .pending()
            .map_or(events, |event| vec![event]))
    }

    fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
        // A provider that has not yet been selected/restored cannot have
        // in-process cleanup to advance. Never launch one merely for ACK debt.
        self.selected
            .as_mut()
            .map_or_else(|| Ok(()), CommandExecutor::maintain_backpressured_provider)
    }

    fn rotate_authority(&mut self, config: &DurableRunnerConfig) {
        self.config = config.clone();
        if let Some(executor) = self.selected.as_mut() {
            executor.rotate_authority(config);
        }
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        self.select_recovery()?;
        if count > 0 && self.credentials.pending().is_some() {
            return self.credentials.acknowledge(count);
        }
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

    fn reconcile_terminal_delivery(
        &mut self,
    ) -> Result<TerminalDeliveryReconciliation, DurableRunnerError> {
        // Selection only loads the provider authority. The selected executor
        // decides whether terminal delivery can settle without a cold launch.
        self.select_recovery()?;
        let outcome = self.selected.as_mut().map_or_else(
            || Ok(TerminalDeliveryReconciliation::CleanupCompleted),
            CommandExecutor::reconcile_terminal_delivery,
        )?;
        self.credentials.poll(true)?;
        Ok(outcome)
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        // Terminal delivery can be reconciled by a replacement runner whose
        // executor has not processed a provider command. Select the durable
        // provider authority before cleanup so an absent in-memory selection
        // can never turn the cleanup fence into a successful no-op.
        self.select_recovery()?;
        let cleanup = if let Some(executor) = self.selected.as_mut() {
            executor.shutdown()
        } else {
            Ok(())
        };
        cleanup.and(self.credentials.poll(true))
    }
}
