use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::codex_provider::{CodexProvider, CodexProviderConfig, CodexProviderEvent};
use crate::durable::{
    create_private_temporary_file, open_private_regular_file, verify_private_directory, Command,
    CommandExecution, CommandExecutor, DurableRunnerError, EventPriority, PolledEvent,
};
use crate::provider_events::{normalize_codex_notification, NormalizedProviderEvent};

const PROVIDER_STATE_SCHEMA: &str = "paperclip.runner.codex-provider-state.v1";
const PROVIDER_STATE_FILE: &str = "codex-provider-state.json";
const MAX_PROVIDER_STATE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EVENTS_PER_POLL: usize = 128;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CompletionContractBinding {
    revision: String,
    criterion_ids: Vec<String>,
}

fn initial_provider_event_seq() -> u64 {
    1
}

fn provider_event_id(sequence: u64) -> String {
    format!("codex_provider_{sequence:016}")
}

fn provider_event_sequence(event_id: &str) -> Option<u64> {
    let sequence = event_id.strip_prefix("codex_provider_")?.parse().ok()?;
    (provider_event_id(sequence) == event_id).then_some(sequence)
}

fn completion_contract(
    payload: &Value,
) -> Result<Option<CompletionContractBinding>, DurableRunnerError> {
    let Some(value) = payload.get("completionContract") else {
        return Ok(None);
    };
    let binding: CompletionContractBinding =
        serde_json::from_value(value.clone()).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "run.prepare completionContract is invalid: {error}"
            ))
        })?;
    if binding.revision.is_empty()
        || binding.revision.len() > 120
        || binding.criterion_ids.is_empty()
        || binding.criterion_ids.len() > 256
        || binding.criterion_ids.iter().any(|criterion| {
            criterion.is_empty() || criterion.len() > 240 || criterion.chars().any(char::is_control)
        })
    {
        return Err(DurableRunnerError::invalid(
            "run.prepare completionContract is malformed or oversized",
        ));
    }
    Ok(Some(binding))
}

fn terminal_events(state: &CodexProviderState, event_type: &str) -> Vec<NormalizedProviderEvent> {
    let Some(contract) = state.completion_contract.as_ref() else {
        return Vec::new();
    };
    let succeeded = event_type == "turn.completed";
    let cancelled = matches!(event_type, "turn.cancelled" | "turn.interrupted");
    let disposition = if succeeded { "done" } else { "needs_review" };
    let summary = state.last_agent_message.clone().unwrap_or_else(|| {
        if succeeded {
            "Codex completed the requested work.".to_owned()
        } else if cancelled {
            "The Codex run stopped before it completed.".to_owned()
        } else {
            "The Codex run failed before it completed.".to_owned()
        }
    });
    let evidence_ref = "provider:codex:agent-message";
    let criteria = contract
        .criterion_ids
        .iter()
        .map(|criterion_id| {
            json!({
                "criterionId": criterion_id,
                "status": if succeeded { "satisfied" } else { "unknown" },
                "evidenceRefs": if succeeded { vec![evidence_ref] } else { Vec::<&str>::new() },
            })
        })
        .collect::<Vec<_>>();
    let result = json!({
        "schema": "paperclip.run_result.v1",
        "reportedWorkDisposition": disposition,
        "summary": summary,
        "completionClaim": {
            "contractRevision": contract.revision,
            "objectiveSatisfied": succeeded,
            "criteria": criteria,
            "remainingWork": if succeeded { Vec::<Value>::new() } else { vec![json!({
                "description": "Review the stopped Codex run and continue the task.",
                "blocksCompletion": true,
            })] },
        },
        "evidence": if succeeded { vec![json!({ "ref": evidence_ref })] } else { Vec::<Value>::new() },
        "verification": [],
        "attentionRequests": if succeeded { Vec::<Value>::new() } else { vec![json!({
            "kind": "review",
            "summary": "Review the stopped Codex run before continuing.",
            "ownerClass": "human",
        })] },
        "artifacts": [],
    });
    let turn_terminal_state = if succeeded {
        "completed"
    } else if event_type == "turn.interrupted" {
        "interrupted"
    } else if cancelled {
        "cancelled"
    } else {
        "failed"
    };
    let terminal = json!({
        "schema": "paperclip.prp.terminal.v1",
        "turnTerminalState": turn_terminal_state,
        "runTerminalState": if succeeded { "succeeded" } else if cancelled { "cancelled" } else { "failed" },
        "reportedWorkDisposition": disposition,
    });
    vec![
        NormalizedProviderEvent {
            event_type: "run.result.proposed".to_owned(),
            priority: EventPriority::P0,
            payload: result,
        },
        NormalizedProviderEvent {
            event_type: "run.terminal".to_owned(),
            priority: EventPriority::P0,
            payload: terminal,
        },
    ]
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CodexProviderState {
    schema: String,
    lifecycle: String,
    config: CodexProviderConfig,
    #[serde(default)]
    completion_contract: Option<CompletionContractBinding>,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    provider_session_id: Option<String>,
    #[serde(default)]
    active_provider_turn_id: Option<String>,
    #[serde(default)]
    last_agent_message: Option<String>,
    #[serde(default)]
    pending_events: VecDeque<PolledEvent>,
    #[serde(default = "initial_provider_event_seq")]
    next_provider_event_seq: u64,
}

impl CodexProviderState {
    fn new(
        config: CodexProviderConfig,
        completion_contract: Option<CompletionContractBinding>,
    ) -> Self {
        let thread_id = config.provider_session_id.clone();
        Self {
            schema: PROVIDER_STATE_SCHEMA.to_owned(),
            lifecycle: "prepared".to_owned(),
            config,
            completion_contract,
            thread_id,
            provider_session_id: None,
            active_provider_turn_id: None,
            last_agent_message: None,
            pending_events: VecDeque::new(),
            next_provider_event_seq: initial_provider_event_seq(),
        }
    }

    fn validate(&self) -> Result<(), DurableRunnerError> {
        self.config
            .validate()
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        let mut pending_event_ids = HashSet::new();
        if self.schema != PROVIDER_STATE_SCHEMA
            || !matches!(
                self.lifecycle.as_str(),
                "prepared" | "session_open" | "turn_active" | "provider_exited" | "closed"
            )
            || self
                .thread_id
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 240)
            || self
                .provider_session_id
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 240)
            || self
                .active_provider_turn_id
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 240)
            || self.completion_contract.as_ref().is_some_and(|contract| {
                contract.revision.is_empty()
                    || contract.revision.len() > 120
                    || contract.criterion_ids.is_empty()
                    || contract.criterion_ids.len() > 256
                    || contract.criterion_ids.iter().any(|criterion| {
                        criterion.is_empty()
                            || criterion.len() > 240
                            || criterion.chars().any(char::is_control)
                    })
            })
            || self
                .last_agent_message
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 1_000_000)
            || (self.thread_id.is_none()
                && (self.provider_session_id.is_some()
                    || self.active_provider_turn_id.is_some()
                    || matches!(self.lifecycle.as_str(), "session_open" | "turn_active")))
            || (self.lifecycle == "turn_active" && self.active_provider_turn_id.is_none())
            || (matches!(
                self.lifecycle.as_str(),
                "prepared" | "session_open" | "closed"
            ) && self.active_provider_turn_id.is_some())
            || self.next_provider_event_seq == 0
            || self.pending_events.len() > MAX_EVENTS_PER_POLL + 3
            || self.pending_events.iter().any(|event| {
                provider_event_sequence(&event.executor_event_id)
                    .is_none_or(|sequence| sequence >= self.next_provider_event_seq)
                    || !pending_event_ids.insert(event.executor_event_id.as_str())
                    || event.event_type.is_empty()
                    || event.event_type.len() > 160
                    || event.event_type.chars().any(char::is_control)
                    || !event.payload.is_object()
            })
        {
            return Err(DurableRunnerError::invalid(
                "Codex provider state is malformed or inconsistent",
            ));
        }
        Ok(())
    }

    fn push_event(&mut self, event: NormalizedProviderEvent) -> Result<(), DurableRunnerError> {
        let sequence = self.next_provider_event_seq;
        self.next_provider_event_seq = sequence
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("provider event sequence exhausted"))?;
        self.pending_events.push_back(PolledEvent {
            executor_event_id: provider_event_id(sequence),
            event_type: event.event_type,
            priority: event.priority,
            payload: event.payload,
        });
        Ok(())
    }

    fn extend_events(
        &mut self,
        events: impl IntoIterator<Item = NormalizedProviderEvent>,
    ) -> Result<(), DurableRunnerError> {
        for event in events {
            self.push_event(event)?;
        }
        Ok(())
    }
}

pub struct CodexCommandExecutor {
    state_dir: PathBuf,
    state: Option<CodexProviderState>,
    provider: Option<CodexProvider>,
    restore_checked: bool,
}

impl CodexCommandExecutor {
    pub fn new(state_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
            state: None,
            provider: None,
            restore_checked: false,
        }
    }

    fn state_path(&self) -> PathBuf {
        self.state_dir.join(PROVIDER_STATE_FILE)
    }

    fn restore(&mut self) -> Result<(), DurableRunnerError> {
        if self.restore_checked {
            return Ok(());
        }
        self.restore_checked = true;
        let path = self.state_path();
        let mut file = match open_private_regular_file(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(DurableRunnerError::invalid(format!(
                    "failed to open private Codex provider state: {error}"
                )))
            }
        };
        let metadata = file.metadata().map_err(|error| {
            DurableRunnerError::invalid(format!("failed to inspect Codex provider state: {error}"))
        })?;
        if metadata.len() > MAX_PROVIDER_STATE_BYTES {
            return Err(DurableRunnerError::invalid(
                "Codex provider state must be a bounded regular file",
            ));
        }
        let mut input = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut input).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to read Codex provider state: {error}"))
        })?;
        let state: CodexProviderState = serde_json::from_slice(&input).map_err(|error| {
            DurableRunnerError::invalid(format!("Codex provider state is malformed: {error}"))
        })?;
        state.validate()?;
        self.state = Some(state);
        self.restore_provider_if_needed()
    }

    fn restore_provider_if_needed(&mut self) -> Result<(), DurableRunnerError> {
        let Some(state) = self.state.as_ref() else {
            return Ok(());
        };
        if self.provider.is_some()
            || !matches!(
                state.lifecycle.as_str(),
                "session_open" | "turn_active" | "provider_exited"
            )
        {
            return Ok(());
        }
        let provider_had_exited = state.lifecycle == "provider_exited";
        let thread_id = state.thread_id.clone().ok_or_else(|| {
            DurableRunnerError::invalid("recoverable Codex state omitted its thread id")
        })?;
        let previous_active_turn_id = state.active_provider_turn_id.clone();
        let provider = CodexProvider::start(&state.config, Some(&thread_id)).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to resume Codex provider: {error}"))
        })?;
        let recovered_active_turn_id = provider.active_provider_turn_id().map(str::to_owned);
        self.provider = Some(provider);
        if provider_had_exited || recovered_active_turn_id != previous_active_turn_id {
            let state = self
                .state
                .as_mut()
                .expect("Codex state remains available during recovery");
            state.active_provider_turn_id = recovered_active_turn_id.clone();
            state.lifecycle = if recovered_active_turn_id.is_some() {
                "turn_active".to_owned()
            } else {
                "session_open".to_owned()
            };
            state.push_event(NormalizedProviderEvent {
                event_type: "session.reconciled".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": "codex",
                    "providerSessionId": thread_id,
                    "previousProviderTurnId": previous_active_turn_id,
                    "activeProviderTurnId": recovered_active_turn_id,
                }),
            })?;
            self.save_state()?;
        }
        Ok(())
    }

    fn save_state(&self) -> Result<(), DurableRunnerError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider state is unavailable"))?;
        self.persist_state(state)
    }

    fn persist_state(&self, state: &CodexProviderState) -> Result<(), DurableRunnerError> {
        state.validate()?;
        fs::create_dir_all(&self.state_dir).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to create provider state directory: {error}"
            ))
        })?;
        #[cfg(unix)]
        fs::set_permissions(&self.state_dir, fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                DurableRunnerError::invalid(format!(
                    "failed to protect provider state directory: {error}"
                ))
            },
        )?;
        verify_private_directory(&self.state_dir)?;
        let path = self.state_path();
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to serialize Codex provider state: {error}"
            ))
        })?;
        if bytes.len() as u64 > MAX_PROVIDER_STATE_BYTES {
            return Err(DurableRunnerError::invalid(
                "Codex provider state exceeds the 2 MiB limit",
            ));
        }
        let (temporary, mut file) = create_private_temporary_file(&path)?;
        let result = (|| -> std::io::Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &path)?;
            #[cfg(unix)]
            File::open(&self.state_dir)?.sync_all()?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(DurableRunnerError::invalid(format!(
                "failed to replace provider state atomically: {error}"
            )));
        }
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to protect provider state: {error}"))
        })?;
        Ok(())
    }

    fn prepare(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let config: CodexProviderConfig = serde_json::from_value(
            payload
                .get("provider")
                .cloned()
                .ok_or_else(|| DurableRunnerError::invalid("run.prepare requires provider"))?,
        )
        .map_err(|error| {
            DurableRunnerError::invalid(format!("run.prepare provider is invalid: {error}"))
        })?;
        config
            .validate()
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        let completion_contract = completion_contract(payload)?;
        if let Some(state) = &self.state {
            if state.config != config || state.completion_contract != completion_contract {
                return Err(DurableRunnerError::invalid(
                    "Codex provider or completion contract changed across the durable run",
                ));
            }
            if state.lifecycle == "closed" {
                return Err(DurableRunnerError::invalid(
                    "Codex provider session is already closed",
                ));
            }
        } else {
            self.state = Some(CodexProviderState::new(config, completion_contract));
            self.save_state()?;
        }
        Ok(CommandExecution::result(json!({
            "status": "prepared",
            "provider": "codex",
            "driver": "codex_app_server",
        })))
    }

    fn ensure_provider(&mut self) -> Result<&mut CodexProvider, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        if self.provider.is_none() {
            let state = self.state.as_ref().ok_or_else(|| {
                DurableRunnerError::invalid("Codex provider has not been prepared")
            })?;
            if state.lifecycle == "closed" {
                return Err(DurableRunnerError::invalid(
                    "Codex provider session is closed",
                ));
            }
            let provider = CodexProvider::start(&state.config, state.thread_id.as_deref())
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("failed to start Codex provider: {error}"))
                })?;
            self.provider = Some(provider);
        }
        self.provider
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is unavailable"))
    }

    fn open_session(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.lifecycle == "turn_active")
        {
            return Err(DurableRunnerError::invalid(
                "cannot open a new Codex session while a provider turn is active",
            ));
        }
        let resumed = self
            .state
            .as_ref()
            .and_then(|state| state.thread_id.as_ref())
            .is_some();
        let (thread_id, provider_session_id, process_id) = {
            let provider = self.ensure_provider()?;
            (
                provider.thread_id().to_owned(),
                provider.provider_session_id().map(str::to_owned),
                provider.process_id(),
            )
        };
        let provider_version = {
            let state = self
                .state
                .as_mut()
                .expect("Codex state exists after provider start");
            state.thread_id = Some(thread_id.clone());
            state.provider_session_id = provider_session_id.clone();
            state.active_provider_turn_id = None;
            state.lifecycle = "session_open".to_owned();
            state.config.provider_version.clone()
        };
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({
                "status": if resumed { "resumed" } else { "started" },
                "provider": "codex",
                "driver": "codex_app_server",
                "providerVersion": provider_version,
                "providerSessionId": thread_id,
                "processId": process_id,
            }),
            events: vec![(
                if resumed {
                    "session.resumed"
                } else {
                    "session.started"
                }
                .to_owned(),
                EventPriority::P0,
                json!({
                    "provider": "codex",
                    "providerSessionId": thread_id,
                    "providerAccountSessionId": provider_session_id,
                    "processId": process_id,
                }),
            )],
        })
    }

    fn start_turn(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.active_provider_turn_id.is_some())
        {
            return Err(DurableRunnerError::invalid(
                "Codex already has an active provider turn",
            ));
        }
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("turn.start payload.text is required"))?;
        let cwd = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is not prepared"))?
            .config
            .cwd
            .clone();
        let (provider_turn_id, thread_id) = {
            let provider = self.ensure_provider()?;
            provider.start_turn(text, &cwd).map_err(|error| {
                DurableRunnerError::invalid(format!("Codex turn/start failed: {error}"))
            })?;
            (
                provider
                    .active_provider_turn_id()
                    .ok_or_else(|| {
                        DurableRunnerError::invalid("Codex turn/start omitted its turn identity")
                    })?
                    .to_owned(),
                provider.thread_id().to_owned(),
            )
        };
        let state = self
            .state
            .as_mut()
            .expect("Codex state exists after turn start");
        state.active_provider_turn_id = Some(provider_turn_id.clone());
        state.last_agent_message = None;
        state.lifecycle = "turn_active".to_owned();
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({"status": "accepted", "providerTurnId": provider_turn_id}),
            events: vec![(
                "turn.accepted".to_owned(),
                EventPriority::P0,
                json!({"provider": "codex", "providerSessionId": thread_id, "providerTurnId": provider_turn_id}),
            )],
        })
    }

    fn interrupt_turn(&mut self, reason: &str) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        let provider_turn_id = self
            .state
            .as_ref()
            .and_then(|state| state.active_provider_turn_id.clone());
        if provider_turn_id.is_none() {
            return Ok(CommandExecution::result(json!({
                "status": "already_settled",
                "reason": reason,
            })));
        }
        self.ensure_provider()?.interrupt_turn().map_err(|error| {
            DurableRunnerError::invalid(format!("Codex turn interrupt failed: {error}"))
        })?;
        Ok(CommandExecution::result(json!({
            "status": "interrupt_requested",
            "reason": reason,
            "providerTurnId": provider_turn_id,
        })))
    }

    fn steer_turn(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("turn.steer payload.text is required"))?;
        self.ensure_provider()?.steer_turn(text).map_err(|error| {
            DurableRunnerError::invalid(format!("Codex turn steer failed: {error}"))
        })?;
        Ok(CommandExecution::result(json!({"status": "steered"})))
    }

    fn resolve_request(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let request_id = payload
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires requestId"))?;
        let response = payload
            .get("response")
            .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires response"))?;
        self.ensure_provider()?
            .resolve_runtime_request(request_id, response)
            .map_err(|error| {
                DurableRunnerError::invalid(format!("Codex runtime response failed: {error}"))
            })?;
        Ok(CommandExecution {
            result: json!({"status": "delivered", "requestId": request_id}),
            events: vec![(
                "runtime_request.resolved".to_owned(),
                EventPriority::P0,
                json!({"provider": "codex", "requestId": request_id, "status": "delivered"}),
            )],
        })
    }

    fn close_session(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        if let Some(provider) = self.provider.as_mut() {
            provider.shutdown().map_err(|error| {
                DurableRunnerError::invalid(format!("failed to stop Codex provider: {error}"))
            })?;
        }
        self.provider = None;
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is not prepared"))?;
        state.active_provider_turn_id = None;
        state.lifecycle = "closed".to_owned();
        let thread_id = state.thread_id.clone();
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({"status": "closed", "providerSessionId": thread_id}),
            events: vec![(
                "session.closed".to_owned(),
                EventPriority::P0,
                json!({"provider": "codex", "providerSessionId": thread_id}),
            )],
        })
    }

    fn snapshot(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider is not prepared"))?;
        Ok(CommandExecution::result(json!({
            "status": state.lifecycle,
            "provider": "codex",
            "driver": "codex_app_server",
            "providerSessionId": state.thread_id,
            "activeProviderTurnId": state.active_provider_turn_id,
        })))
    }

    fn poll_provider(&mut self) -> Result<(), DurableRunnerError> {
        self.restore()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| !state.pending_events.is_empty())
        {
            return Ok(());
        }
        if self.provider.is_none() {
            return Ok(());
        }
        for _ in 0..MAX_EVENTS_PER_POLL {
            let event = self
                .provider
                .as_mut()
                .expect("provider remains present while polling")
                .poll()
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("Codex provider failed: {error}"))
                })?;
            let Some(event) = event else { break };
            match event {
                CodexProviderEvent::Notification { method, params } => {
                    let normalized = normalize_codex_notification(&method, &params);
                    let terminal_event_type = normalized
                        .iter()
                        .find(|event| event.event_type.starts_with("turn."))
                        .map(|event| event.event_type.clone())
                        .filter(|event_type| {
                            matches!(
                                event_type.as_str(),
                                "turn.completed"
                                    | "turn.failed"
                                    | "turn.cancelled"
                                    | "turn.interrupted"
                            )
                        });
                    let state = self
                        .state
                        .as_mut()
                        .expect("Codex state remains available while polling");
                    if method == "item/completed" {
                        let item = params.get("item").unwrap_or(&params);
                        if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                            state.last_agent_message = item
                                .get("text")
                                .and_then(Value::as_str)
                                .filter(|text| !text.is_empty())
                                .map(|text| text.chars().take(1_000_000).collect());
                        }
                    }
                    if method == "turn/completed" {
                        state.active_provider_turn_id = None;
                        state.lifecycle = "session_open".to_owned();
                    }
                    state.extend_events(normalized)?;
                    if let Some(event_type) = terminal_event_type {
                        state.extend_events(terminal_events(state, &event_type))?;
                    }
                    self.save_state()?;
                }
                CodexProviderEvent::RuntimeRequest {
                    request_id,
                    question_set,
                } => {
                    let prompt = question_set
                        .get("title")
                        .or_else(|| question_set.pointer("/questions/0/prompt"))
                        .and_then(Value::as_str)
                        .unwrap_or("Codex needs your input");
                    self.state
                        .as_mut()
                        .expect("Codex state remains available while polling")
                        .push_event(NormalizedProviderEvent {
                            event_type: "runtime_request.created".to_owned(),
                            priority: EventPriority::P0,
                            payload: json!({
                                "request": {
                                    "schema": "paperclip.runtime_request.v2",
                                    "requestKind": "runtime",
                                    "requestId": request_id,
                                    "type": "input",
                                    "status": "pending",
                                    "prompt": prompt,
                                    "input": question_set,
                                    "origin": {
                                        "adapter": "codex-app-server",
                                        "provider": "codex",
                                        "method": "item/tool/requestUserInput",
                                    },
                                },
                            }),
                        })?;
                    self.save_state()?;
                }
                CodexProviderEvent::Exited { exit_code, success } => {
                    self.provider = None;
                    if let Some(state) = self.state.as_mut() {
                        state.lifecycle = "provider_exited".to_owned();
                        state.push_event(NormalizedProviderEvent {
                            event_type: "session.failed".to_owned(),
                            priority: EventPriority::P0,
                            payload: json!({
                                "provider": "codex",
                                "code": "provider_exited",
                                "exitCode": exit_code,
                                "expected": success,
                            }),
                        })?;
                    }
                    self.save_state()?;
                    break;
                }
            }
        }
        Ok(())
    }
}

impl CommandExecutor for CodexCommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        self.restore()?;
        match command.command_type.as_str() {
            "run.prepare" => self.prepare(&command.payload),
            "run.attach" => {
                if self.state.is_none() && command.payload.get("provider").is_some() {
                    self.prepare(&command.payload)?;
                }
                let mut execution = self.open_session()?;
                execution.events.push((
                    "run.attached".to_owned(),
                    EventPriority::P0,
                    json!({"provider": "codex"}),
                ));
                Ok(execution)
            }
            "session.open" => self.open_session(),
            "turn.start" => self.start_turn(&command.payload),
            "turn.steer" => self.steer_turn(&command.payload),
            "turn.interrupt" | "turn.stop" | "run.cancel" => {
                self.interrupt_turn(&command.command_type)
            }
            "request.resolve" => self.resolve_request(&command.payload),
            "session.snapshot" => self.snapshot(),
            "session.close" | "session.destroy" => self.close_session(),
            "runner.drain" | "runner.suspend" | "runner.shutdown" => {
                Ok(CommandExecution::result(json!({"status": "completed"})))
            }
            _ => Ok(CommandExecution::result(json!({
                "status": "rejected",
                "code": "provider_command_unavailable",
                "message": "the Codex provider does not implement this command in the current layer",
            }))),
        }
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.poll_provider()?;
        Ok(self
            .state
            .as_ref()
            .into_iter()
            .flat_map(|state| state.pending_events.iter())
            .cloned()
            .collect())
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        if count == 0 {
            return Ok(());
        }
        let mut next_state = self
            .state
            .clone()
            .ok_or_else(|| DurableRunnerError::invalid("Codex provider state is unavailable"))?;
        if count > next_state.pending_events.len() {
            return Err(DurableRunnerError::invalid(
                "provider event acknowledgement exceeded the pending prefix",
            ));
        }
        next_state.pending_events.drain(..count);
        self.persist_state(&next_state)?;
        self.state = Some(next_state);
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        if let Some(provider) = self.provider.as_mut() {
            provider.shutdown().map_err(|error| {
                DurableRunnerError::invalid(format!("failed to stop Codex provider: {error}"))
            })?;
        }
        self.provider = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_inconsistent_provider_state() {
        let state = CodexProviderState {
            schema: PROVIDER_STATE_SCHEMA.to_owned(),
            lifecycle: "turn_active".to_owned(),
            config: CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: Vec::new(),
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            completion_contract: None,
            thread_id: Some("thread-1".to_owned()),
            provider_session_id: None,
            active_provider_turn_id: None,
            last_agent_message: None,
            pending_events: VecDeque::new(),
            next_provider_event_seq: initial_provider_event_seq(),
        };
        assert!(state.validate().is_err());
    }

    #[test]
    fn emits_a_structured_result_before_the_terminal_event() {
        let mut state = CodexProviderState::new(
            CodexProviderConfig {
                provider: "codex".to_owned(),
                driver: "codex_app_server".to_owned(),
                provider_version: "test".to_owned(),
                command: PathBuf::from("codex"),
                args: vec!["app-server".to_owned()],
                cwd: std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                model: None,
                provider_session_id: None,
                instructions: String::new(),
                approval_policy: "never".to_owned(),
            },
            Some(CompletionContractBinding {
                revision: "1".to_owned(),
                criterion_ids: vec!["objective".to_owned()],
            }),
        );
        state.last_agent_message = Some("Finished the requested work.".to_owned());
        let events = terminal_events(&state, "turn.completed");
        assert_eq!(events[0].event_type, "run.result.proposed");
        assert_eq!(events[0].payload["summary"], "Finished the requested work.");
        assert_eq!(events[1].event_type, "run.terminal");
        assert_eq!(events[1].payload["runTerminalState"], "succeeded");
    }
}
