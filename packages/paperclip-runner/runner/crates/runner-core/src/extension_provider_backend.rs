//! The native execution boundary for explicitly installed npm harnesses.
//!
//! The trusted startup profile authenticates executable bytes. A run descriptor
//! can select that profile but cannot grant executable or environment authority.
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::durable::{
    create_private_temporary_file, open_private_regular_file, verify_private_directory, Command,
    CommandExecution, CommandExecutor, DurableRunnerConfig, DurableRunnerError, EventPriority,
    PolledEvent, TerminalDeliveryReconciliation,
};
use crate::process_supervisor::SupervisedProcess;

mod launch_profile;
mod process;
mod protocol;

pub use launch_profile::{
    ExtensionLaunchArtifact, ExtensionLaunchProfile, ExtensionReleaseIdentity,
};
use process::require_group_absent;
use protocol::{parse_frame, provider_event, terminal_state, validate_json_bound, WireEvent};

pub const EXTENSION_PROVIDER_STATE_FILE: &str = "extension-provider-state.json";
pub const EXTENSION_LAUNCH_PROFILE_ENV: &str = "PAPERCLIP_RUNNER_EXTENSION_PROFILE";
const WIRE_SCHEMA: &str = "paperclip.harness.v1";
const STATE_SCHEMA: &str = "paperclip.harness-state.v1";
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PENDING_EVENTS: usize = 512;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

fn invalid(message: impl Into<String>) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}
fn bounded_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    schema: String,
    identity: ExtensionReleaseIdentity,
    launch_digest: String,
    run_id: String,
    session_id: String,
    turn_id: String,
    item_id: String,
    provider: Value,
    generation: u64,
    sequence: u64,
    next_event: u64,
    events: VecDeque<PolledEvent>,
    snapshot: Option<Value>,
    process_group: Option<u32>,
    active_turn: bool,
    disposition: String,
    closed: bool,
    #[serde(default)]
    pending_requests: BTreeMap<String, Value>,
    #[serde(default)]
    provider_session_identity: Option<NativeSessionIdentity>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeSessionIdentity {
    provider_session_id: String,
    backend_session_id: String,
}

fn record_native_identity(state: &mut State, payload: &Value) -> Result<(), DurableRunnerError> {
    let backend = payload
        .get("providerSessionId")
        .or_else(|| payload.get("sessionId"));
    let frontend = payload.get("threadId").or(backend);
    let (Some(frontend), Some(backend)) = (frontend, backend) else {
        return Ok(());
    };
    let identity = NativeSessionIdentity {
        provider_session_id: frontend
            .as_str()
            .filter(|value| bounded_text(value, 160))
            .ok_or_else(|| invalid("extension native session identity is invalid"))?
            .to_owned(),
        backend_session_id: backend
            .as_str()
            .filter(|value| bounded_text(value, 160))
            .ok_or_else(|| invalid("extension backend session identity is invalid"))?
            .to_owned(),
    };
    if state
        .provider_session_identity
        .as_ref()
        .is_some_and(|old| old != &identity)
    {
        return Err(invalid(
            "extension changed its native conversation identity",
        ));
    }
    state.provider_session_identity = Some(identity);
    Ok(())
}

/// One installed harness running behind the ordinary durable Runner transport.
pub struct ExtensionCommandExecutor {
    directory: PathBuf,
    config: DurableRunnerConfig,
    profile: Option<ExtensionLaunchProfile>,
    state: Option<State>,
    restored: bool,
    process: Option<SupervisedProcess>,
    next_request: u64,
    poisoned: bool,
}
impl ExtensionCommandExecutor {
    pub fn with_launch_profile(
        directory: impl Into<PathBuf>,
        config: &DurableRunnerConfig,
        profile: Option<ExtensionLaunchProfile>,
    ) -> Self {
        Self {
            directory: directory.into(),
            config: config.clone(),
            profile,
            state: None,
            restored: false,
            process: None,
            next_request: 1,
            poisoned: false,
        }
    }
    fn profile(&self) -> Result<&ExtensionLaunchProfile, DurableRunnerError> {
        self.profile.as_ref().ok_or_else(|| {
            invalid("extension execution requires an authenticated startup launch profile")
        })
    }
    fn path(&self) -> PathBuf {
        self.directory.join(EXTENSION_PROVIDER_STATE_FILE)
    }
    fn save(&self, state: &State) -> Result<(), DurableRunnerError> {
        verify_private_directory(&self.directory)?;
        let bytes = serde_json::to_vec(state)
            .map_err(|_| invalid("extension state is not serializable"))?;
        if bytes.len() > MAX_STATE_BYTES {
            return Err(invalid("extension state exceeds its storage bound"));
        }
        let path = self.path();
        let (temporary, mut file) = create_private_temporary_file(&path)?;
        let result = (|| {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| invalid("extension state write failed"))?;
            drop(file);
            fs::rename(&temporary, &path).map_err(|_| invalid("extension state commit failed"))?;
            File::open(&self.directory)
                .and_then(|file| file.sync_all())
                .map_err(|_| invalid("extension state directory sync failed"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
    fn update(
        &mut self,
        update: impl FnOnce(&mut State) -> Result<(), DurableRunnerError>,
    ) -> Result<(), DurableRunnerError> {
        let mut next = self
            .state
            .clone()
            .ok_or_else(|| invalid("extension has not been prepared"))?;
        update(&mut next)?;
        self.save(&next)?;
        self.state = Some(next);
        Ok(())
    }
    fn restore(&mut self) -> Result<(), DurableRunnerError> {
        if self.restored {
            return Ok(());
        }
        verify_private_directory(&self.directory)?;
        let mut file = match open_private_regular_file(&self.path()) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.restored = true;
                return Ok(());
            }
            Err(_) => return Err(invalid("extension checkpoint is unavailable or unsafe")),
        };
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take((MAX_STATE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid("extension checkpoint read failed"))?;
        if bytes.len() > MAX_STATE_BYTES {
            return Err(invalid("extension checkpoint is oversized"));
        }
        let state: State = serde_json::from_slice(&bytes)
            .map_err(|_| invalid("extension checkpoint is malformed"))?;
        let profile = self.profile()?;
        if state.schema != STATE_SCHEMA
            || state.identity != profile.identity
            || state.launch_digest != profile.digest()?
            || state.run_id != self.config.run_id
            || state.session_id != self.config.normalized_session_id
            || state.turn_id != self.config.turn_id
            || state.item_id != self.config.item_id
            || state.events.len() > MAX_PENDING_EVENTS
            || state.next_event == 0
            || state.sequence > MAX_SAFE_INTEGER
            || state.generation > MAX_SAFE_INTEGER
            || !state.provider.is_object()
            || state.snapshot.as_ref().is_some_and(|s| !s.is_object())
            || state
                .provider_session_identity
                .as_ref()
                .is_some_and(|identity| {
                    !bounded_text(&identity.provider_session_id, 160)
                        || !bounded_text(&identity.backend_session_id, 160)
                })
        {
            return Err(invalid(
                "extension checkpoint conflicts with its admitted runtime identity",
            ));
        }
        let mut previous_event = 0;
        for event in &state.events {
            let event_id = event
                .executor_event_id
                .strip_prefix("extension:")
                .and_then(|id| id.parse::<u64>().ok())
                .ok_or_else(|| invalid("extension checkpoint event identity is invalid"))?;
            // run.terminal is created by this executor after a provider's turn
            // terminal. It is never accepted directly from the child wire.
            if !(provider_event(&event.event_type) || event.event_type == "run.terminal")
                || !event.payload.is_object()
                || event_id <= previous_event
                || event_id >= state.next_event
                || state.next_event > MAX_SAFE_INTEGER
            {
                return Err(invalid(
                    "extension checkpoint contains an invalid provider event",
                ));
            }
            previous_event = event_id;
        }
        self.state = Some(state);
        self.restored = true;
        Ok(())
    }
    fn prepare(&mut self, payload: &Value) -> Result<(), DurableRunnerError> {
        let provider = payload
            .get("provider")
            .ok_or_else(|| invalid("extension preparation omitted provider"))?;
        let profile = self.profile()?;
        profile.validate()?;
        if provider.get("kind").and_then(Value::as_str) != Some("extension")
            || provider.get("harnessId") != Some(&json!(profile.identity.harness_id))
            || provider.get("release")
                != Some(
                    &serde_json::to_value(&profile.identity)
                        .map_err(|_| invalid("extension identity serialization failed"))?,
                )
        {
            return Err(invalid(
                "extension descriptor does not match its startup release identity",
            ));
        }
        // Executable paths and credentials must not be smuggled into a provider
        // descriptor. Only the immutable startup profile can authorize those.
        if [
            "command",
            "args",
            "entrypoint",
            "environment",
            "environmentKeys",
        ]
        .iter()
        .any(|key| provider.get(*key).is_some())
        {
            return Err(invalid(
                "extension descriptor cannot grant executable or environment authority",
            ));
        }
        if provider.get("model").is_some_and(|model| {
            !model.is_null() && !model.as_str().is_some_and(|value| bounded_text(value, 512))
        }) || provider
            .get("config")
            .is_some_and(|config| !config.is_object())
            || ["cwd", "runtimeDirectory"].iter().any(|key| {
                provider.get(*key).is_some_and(|value| {
                    !value.as_str().is_some_and(|value| {
                        Path::new(value).is_absolute()
                            && Path::new(value).parent().is_some()
                            && !value.contains('\0')
                            && !Path::new(value).components().any(|component| {
                                matches!(component, std::path::Component::ParentDir)
                            })
                    })
                })
            })
        {
            return Err(invalid(
                "extension descriptor model, configuration, or resource directory is invalid",
            ));
        }
        if !provider.get("capabilities").is_some_and(|value| {
            value.as_object().is_some_and(|entries| {
                entries.len() <= 64
                    && entries
                        .iter()
                        .all(|(key, value)| bounded_text(key, 96) && value.is_boolean())
            })
        }) {
            return Err(invalid(
                "extension descriptor capabilities must be a bounded boolean map",
            ));
        }
        if let Some(state) = &self.state {
            if state.provider != *provider {
                return Err(invalid(
                    "extension preparation changes a retained provider descriptor",
                ));
            }
            return Ok(());
        }
        let snapshot = if let Some(checkpoint) =
            provider.get("checkpoint").filter(|value| !value.is_null())
        {
            if checkpoint["schema"] != json!("paperclip.harness-checkpoint.v1")
                || checkpoint["identity"]
                    != serde_json::to_value(&profile.identity)
                        .map_err(|_| invalid("extension checkpoint identity is malformed"))?
                || checkpoint["normalizedSessionId"] != json!(self.config.normalized_session_id)
                || [
                    "model",
                    "config",
                    "cwd",
                    "runtimeDirectory",
                    "accountIdentity",
                    "credentialIdentity",
                ]
                .iter()
                .any(|key| checkpoint.get(*key) != provider.get(*key))
                || !checkpoint["providerState"].is_object()
            {
                return Err(invalid(
                    "extension continuation checkpoint conflicts with the admitted session",
                ));
            }
            if !checkpoint["processGroup"].is_null() {
                let group = checkpoint["processGroup"]
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok())
                    .ok_or_else(|| invalid("extension continuation process group is invalid"))?;
                require_group_absent(group)?;
            }
            validate_json_bound(&checkpoint["providerState"], 0, &mut 0)?;
            Some(checkpoint["providerState"].clone())
        } else {
            None
        };
        let state = State {
            schema: STATE_SCHEMA.to_owned(),
            identity: profile.identity.clone(),
            launch_digest: profile.digest()?,
            run_id: self.config.run_id.clone(),
            session_id: self.config.normalized_session_id.clone(),
            turn_id: self.config.turn_id.clone(),
            item_id: self.config.item_id.clone(),
            provider: provider.clone(),
            generation: 0,
            sequence: 0,
            next_event: 1,
            events: VecDeque::new(),
            snapshot,
            process_group: None,
            active_turn: false,
            disposition: "needs_review".to_owned(),
            closed: false,
            pending_requests: BTreeMap::new(),
            provider_session_identity: provider
                .get("checkpoint")
                .and_then(|checkpoint| checkpoint.get("providerSessionIdentity"))
                .filter(|value| !value.is_null())
                .map(|value| {
                    serde_json::from_value(value.clone())
                        .map_err(|_| invalid("extension checkpoint native identity is invalid"))
                })
                .transpose()?,
        };
        if state
            .provider_session_identity
            .as_ref()
            .is_some_and(|identity| {
                !bounded_text(&identity.provider_session_id, 160)
                    || !bounded_text(&identity.backend_session_id, 160)
            })
        {
            return Err(invalid("extension checkpoint native identity is invalid"));
        }
        self.save(&state)?;
        self.state = Some(state);
        Ok(())
    }
    fn receive_event(&mut self, value: Value) -> Result<(), DurableRunnerError> {
        let event: WireEvent =
            serde_json::from_value(value).map_err(|_| invalid("extension event is malformed"))?;
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| invalid("extension event arrived before preparation"))?;
        if event.schema != WIRE_SCHEMA
            || event.sequence != state.sequence + 1
            || event.sequence > MAX_SAFE_INTEGER
            || !provider_event(&event.event_type)
            || !event.payload.is_object()
            || event
                .turn_id
                .as_ref()
                .is_some_and(|id| id != &state.turn_id)
            || event
                .item_id
                .as_ref()
                .is_some_and(|id| id != &state.item_id)
            || matches!(
                event.event_type.as_str(),
                "turn.completed" | "turn.failed" | "turn.interrupted" | "turn.cancelled"
            ) && !state.active_turn
        {
            return Err(invalid(
                "extension event conflicts with its protocol, order, or admitted authority",
            ));
        }
        let priority = match event.priority.as_str() {
            "p0" => EventPriority::P0,
            "p1" => EventPriority::P1,
            "p2" => EventPriority::P2,
            _ => return Err(invalid("extension event priority is invalid")),
        };
        if priority != EventPriority::P0
            && (event.event_type.starts_with("runtime_request.")
                || event.event_type.starts_with("semantic_tool.")
                || event.event_type == "run.result.proposed"
                || terminal_state(&event.event_type).is_some())
        {
            return Err(invalid(
                "extension authority and terminal facts require P0 delivery",
            ));
        }
        self.update(|state| {
            state.sequence = event.sequence;
            if matches!(event.event_type.as_str(), "session.started" | "session.resumed" | "harness.ready") {
                record_native_identity(state, &event.payload)?;
            }
            if event.event_type == "runtime_request.created" {
                let request = event.payload.get("request").filter(|value| value.is_object()).ok_or_else(|| invalid("extension runtime request is malformed"))?;
                let id = request.get("requestId").and_then(Value::as_str).filter(|id| bounded_text(id, 160)).ok_or_else(|| invalid("extension runtime request identity is missing"))?;
                if !state.active_turn || request.get("turnId").and_then(Value::as_str) != Some(state.turn_id.as_str())
                    || request.get("schema").and_then(Value::as_str) != Some("paperclip.runtime_request.v2")
                    || request.get("status").and_then(Value::as_str) != Some("pending")
                { return Err(invalid("extension runtime request is not bound to current work")); }
                if state.pending_requests.len() >= 16 || state.pending_requests.insert(id.to_owned(), request.clone()).is_some() { return Err(invalid("extension runtime request identity is duplicated or over capacity")); }
            } else if matches!(event.event_type.as_str(), "runtime_request.resolved" | "runtime_request.expired" | "runtime_request.cancelled") {
                let id = event.payload.get("requestId").and_then(Value::as_str).ok_or_else(|| invalid("extension request outcome has no identity"))?;
                if state.pending_requests.remove(id).is_none() { return Err(invalid("extension request outcome is stale")); }
            }
            if event.event_type == "run.result.proposed" {
                state.disposition = event.payload.get("reportedWorkDisposition").and_then(Value::as_str).filter(|value| ["done", "blocked", "needs_review", "yielded"].contains(value)).unwrap_or("needs_review").to_owned();
            }
            push_event(state, event.event_type.clone(), priority, event.payload)?;
            if let Some((turn, run)) = terminal_state(&event.event_type) {
                state.active_turn = false;
                expire_requests(state, "turn_terminal")?;
                push_event(state, "run.terminal".to_owned(), EventPriority::P0, json!({ "schema": "paperclip.prp.terminal.v1", "turnTerminalState": turn, "runTerminalState": run, "reportedWorkDisposition": state.disposition }))?;
            }
            Ok(())
        })
    }
    fn capture_snapshot(&mut self) -> Result<(), DurableRunnerError> {
        let settled = self.state.as_ref().is_some_and(|state| !state.active_turn);
        let snapshot = self.request("snapshot", json!({}))?;
        self.update(|state| {
            // A provider can finish while this request is in flight. Its
            // earlier active snapshot still cannot prove settled continuation.
            state.snapshot = if settled && !state.active_turn {
                Some(snapshot)
            } else {
                None
            };
            Ok(())
        })
    }
    fn exported_checkpoint(&self) -> Option<Value> {
        let state = self.state.as_ref()?;
        let snapshot = state.snapshot.as_ref()?;
        if state.active_turn || !state.pending_requests.is_empty() {
            return None;
        }
        let mut checkpoint = json!({"schema":"paperclip.harness-checkpoint.v1", "identity":state.identity,
            "normalizedSessionId":state.session_id, "providerState":snapshot, "processGroup":state.process_group});
        if let Some(identity) = &state.provider_session_identity {
            checkpoint["providerSessionIdentity"] = serde_json::to_value(identity).ok()?;
        }
        for key in [
            "model",
            "config",
            "cwd",
            "runtimeDirectory",
            "accountIdentity",
            "credentialIdentity",
        ] {
            if let Some(value) = state.provider.get(key) {
                checkpoint[key] = value.clone();
            }
        }
        Some(checkpoint)
    }
    fn settle_stop(&mut self) -> Result<(), DurableRunnerError> {
        self.update(|state| {
            state.closed = true;
            expire_requests(state, "runner_stop")?;
            if state.active_turn {
                state.active_turn = false;
                push_event(state, "turn.cancelled".to_owned(), EventPriority::P0, json!({"providerTerminalObserved":false,"reason":"runner_stop"}))?;
                push_event(state, "run.terminal".to_owned(), EventPriority::P0, json!({"schema":"paperclip.prp.terminal.v1","turnTerminalState":"cancelled","runTerminalState":"cancelled","reportedWorkDisposition":"needs_review"}))?;
            }
            Ok(())
        })
    }
}
fn push_event(
    state: &mut State,
    event_type: String,
    priority: EventPriority,
    payload: Value,
) -> Result<(), DurableRunnerError> {
    if state.events.len() >= MAX_PENDING_EVENTS {
        return Err(invalid("extension event buffer is full"));
    }
    let event_id = state.next_event;
    state.next_event = event_id
        .checked_add(1)
        .filter(|v| *v <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("extension event sequence exhausted"))?;
    state.events.push_back(PolledEvent {
        executor_event_id: format!("extension:{event_id}"),
        event_type,
        priority,
        payload,
    });
    Ok(())
}
fn expire_requests(state: &mut State, reason: &str) -> Result<(), DurableRunnerError> {
    let requests = std::mem::take(&mut state.pending_requests);
    for (id, request) in requests {
        push_event(
            state,
            "runtime_request.expired".to_owned(),
            EventPriority::P0,
            json!({"requestId":id,"requestKind":request["requestKind"],"turnId":state.turn_id,"itemId":request["itemId"],"reason":reason,"replayAllowed":false,"request":request}),
        )?;
    }
    Ok(())
}
impl CommandExecutor for ExtensionCommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        self.restore()?;
        if command.command_type == "run.attach"
            && command.payload.get("paperclipNextAuthority").is_some()
        {
            return Err(invalid(
                "extension warm authority handoff is not supported by this protocol version",
            ));
        }
        if matches!(command.command_type.as_str(), "run.prepare" | "run.attach") {
            self.prepare(&command.payload)?;
        }
        if self.process.is_none()
            && matches!(
                command.command_type.as_str(),
                "runner.drain" | "runner.suspend"
            )
        {
            self.stop_process()?;
            return Ok(CommandExecution::result(
                json!({"retainedEventsDrained":self.state.as_ref().is_none_or(|state| state.events.is_empty()),
                "suspended":command.command_type == "runner.suspend", "providerExitConfirmed":true,"extensionCheckpoint":self.exported_checkpoint()}),
            ));
        }
        let stop = matches!(
            command.command_type.as_str(),
            "turn.stop" | "run.cancel" | "session.close" | "session.destroy" | "runner.shutdown"
        );
        let interrupted = (stop || command.command_type == "runner.suspend")
            && self.state.as_ref().is_some_and(|state| state.active_turn);
        if interrupted {
            self.update(|state| {
                state.snapshot = None;
                Ok(())
            })?;
        }
        if stop && self.process.is_none() {
            self.stop_process()?;
            self.settle_stop()?;
            return Ok(CommandExecution::result(
                json!({"stopped":true,"providerExitConfirmed":true,"extensionCheckpoint":self.exported_checkpoint()}),
            ));
        }
        self.ensure_process()?;
        if command.command_type == "request.resolve" {
            let id = command
                .payload
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("extension request resolution has no identity"))?;
            if !self
                .state
                .as_ref()
                .unwrap()
                .pending_requests
                .contains_key(id)
            {
                return Err(invalid("extension request resolution is stale"));
            }
        }
        if command.command_type == "turn.start" {
            self.update(|state| {
                if state.active_turn {
                    return Err(invalid("extension already has an active turn"));
                }
                state.active_turn = true;
                state.disposition = "needs_review".to_owned();
                state.snapshot = None;
                Ok(())
            })?;
        }
        // Snapshot settled work before the provider disposes its conversation.
        // Active cancellation never exports an older checkpoint as new work.
        if stop && self.state.as_ref().is_some_and(|state| !state.active_turn) {
            if self.capture_snapshot().is_err() {
                // Checkpoint failure must not keep an otherwise owned process
                // alive. Absence of an export is an explicit resume limitation.
                self.stop_process()?;
                self.settle_stop()?;
                return Ok(CommandExecution::result(
                    json!({"stopped":true,"providerExitConfirmed":true,"checkpointAvailable":false,"providerAcknowledged":false}),
                ));
            }
        }
        let result = self.request("execute", json!({"command":command}));
        if stop {
            // Let the trusted provider dispose native resources (including
            // descendants it owns outside the wrapper's process group) before
            // the supervisor enforces the bounded process-group shutdown.
            if self.process.is_some() {
                let _ = self.request("close", json!({"reason":command.command_type}));
            }
            let cleanup = self.stop_process();
            if cleanup.is_ok() {
                self.settle_stop()?;
            }
            cleanup?;
        }
        let mut result = match result {
            Ok(result) => result,
            Err(_) if stop => json!({"stopped":true,"providerAcknowledged":false}),
            Err(error) => return Err(error),
        };
        if stop {
            result["providerExitConfirmed"] = json!(true);
        }
        if matches!(
            command.command_type.as_str(),
            "session.open" | "session.resume"
        ) {
            if let Err(error) = self.update(|state| record_native_identity(state, &result)) {
                self.poison();
                return Err(error);
            }
        }
        if matches!(
            command.command_type.as_str(),
            "session.snapshot" | "runner.suspend"
        ) {
            if !interrupted {
                self.capture_snapshot()?;
            }
            self.update(|state| {
                if command.command_type == "runner.suspend" {
                    expire_requests(state, "durable_handoff")?;
                }
                Ok(())
            })?;
            if command.command_type == "runner.suspend" {
                self.stop_process()?;
            }
        }
        if matches!(
            command.command_type.as_str(),
            "session.snapshot" | "runner.suspend" | "session.close"
        ) {
            if let Some(checkpoint) = self.exported_checkpoint() {
                result["extensionCheckpoint"] = checkpoint;
            }
        }
        Ok(CommandExecution::result(result))
    }
    fn rotate_authority(&mut self, config: &DurableRunnerConfig) {
        self.config = config.clone();
    }
    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.restore()?;
        self.poll_process()?;
        self.retained_events()
    }
    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.restore()?;
        Ok(self
            .state
            .as_ref()
            .map_or_else(Vec::new, |state| state.events.iter().cloned().collect()))
    }
    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        self.restore()?;
        self.update(|state| {
            if count > state.events.len() {
                return Err(invalid(
                    "extension event acknowledgment exceeds retained events",
                ));
            }
            state.events.drain(..count);
            Ok(())
        })
    }
    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        self.restore()?;
        if self.process.is_some() {
            if self.state.as_ref().is_some_and(|state| !state.active_turn) {
                let _ = self.capture_snapshot();
            }
            if self.process.is_some() {
                let _ = self.request("close", json!({"reason":"runner_shutdown"}));
            }
        }
        self.stop_process()
    }
    fn reconcile_terminal_delivery(
        &mut self,
    ) -> Result<TerminalDeliveryReconciliation, DurableRunnerError> {
        self.restore()?;
        self.stop_process()?;
        Ok(TerminalDeliveryReconciliation::CleanupCompleted)
    }
}

#[cfg(all(test, unix))]
mod tests;
#[cfg(test)]
mod validation_tests;
