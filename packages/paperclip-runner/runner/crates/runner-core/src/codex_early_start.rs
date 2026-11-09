use std::time::{Duration, Instant};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    local_process_definitely_gone, CodexCommandExecutor, CodexProviderState,
    NormalizedProviderEvent, ProviderStartupAttempt, ProviderStartupCommand,
    ProviderStartupTrigger,
};
use crate::codex_provider::{CodexProvider, CodexStartupHandshake};
use crate::durable::{Command, DurableRunnerError, EventPriority};

const EARLY_STARTUP_RETIREMENT_PROOF: Duration = Duration::from_secs(2);

pub(super) fn uncontacted_early_start(
    state: &CodexProviderState,
    attempt: &ProviderStartupAttempt,
) -> bool {
    state.lifecycle == "prepared"
        && state.thread_id.is_none()
        && attempt.trigger == ProviderStartupTrigger::Ensure
        && attempt
            .command
            .as_ref()
            .is_some_and(|command| command.command_type == "run.prepare")
}

pub(super) struct EarlyCodexProvider {
    provider: CodexProvider,
    handshake: CodexStartupHandshake,
    generation: u64,
    launch_id: String,
}

impl CodexCommandExecutor {
    fn early_start_eligible(&self) -> bool {
        cfg!(unix)
            && self.provider.is_none()
            && self.early_provider.is_none()
            && self.startup_evidence_error.is_none()
            && self.restore_error.is_none()
            && self.state.as_ref().is_some_and(|state| {
                state.config.provider == "codex"
                    && state.lifecycle == "prepared"
                    && state.thread_id.is_none()
                    && state.startup_attempt.is_none()
                    && state.active_provider_turn_id.is_none()
            })
    }

    pub(crate) fn start_provider_early(&mut self, command: &Command) {
        if !self.early_start_eligible() {
            return;
        }
        let Some(generation) = self
            .state
            .as_ref()
            .and_then(|state| state.provider_process_generation.checked_add(1))
        else {
            return;
        };
        self.startup_command = Some(ProviderStartupCommand {
            command_id: command.command_id.clone(),
            controller_seq: command.controller_seq,
            command_type: command.command_type.clone(),
        });
        let launched = self.launch_observed_provider(ProviderStartupTrigger::Ensure, generation);
        self.startup_command = None;
        match launched {
            Ok((provider, handshake)) => {
                let launch_id = self
                    .state
                    .as_ref()
                    .and_then(|state| state.startup_attempt.as_ref())
                    .map(|attempt| attempt.launch_id.clone())
                    .unwrap_or_default();
                self.early_provider = Some(EarlyCodexProvider {
                    provider,
                    handshake,
                    generation,
                    launch_id,
                });
            }
            Err(_) => {
                let _ = self.retire_early_startup(None);
            }
        }
    }

    pub(super) fn holds_early_provider(&self) -> bool {
        self.early_provider.is_some()
    }

    pub(super) fn take_early_provider(
        &mut self,
        generation: u64,
    ) -> Result<Option<(CodexProvider, CodexStartupHandshake)>, DurableRunnerError> {
        let Some(mut early) = self.early_provider.take() else {
            return Ok(None);
        };
        let current = early.generation == generation
            && self.state.as_ref().is_some_and(|state| {
                state.lifecycle == "prepared"
                    && state.thread_id.is_none()
                    && state.startup_attempt.as_ref().is_some_and(|attempt| {
                        attempt.launch_id == early.launch_id
                            && attempt.attempted_process_generation == generation
                            && attempt.origin == self.event_identity
                            && serde_json::to_vec(&state.config).is_ok_and(|configuration| {
                                attempt.configuration_fingerprint
                                    == format!("sha256:{:x}", Sha256::digest(configuration))
                            })
                    })
            });
        if current && early.provider.launched_process_running() {
            let command = self.startup_command.clone();
            if let Some(attempt) = self
                .state
                .as_mut()
                .and_then(|state| state.startup_attempt.as_mut())
            {
                attempt.command = command;
            }
            let claimed = self.save_startup_state(false);
            if let Err(error) = claimed {
                let _ = early.provider.retire_failed_startup();
                return Err(error);
            }
            return Ok(Some((early.provider, early.handshake)));
        }
        self.retire_early_startup(Some(&mut early.provider))?;
        Ok(None)
    }

    pub(super) fn discard_early_provider(&mut self) -> Result<(), DurableRunnerError> {
        match self.early_provider.take() {
            Some(mut early) => self.retire_early_startup(Some(&mut early.provider)),
            None => Ok(()),
        }
    }

    fn retire_early_startup(
        &mut self,
        provider: Option<&mut CodexProvider>,
    ) -> Result<(), DurableRunnerError> {
        if let Some(provider) = provider {
            let _ = provider.retire_failed_startup();
        }
        if self.startup_evidence_error.is_some() {
            return Ok(());
        }
        let Some(attempt) = self
            .state
            .as_ref()
            .and_then(|state| state.startup_attempt.clone())
        else {
            return Ok(());
        };
        let proven_gone = match (attempt.process_id, attempt.process_group_id) {
            (None, None) => true,
            (Some(pid), Some(group)) => {
                let deadline = Instant::now() + EARLY_STARTUP_RETIREMENT_PROOF;
                loop {
                    if local_process_definitely_gone(pid, false)
                        && local_process_definitely_gone(group, true)
                    {
                        break true;
                    }
                    if Instant::now() >= deadline {
                        break false;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            _ => false,
        };
        if !proven_gone {
            return Ok(());
        }
        let mut next = self
            .state
            .clone()
            .ok_or_else(|| DurableRunnerError::invalid("provider startup state missing"))?;
        next.startup_attempt = None;
        next.push_terminal_event(NormalizedProviderEvent {
            event_type: "harness.diagnostic".to_owned(),
            priority: EventPriority::P0,
            payload: json!({"code":"provider_startup_retired", "startup": attempt}),
        })?;
        self.persist_state(&next)?;
        self.state = Some(next);
        Ok(())
    }
}
