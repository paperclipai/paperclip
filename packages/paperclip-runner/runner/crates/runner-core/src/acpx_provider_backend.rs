use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, DirBuilder, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(test)]
use sha2::{Digest, Sha256};

use crate::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSession, AcpxProviderSessionConfig, AcpxProviderSessionIdentity,
};
use crate::acpx_sidecar_transport::AcpxSidecarTransportConfig;
#[cfg(test)]
use crate::durable::QualifiedLaunchArtifact;
use crate::durable::{
    create_private_temporary_file, open_private_regular_file, verify_private_directory,
    AcpxLaunchProfile, Command, CommandExecution, CommandExecutor, DurableRunnerConfig,
    DurableRunnerError, EventPriority, PolledEvent,
};
use crate::process_supervisor::{VerifiedProcessArgument, VerifiedProcessLaunch};
use crate::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedToolSet, ToolResult, TOOL_SET_SCHEMA,
};
use crate::provider_events::{
    project_acpx_state_event, AcpxEventProjectionContext, NormalizedProviderEvent,
};
use crate::qualified_launch::verify_launch_artifact;

pub const ACPX_PROVIDER_STATE_FILE: &str = "acpx-provider-state.json";
const ACPX_PROVIDER_STATE_SCHEMA: &str = "paperclip.runner.acpx-provider-state.v2";
const MAX_PROVIDER_STATE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PENDING_EVENTS: usize = 8_320;
const MAX_EVENTS_PER_POLL: usize = 128;

fn initial_event_sequence() -> u64 {
    1
}

fn event_id(sequence: u64) -> String {
    format!("acpx_provider_{sequence:016}")
}

fn event_sequence(value: &str) -> Option<u64> {
    let sequence = value.strip_prefix("acpx_provider_")?.parse().ok()?;
    (event_id(sequence) == value).then_some(sequence)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcpxProviderDescriptor {
    kind: String,
    provider: String,
    driver: String,
    provider_version: String,
    agent: String,
    model: String,
    acpx_version: String,
    agent_server_package: String,
    agent_server_version: String,
    agent_runtime_package: Option<String>,
    agent_runtime_version: Option<String>,
    command_digest: String,
    sidecar_command: PathBuf,
    #[serde(default)]
    sidecar_args: Vec<String>,
    runtime_directory: PathBuf,
    normalized_session_id: String,
    run_id: String,
    cwd: String,
    #[serde(default)]
    instructions: String,
    permission_mode: AcpxPermissionMode,
    permission_mode_pinned: bool,
    #[serde(default)]
    runtime_context: Value,
}

impl AcpxProviderDescriptor {
    fn validate(&self, context: &AcpxEventProjectionContext) -> Result<(), DurableRunnerError> {
        let expected = match self.agent.as_str() {
            "claude" => (
                "claude-sonnet-5",
                "@agentclientprotocol/claude-agent-acp",
                "0.70.0",
                None,
                None,
                "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
            ),
            "codex" => (
                "gpt-5.6-sol",
                "@agentclientprotocol/codex-acp",
                "1.6.2",
                None,
                None,
                "sha256:94049b3e3c3aee87de62703786e4fa81d031d7bd979f99bdf516d84f28791a79",
            ),
            "pi" => return Err(DurableRunnerError::invalid(
                "ACPX agent pi is not executable through the verified runnerd provider boundary",
            )),
            _ => {
                return Err(DurableRunnerError::invalid(
                    "ACPX agent must be a qualified claude or codex profile",
                ))
            }
        };
        if self.kind != "acpx"
            || self.provider != "acpx"
            || self.driver != "acpx_runtime"
            || self.provider_version != "0.13.1"
            || self.acpx_version != "0.13.1"
            || self.model != expected.0
            || self.agent_server_package != expected.1
            || self.agent_server_version != expected.2
            || self.agent_runtime_package.as_deref() != expected.3
            || self.agent_runtime_version.as_deref() != expected.4
            || self.command_digest != expected.5
        {
            return Err(DurableRunnerError::invalid(
                "ACPX provider descriptor does not match a qualified immutable profile",
            ));
        }
        if !self.permission_mode_pinned {
            return Err(DurableRunnerError::invalid(
                "ACPX permission mode must be pinned by runner policy",
            ));
        }
        if self.run_id != context.run_id
            || self.normalized_session_id != context.normalized_session_id
        {
            return Err(DurableRunnerError::invalid(
                "ACPX descriptor identity conflicts with the durable runner identity",
            ));
        }
        if self.instructions.len() > 1024 * 1024 || self.instructions.contains('\0') {
            return Err(DurableRunnerError::invalid(
                "ACPX instructions exceed their bounded contract",
            ));
        }
        if !self.runtime_context.is_null() && !self.runtime_context.is_object() {
            return Err(DurableRunnerError::invalid(
                "ACPX runtimeContext must be an object or null",
            ));
        }
        Ok(())
    }

    fn session_config(
        &self,
        tool_set: AuthorizedToolSet,
        expected_identity: Option<AcpxProviderSessionIdentity>,
        launch_profile: Option<&AcpxLaunchProfile>,
    ) -> Result<AcpxProviderSessionConfig, DurableRunnerError> {
        secure_directory(&self.runtime_directory, "ACPX runtime")?;
        let transport = self.verified_transport(launch_profile)?;
        Ok(AcpxProviderSessionConfig {
            transport,
            agent: self.agent.clone(),
            model: self.model.clone(),
            run_id: self.run_id.clone(),
            catalog_revision: 1,
            runtime_directory: self.runtime_directory.clone(),
            normalized_session_id: self.normalized_session_id.clone(),
            working_directory: PathBuf::from(&self.cwd),
            permission_mode: self.permission_mode,
            permission_mode_pinned: self.permission_mode_pinned,
            system_instructions: self.instructions.clone(),
            tool_set,
            expected_identity,
        })
    }

    fn verified_transport(
        &self,
        launch_profile: Option<&AcpxLaunchProfile>,
    ) -> Result<AcpxSidecarTransportConfig, DurableRunnerError> {
        let launch_profile = launch_profile.ok_or_else(|| {
            DurableRunnerError::invalid(
                "ACPX runner startup omitted its qualified sidecar launch profile",
            )
        })?;
        if self.sidecar_command != launch_profile.command
            || self.sidecar_args != launch_profile.args
        {
            return Err(DurableRunnerError::invalid(
                "ACPX descriptor sidecar launch does not match the runner-owned qualified profile",
            ));
        }

        let mut verified = HashMap::new();
        for artifact in &launch_profile.artifacts {
            if verified.contains_key(&artifact.path) {
                return Err(DurableRunnerError::invalid(
                    "ACPX runner launch profile repeats an artifact path",
                ));
            }
            let snapshot = verify_launch_artifact(artifact, "ACPX")?;
            verified.insert(artifact.path.clone(), snapshot);
        }
        let command = verified
            .get(&launch_profile.command)
            .cloned()
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "ACPX runner launch profile does not authenticate its command",
                )
            })?;
        let verified_args = launch_profile
            .args
            .iter()
            .map(|argument| {
                let path = Path::new(argument);
                if !path.is_absolute() {
                    return Ok(VerifiedProcessArgument::Literal(argument.clone()));
                }
                verified
                    .get(path)
                    .cloned()
                    .map(VerifiedProcessArgument::Artifact)
                    .ok_or_else(|| {
                        DurableRunnerError::invalid(
                            "ACPX runner launch profile does not authenticate an absolute argument",
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(AcpxSidecarTransportConfig {
            command: launch_profile.command.clone(),
            args: launch_profile.args.clone(),
            verified_launch: Some(VerifiedProcessLaunch::new(command, verified_args)),
            request_timeout: Duration::from_secs(30),
            shutdown_grace: Duration::from_secs(2),
        })
    }

    fn public_descriptor(&self, identity: Option<&AcpxProviderSessionIdentity>) -> Value {
        json!({
            "provider": "acpx",
            "driver": "acpx_runtime",
            "providerVersion": self.provider_version,
            "agent": self.agent,
            "model": self.model,
            "requestedModel": self.model,
            "executionKind": "local_process",
            "acpProtocolVersion": 1,
            "agentServerPackage": self.agent_server_package,
            "agentServerVersion": self.agent_server_version,
            "agentRuntimePackage": self.agent_runtime_package,
            "agentRuntimeVersion": self.agent_runtime_version,
            "providerSessionId": identity.map(|value| value.agent_session_id.as_str()),
            "acpxRecordId": identity.map(|value| value.acpx_record_id.as_str()),
            "permissionMode": self.permission_mode,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcpxDurableState {
    schema: String,
    launch_profile_digest: String,
    lifecycle: String,
    descriptor: AcpxProviderDescriptor,
    tool_set: AuthorizedToolSet,
    #[serde(default)]
    identity: Option<AcpxProviderSessionIdentity>,
    #[serde(default)]
    active_turn_id: Option<String>,
    #[serde(default)]
    semantic_result: Option<Value>,
    #[serde(default)]
    pending_events: VecDeque<PolledEvent>,
    #[serde(default = "initial_event_sequence")]
    next_event_sequence: u64,
}

impl AcpxDurableState {
    fn new(
        descriptor: AcpxProviderDescriptor,
        tool_set: AuthorizedToolSet,
        launch_profile_digest: String,
    ) -> Self {
        Self {
            schema: ACPX_PROVIDER_STATE_SCHEMA.to_owned(),
            launch_profile_digest,
            lifecycle: "prepared".to_owned(),
            descriptor,
            tool_set,
            identity: None,
            active_turn_id: None,
            semantic_result: None,
            pending_events: VecDeque::new(),
            next_event_sequence: initial_event_sequence(),
        }
    }

    fn validate(
        &self,
        context: &AcpxEventProjectionContext,
        expected_launch_profile_digest: &str,
    ) -> Result<(), DurableRunnerError> {
        self.descriptor.validate(context)?;
        if self.launch_profile_digest != expected_launch_profile_digest {
            return Err(DurableRunnerError::invalid(
                "ACPX durable launch profile digest does not match runner startup",
            ));
        }
        let mut ids = HashSet::new();
        if self.schema != ACPX_PROVIDER_STATE_SCHEMA
            || self.launch_profile_digest.len() != 71
            || !self.launch_profile_digest.starts_with("sha256:")
            || !matches!(
                self.lifecycle.as_str(),
                "prepared"
                    | "session_open"
                    | "turn_starting"
                    | "turn_active"
                    | "suspended"
                    | "closed"
            )
            || self.next_event_sequence == 0
            || self.pending_events.len() > MAX_PENDING_EVENTS
            || self.pending_events.iter().any(|event| {
                event_sequence(&event.executor_event_id)
                    .is_none_or(|sequence| sequence >= self.next_event_sequence)
                    || !ids.insert(event.executor_event_id.as_str())
                    || event.event_type.is_empty()
                    || !event.payload.is_object()
            })
            || (matches!(self.lifecycle.as_str(), "turn_starting" | "turn_active")
                != self.active_turn_id.is_some())
            || self
                .semantic_result
                .as_ref()
                .is_some_and(|result| !result.is_object())
            || (self.identity.is_none()
                && !matches!(self.lifecycle.as_str(), "prepared" | "closed"))
        {
            return Err(DurableRunnerError::invalid(
                "ACPX durable provider state is malformed or inconsistent",
            ));
        }
        if let Some(identity) = self.identity.as_ref() {
            identity
                .validate()
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
            if identity.profile_digest != self.descriptor.command_digest {
                return Err(DurableRunnerError::invalid(
                    "ACPX durable identity no longer matches its qualified profile digest",
                ));
            }
        }
        Ok(())
    }

    fn push(&mut self, event: NormalizedProviderEvent) -> Result<(), DurableRunnerError> {
        if self.pending_events.len() >= MAX_PENDING_EVENTS {
            return Err(DurableRunnerError::invalid(
                "ACPX provider event backlog exceeds its durable limit",
            ));
        }
        let sequence = self.next_event_sequence;
        self.next_event_sequence = sequence
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("ACPX event sequence exhausted"))?;
        self.pending_events.push_back(PolledEvent {
            executor_event_id: event_id(sequence),
            event_type: event.event_type,
            priority: event.priority,
            payload: event.payload,
        });
        Ok(())
    }
}

pub struct AcpxCommandExecutor {
    state_dir: PathBuf,
    context: AcpxEventProjectionContext,
    state: Option<AcpxDurableState>,
    session: Option<AcpxProviderSession>,
    restore_checked: bool,
    restore_error: Option<DurableRunnerError>,
    launch_profile: Option<AcpxLaunchProfile>,
}

impl AcpxCommandExecutor {
    pub fn with_runner_config(state_dir: impl Into<PathBuf>, config: &DurableRunnerConfig) -> Self {
        Self {
            state_dir: state_dir.into(),
            context: AcpxEventProjectionContext {
                run_id: config.run_id.clone(),
                normalized_session_id: config.normalized_session_id.clone(),
                turn_id: config.turn_id.clone(),
                item_id: config.item_id.clone(),
            },
            state: None,
            session: None,
            restore_checked: false,
            restore_error: None,
            launch_profile: config.acpx_launch_profile.clone(),
        }
    }

    pub fn state_path(&self) -> PathBuf {
        self.state_dir.join(ACPX_PROVIDER_STATE_FILE)
    }

    fn launch_profile_digest(&self) -> Result<String, DurableRunnerError> {
        self.launch_profile
            .as_ref()
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "ACPX runner startup omitted its qualified sidecar launch profile",
                )
            })?
            .canonical_digest()
    }

    fn restore(&mut self) -> Result<(), DurableRunnerError> {
        if self.restore_checked {
            return Ok(());
        }
        if let Some(error) = self.restore_error.as_ref() {
            return Err(error.clone());
        }
        match self.restore_once() {
            Ok(()) => {
                self.restore_checked = true;
                Ok(())
            }
            Err(error) => {
                self.restore_error = Some(error.clone());
                Err(error)
            }
        }
    }

    fn restore_once(&mut self) -> Result<(), DurableRunnerError> {
        let path = self.state_path();
        let mut file = match open_private_regular_file(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(DurableRunnerError::invalid(format!(
                    "failed to open private ACPX provider state: {error}"
                )))
            }
        };
        let length = file
            .metadata()
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to inspect ACPX provider state: {error}"
                ))
            })?
            .len();
        if length > MAX_PROVIDER_STATE_BYTES {
            return Err(DurableRunnerError::invalid(
                "ACPX provider state exceeds the 16 MiB limit",
            ));
        }
        let mut bytes = Vec::with_capacity(length as usize);
        file.read_to_end(&mut bytes).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to read ACPX provider state: {error}"))
        })?;
        let state: AcpxDurableState = serde_json::from_slice(&bytes).map_err(|error| {
            DurableRunnerError::invalid(format!("ACPX provider state is malformed: {error}"))
        })?;
        let launch_profile_digest = self.launch_profile_digest()?;
        state.validate(&self.context, &launch_profile_digest)?;
        self.state = Some(state);
        self.restore_session_if_needed()
    }

    fn restore_session_if_needed(&mut self) -> Result<(), DurableRunnerError> {
        if self.session.is_some() {
            return Ok(());
        }
        let Some(state) = self.state.as_ref() else {
            return Ok(());
        };
        if !matches!(
            state.lifecycle.as_str(),
            "session_open" | "turn_starting" | "turn_active" | "suspended"
        ) {
            return Ok(());
        }
        let unsafe_active = matches!(state.lifecycle.as_str(), "turn_starting" | "turn_active");
        let previous_turn = state.active_turn_id.clone();
        if unsafe_active {
            let state = self
                .state
                .as_mut()
                .expect("ACPX state remains available during recovery");
            state.lifecycle = "closed".to_owned();
            state.active_turn_id = None;
            state.push(NormalizedProviderEvent {
                event_type: "turn.failed".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": "acpx",
                    "providerTurnId": previous_turn,
                    "status": "failed",
                    "providerTerminalObserved": false,
                    "code": "acpx_active_turn_recovery_closed",
                    "providerShutdownFailed": false,
                }),
            })?;
            state.push(NormalizedProviderEvent {
                event_type: "run.terminal".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "status": "failed",
                    "runTerminalState": "failed",
                    "reportedWorkDisposition": "unknown",
                    "provider": "acpx",
                }),
            })?;
            self.save_state()?;
            return Ok(());
        }
        let session = self.start_session(true)?;
        let identity = session.identity().clone();
        let process_id = session.process_id();
        let state = self
            .state
            .as_mut()
            .expect("ACPX state remains available during recovery");
        state.lifecycle = "session_open".to_owned();
        state.push(NormalizedProviderEvent {
            event_type: "session.resumed".to_owned(),
            priority: EventPriority::P0,
            payload: session_event_payload(&state.descriptor, &identity, process_id),
        })?;
        self.session = Some(session);
        self.save_state()
    }

    fn start_session(&self, recovering: bool) -> Result<AcpxProviderSession, DurableRunnerError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider has not been prepared"))?;
        let expected = recovering.then(|| state.identity.clone()).flatten();
        let config = state.descriptor.session_config(
            state.tool_set.clone(),
            expected,
            self.launch_profile.as_ref(),
        )?;
        let mut session = AcpxProviderSession::start(&config).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to start ACPX provider: {error}"))
        })?;
        if session.identity().profile_digest != state.descriptor.command_digest {
            let _ = session.shutdown("qualified ACPX profile digest mismatch");
            return Err(DurableRunnerError::invalid(
                "ACPX provider identity did not attest the qualified command digest",
            ));
        }
        Ok(session)
    }

    fn save_state(&self) -> Result<(), DurableRunnerError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider state is unavailable"))?;
        let launch_profile_digest = self.launch_profile_digest()?;
        state.validate(&self.context, &launch_profile_digest)?;
        secure_directory(&self.state_dir, "provider state")?;
        let path = self.state_path();
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to serialize ACPX state: {error}"))
        })?;
        if bytes.len() as u64 > MAX_PROVIDER_STATE_BYTES {
            return Err(DurableRunnerError::invalid(
                "ACPX provider state exceeds the 16 MiB limit",
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
                "failed to atomically replace ACPX provider state: {error}"
            )));
        }
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to protect ACPX provider state: {error}"))
        })?;
        Ok(())
    }

    fn prepare(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let descriptor: AcpxProviderDescriptor = serde_json::from_value(
            payload
                .get("provider")
                .cloned()
                .ok_or_else(|| DurableRunnerError::invalid("run.prepare requires provider"))?,
        )
        .map_err(|error| {
            DurableRunnerError::invalid(format!("run.prepare ACPX provider is invalid: {error}"))
        })?;
        descriptor.validate(&self.context)?;
        let tool_set = authorized_tool_set(payload)?;
        let launch_profile_digest = self.launch_profile_digest()?;
        if let Some(state) = self.state.as_ref() {
            if state.descriptor != descriptor || state.tool_set != tool_set {
                return Err(DurableRunnerError::invalid(
                    "ACPX provider or authorized tool contract changed across the durable run",
                ));
            }
            if state.lifecycle == "closed" {
                return Err(DurableRunnerError::invalid(
                    "ACPX provider session is already closed",
                ));
            }
        } else {
            self.state = Some(AcpxDurableState::new(
                descriptor,
                tool_set,
                launch_profile_digest,
            ));
            self.save_state()?;
        }
        Ok(CommandExecution::result(json!({
            "status": "prepared",
            "provider": "acpx",
            "driver": "acpx_runtime",
        })))
    }

    fn attach_run(&mut self, payload: &Value) -> Result<(), DurableRunnerError> {
        let descriptor: AcpxProviderDescriptor = serde_json::from_value(
            payload
                .get("provider")
                .cloned()
                .ok_or_else(|| DurableRunnerError::invalid("run.attach requires provider"))?,
        )
        .map_err(|error| {
            DurableRunnerError::invalid(format!("run.attach ACPX provider is invalid: {error}"))
        })?;
        descriptor.validate(&self.context)?;
        let tool_set = authorized_tool_set(payload)?;
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider has not been prepared"))?;
        let mut durable_descriptor = descriptor.clone();
        durable_descriptor.run_id = state.descriptor.run_id.clone();
        let only_recovery_notice_pending = state
            .pending_events
            .iter()
            .all(|event| event.event_type == "session.resumed");
        if state.lifecycle == "closed"
            || state.identity.is_none()
            || state.active_turn_id.is_some()
            || !only_recovery_notice_pending
            || durable_descriptor != state.descriptor
        {
            return Err(DurableRunnerError::invalid(
                "run.attach requires the same settled ACPX provider profile and session",
            ));
        }
        if let Some(session) = self.session.as_mut() {
            session
                .shutdown("run authority rotation")
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to checkpoint ACPX before attaching a new run: {error}"
                    ))
                })?;
        }
        self.session = None;
        let state = self
            .state
            .as_mut()
            .expect("ACPX state remains available while attaching a run");
        state.descriptor = descriptor;
        state.tool_set = tool_set;
        state.semantic_result = None;
        state.pending_events.clear();
        state.lifecycle = "suspended".to_owned();
        self.save_state()
    }

    fn open_session(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        if self.session.is_none() {
            let recovering = self
                .state
                .as_ref()
                .and_then(|state| state.identity.as_ref())
                .is_some();
            self.session = Some(self.start_session(recovering)?);
        }
        let session = self
            .session
            .as_ref()
            .expect("ACPX session exists after successful start");
        let identity = session.identity().clone();
        let process_id = session.process_id();
        let resumed = self
            .state
            .as_ref()
            .and_then(|state| state.identity.as_ref())
            .is_some();
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider has not been prepared"))?;
        state.identity = Some(identity.clone());
        state.active_turn_id = None;
        state.lifecycle = "session_open".to_owned();
        let payload = session_event_payload(&state.descriptor, &identity, process_id);
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({
                "status": if resumed { "resumed" } else { "started" },
                "provider": "acpx",
                "driver": "acpx_runtime",
                "providerVersion": "0.13.1",
                "providerSessionId": identity.acpx_record_id,
                "sessionId": identity.agent_session_id,
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
                payload,
            )],
        })
    }

    fn start_turn(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("turn.start payload.text is required"))?;
        if self.session.is_none() {
            return Err(DurableRunnerError::invalid("ACPX session is not open"));
        }
        let (provider_process_will_be_replaced, previous_process_id) = self
            .session
            .as_ref()
            .map(|session| (session.state().has_settled_turns(), session.process_id()))
            .expect("ACPX session exists after availability check");
        {
            let state = self
                .state
                .as_mut()
                .ok_or_else(|| DurableRunnerError::invalid("ACPX provider is not prepared"))?;
            if state.lifecycle != "session_open" {
                return Err(DurableRunnerError::invalid(
                    "ACPX provider cannot start a turn in its current lifecycle",
                ));
            }
            state.active_turn_id = Some(self.context.turn_id.clone());
            state.semantic_result = None;
            state.lifecycle = "turn_starting".to_owned();
        }
        self.save_state()?;
        let working_directory = self
            .state
            .as_ref()
            .map(|state| PathBuf::from(&state.descriptor.cwd))
            .expect("ACPX state exists before turn start");
        if let Err(error) = self
            .session
            .as_mut()
            .expect("ACPX session exists before turn start")
            .start_turn(&self.context.turn_id, text, &working_directory)
        {
            let state = self
                .state
                .as_mut()
                .expect("ACPX state remains available after failed turn start");
            state.lifecycle = "closed".to_owned();
            state.active_turn_id = None;
            self.session = None;
            self.save_state()?;
            return Err(DurableRunnerError::invalid(format!(
                "ACPX turn start failed closed: {error}"
            )));
        }
        let state = self
            .state
            .as_mut()
            .expect("ACPX state exists after turn start");
        state.lifecycle = "turn_active".to_owned();
        self.save_state()?;
        let mut events = Vec::with_capacity(if provider_process_will_be_replaced {
            2
        } else {
            1
        });
        if provider_process_will_be_replaced {
            let session = self
                .session
                .as_ref()
                .expect("ACPX replacement session exists after turn start");
            events.push((
                "session.reconciled".to_owned(),
                EventPriority::P0,
                replacement_continuity_payload(
                    session.identity(),
                    previous_process_id,
                    session.process_id(),
                    &self.context.turn_id,
                ),
            ));
        }
        events.push((
            "turn.started".to_owned(),
            EventPriority::P0,
            json!({
                "provider": "acpx",
                "providerTurnId": self.context.turn_id,
                "status": "inProgress",
                "turn": {"id": self.context.turn_id, "status": "inProgress"},
            }),
        ));
        Ok(CommandExecution {
            result: json!({"status": "accepted", "providerTurnId": self.context.turn_id}),
            events,
        })
    }

    fn interrupt_turn(&mut self, reason: &str) -> Result<CommandExecution, DurableRunnerError> {
        let turn_id = self
            .state
            .as_ref()
            .and_then(|state| state.active_turn_id.clone());
        let Some(turn_id) = turn_id else {
            return Ok(CommandExecution::result(json!({
                "status": "already_settled",
                "reason": reason,
            })));
        };
        self.session
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX session is unavailable"))?
            .interrupt_turn(&turn_id, reason)
            .map_err(|error| {
                DurableRunnerError::invalid(format!("ACPX turn interrupt failed: {error}"))
            })?;
        Ok(CommandExecution::result(json!({
            "status": "interrupt_requested",
            "providerTurnId": turn_id,
            "reason": reason,
        })))
    }

    fn resolve_request(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let request_id = payload
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires requestId"))?;
        let response = payload
            .get("response")
            .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires response"))?;
        let turn_id = self
            .state
            .as_ref()
            .and_then(|state| state.active_turn_id.clone())
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider has no active turn"))?;
        self.session
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX session is unavailable"))?
            .resolve_input(
                request_id,
                &turn_id,
                &json!({"action": "submit", "response": response}),
            )
            .map_err(|error| {
                DurableRunnerError::invalid(format!("ACPX runtime response failed: {error}"))
            })?;
        Ok(CommandExecution {
            result: json!({"status": "delivered", "requestId": request_id}),
            events: vec![(
                "runtime_request.resolved".to_owned(),
                EventPriority::P0,
                json!({"provider": "acpx", "requestId": request_id, "status": "delivered"}),
            )],
        })
    }

    fn deliver_tool_result(
        &mut self,
        payload: &Value,
    ) -> Result<CommandExecution, DurableRunnerError> {
        let result: ToolResult = serde_json::from_value(payload.clone()).map_err(|error| {
            DurableRunnerError::invalid(format!("semantic tool result is invalid: {error}"))
        })?;
        self.session
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX session is unavailable"))?
            .deliver_tool_result(&result)
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to return semantic tool result to ACPX: {error}"
                ))
            })?;
        Ok(CommandExecution::result(json!({
            "status": "delivered",
            "callId": result.call_id,
        })))
    }

    fn snapshot(&self) -> Result<CommandExecution, DurableRunnerError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider has not been prepared"))?;
        Ok(CommandExecution::result(json!({
            "status": state.lifecycle,
            "provider": "acpx",
            "driver": "acpx_runtime",
            "providerSessionId": state.identity.as_ref().map(|value| value.acpx_record_id.as_str()),
            "activeProviderTurnId": state.active_turn_id,
        })))
    }

    fn close_session(&mut self, reason: &str) -> Result<CommandExecution, DurableRunnerError> {
        if let Some(session) = self.session.as_mut() {
            session.shutdown(reason).map_err(|error| {
                DurableRunnerError::invalid(format!("failed to stop ACPX provider: {error}"))
            })?;
        }
        self.session = None;
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider is not prepared"))?;
        state.lifecycle = "closed".to_owned();
        state.active_turn_id = None;
        let provider_session_id = state
            .identity
            .as_ref()
            .map(|value| value.acpx_record_id.clone());
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({"status": "closed", "providerSessionId": provider_session_id}),
            events: vec![(
                "session.closed".to_owned(),
                EventPriority::P0,
                json!({"provider": "acpx", "providerSessionId": provider_session_id}),
            )],
        })
    }

    fn suspend(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        if let Some(session) = self.session.as_mut() {
            let identity = session.suspend("runner.suspend").map_err(|error| {
                DurableRunnerError::invalid(format!("failed to suspend ACPX provider: {error}"))
            })?;
            let state = self
                .state
                .as_mut()
                .expect("ACPX state exists while suspending provider");
            state.identity = Some(identity);
            state.lifecycle = "suspended".to_owned();
            state.active_turn_id = None;
            self.session = None;
            self.save_state()?;
        }
        Ok(CommandExecution::result(json!({"status": "completed"})))
    }

    fn poll_provider(&mut self) -> Result<(), DurableRunnerError> {
        self.restore()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| !state.pending_events.is_empty())
            || self.session.is_none()
        {
            return Ok(());
        }
        for _ in 0..MAX_EVENTS_PER_POLL {
            let events = self
                .session
                .as_mut()
                .expect("ACPX session remains available while polling")
                .poll_event(Duration::from_millis(1))
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("ACPX provider failed: {error}"))
                })?;
            let Some(events) = events else { break };
            for event in events {
                let normalized = project_acpx_state_event(&self.context, &event)
                    .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
                let terminal = normalized.iter().find_map(|event| {
                    matches!(
                        event.event_type.as_str(),
                        "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.interrupted"
                    )
                    .then(|| event.event_type.clone())
                });
                let state = self
                    .state
                    .as_mut()
                    .expect("ACPX state remains available while polling");
                for event in normalized {
                    if event.event_type == "run.result.proposed" {
                        state.semantic_result = Some(event.payload.clone());
                    }
                    state.push(event)?;
                }
                if let Some(event_type) = terminal {
                    state.active_turn_id = None;
                    state.lifecycle = "session_open".to_owned();
                    let status = match event_type.as_str() {
                        "turn.completed" => "succeeded",
                        "turn.cancelled" => "cancelled",
                        "turn.interrupted" => "interrupted",
                        _ => "failed",
                    };
                    let disposition = state
                        .semantic_result
                        .as_ref()
                        .and_then(|result| result.get("reportedWorkDisposition"))
                        .and_then(Value::as_str)
                        .unwrap_or(if status == "succeeded" {
                            "done"
                        } else {
                            "needs_review"
                        });
                    state.push(NormalizedProviderEvent {
                        event_type: "run.terminal".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({
                            "status": status,
                            "runTerminalState": status,
                            "reportedWorkDisposition": disposition,
                            "provider": "acpx",
                        }),
                    })?;
                }
            }
            self.save_state()?;
        }
        Ok(())
    }
}

impl CommandExecutor for AcpxCommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        self.restore()?;
        match command.command_type.as_str() {
            "run.prepare" => self.prepare(&command.payload),
            "run.attach" => {
                if self.state.is_none() && command.payload.get("provider").is_some() {
                    self.prepare(&command.payload)?;
                } else {
                    self.attach_run(&command.payload)?;
                }
                let mut execution = self.open_session()?;
                execution.events.push((
                    "run.attached".to_owned(),
                    EventPriority::P0,
                    json!({"provider": "acpx"}),
                ));
                Ok(execution)
            }
            "session.open" => self.open_session(),
            "turn.start" => self.start_turn(&command.payload),
            "turn.steer" => Ok(CommandExecution::result(json!({
                "status": "rejected",
                "code": "provider_command_unavailable",
                "message": "ACPX does not support steering an active turn",
            }))),
            "turn.interrupt" | "turn.stop" | "run.cancel" => {
                self.interrupt_turn(&command.command_type)
            }
            "request.resolve" => self.resolve_request(&command.payload),
            "semantic_tool.result" => self.deliver_tool_result(&command.payload),
            "session.snapshot" => self.snapshot(),
            "session.close" | "session.destroy" => self.close_session(&command.command_type),
            "runner.suspend" => self.suspend(),
            "runner.shutdown" => {
                if self.state.is_some() {
                    self.close_session("runner.shutdown")?;
                }
                Ok(CommandExecution::result(json!({"status": "completed"})))
            }
            "runner.drain" => Ok(CommandExecution::result(json!({"status": "completed"}))),
            _ => Ok(CommandExecution::result(json!({
                "status": "rejected",
                "code": "provider_command_unavailable",
                "message": "the ACPX provider does not implement this command",
            }))),
        }
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.poll_provider()?;
        Ok(self
            .state
            .as_ref()
            .into_iter()
            .flat_map(|state| state.pending_events.iter().take(MAX_EVENTS_PER_POLL))
            .cloned()
            .collect())
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        if count == 0 {
            return Ok(());
        }
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider state is unavailable"))?;
        if count > state.pending_events.len() {
            return Err(DurableRunnerError::invalid(
                "ACPX event acknowledgement exceeded the pending prefix",
            ));
        }
        state.pending_events.drain(..count);
        self.save_state()
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        if let Some(session) = self.session.as_mut() {
            session
                .shutdown("runner process shutdown")
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("failed to stop ACPX provider: {error}"))
                })?;
        }
        self.session = None;
        Ok(())
    }
}

fn authorized_tool_set(payload: &Value) -> Result<AuthorizedToolSet, DurableRunnerError> {
    if let Some(value) = payload.get("authorizedTools") {
        return serde_json::from_value(value.clone()).map_err(|error| {
            DurableRunnerError::invalid(format!("run.prepare authorizedTools is invalid: {error}"))
        });
    }
    let operations = Vec::new();
    let catalog_digest = authorized_tool_catalog_digest(&operations).map_err(|error| {
        DurableRunnerError::invalid(format!("empty authorized tool set is invalid: {error}"))
    })?;
    Ok(AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest,
        operations,
    })
}

fn session_event_payload(
    descriptor: &AcpxProviderDescriptor,
    identity: &AcpxProviderSessionIdentity,
    process_id: u32,
) -> Value {
    json!({
        "provider": "acpx",
        "driver": "acpx_runtime",
        "providerDescriptor": descriptor.public_descriptor(Some(identity)),
        "runtimeIdentity": {
            "executionKind": "local_process",
            "processId": process_id,
            "providerSessionId": identity.agent_session_id,
        },
        "providerIdentity": identity,
        "threadId": identity.acpx_record_id,
        "providerSessionId": identity.acpx_record_id,
        "sessionId": identity.agent_session_id,
        "providerAccountSessionId": identity.agent_session_id,
        "processId": process_id,
    })
}

fn replacement_continuity_payload(
    identity: &AcpxProviderSessionIdentity,
    previous_process_id: u32,
    process_id: u32,
    active_turn_id: &str,
) -> Value {
    json!({
        "provider": "acpx",
        "driver": "acpx_runtime",
        "providerSessionId": identity.acpx_record_id,
        "sessionId": identity.agent_session_id,
        "previousProcessId": previous_process_id,
        "processId": process_id,
        "previousProviderTurnId": Value::Null,
        "activeProviderTurnId": active_turn_id,
        "sameProviderSession": true,
        "continuityDisposition": "qualified_provider_process_replacement",
        "reason": "turn_authority_rotation",
    })
}

fn secure_directory(path: &Path, label: &str) -> Result<(), DurableRunnerError> {
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(DurableRunnerError::invalid(format!(
                "failed to create {label} directory: {error}"
            )))
        }
    }
    verify_private_directory(path).map_err(|error| {
        DurableRunnerError::invalid(format!("{label} directory is not private: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "paperclip-acpx-backend-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        directory
    }

    fn write_artifact(path: &Path, contents: &[u8], executable: bool) {
        fs::write(path, contents).unwrap();
        #[cfg(unix)]
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
        )
        .unwrap();
    }

    fn artifact(path: &Path) -> QualifiedLaunchArtifact {
        QualifiedLaunchArtifact {
            path: path.to_owned(),
            sha256: format!("sha256:{:x}", Sha256::digest(fs::read(path).unwrap())),
        }
    }

    fn test_config(
        state_dir: &Path,
        launch_profile: Option<AcpxLaunchProfile>,
    ) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1/runner".to_owned(),
            ca_bundle_path: None,
            state_dir: state_dir.to_owned(),
            runner_instance_id: "runner-1".to_owned(),
            environment_lease_id: "lease-1".to_owned(),
            run_id: "run-1".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            item_id: "item-1".to_owned(),
            runner_version: "0.0.0".to_owned(),
            runner_digest: "sha256:test".to_owned(),
            acpx_launch_profile: launch_profile,
            opencode_launch_profile: None,
            max_outbox_bytes: 1024 * 1024,
            p0_reserve_bytes: 64 * 1024,
            max_frame_bytes: 1024 * 1024,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::from_secs(60),
        }
    }

    fn context() -> AcpxEventProjectionContext {
        AcpxEventProjectionContext {
            run_id: "run-1".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            item_id: "item-1".to_owned(),
        }
    }

    fn descriptor(agent: &str) -> Value {
        let (model, package, version, digest) = if agent == "claude" {
            (
                "claude-sonnet-5",
                "@agentclientprotocol/claude-agent-acp",
                "0.70.0",
                "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
            )
        } else {
            (
                "gpt-5.6-sol",
                "@agentclientprotocol/codex-acp",
                "1.6.2",
                "sha256:94049b3e3c3aee87de62703786e4fa81d031d7bd979f99bdf516d84f28791a79",
            )
        };
        json!({
            "kind": "acpx",
            "provider": "acpx",
            "driver": "acpx_runtime",
            "providerVersion": "0.13.1",
            "agent": agent,
            "model": model,
            "acpxVersion": "0.13.1",
            "agentServerPackage": package,
            "agentServerVersion": version,
            "agentRuntimePackage": null,
            "agentRuntimeVersion": null,
            "commandDigest": digest,
            "sidecarCommand": "/qualified/node",
            "sidecarArgs": ["/qualified/acpx-sidecar.js"],
            "runtimeDirectory": "/runtime/acpx",
            "normalizedSessionId": "session-1",
            "runId": "run-1",
            "cwd": "/workspace",
            "instructions": "Do the work.",
            "permissionMode": "approve-reads",
            "permissionModePinned": true,
            "runtimeContext": null,
        })
    }

    #[test]
    fn admits_only_exact_qualified_claude_and_codex_descriptors() {
        for agent in ["claude", "codex"] {
            let descriptor: AcpxProviderDescriptor =
                serde_json::from_value(descriptor(agent)).unwrap();
            descriptor.validate(&context()).unwrap();
        }
        let mut drifted = descriptor("codex");
        drifted["commandDigest"] = json!(format!("sha256:{}", "a".repeat(64)));
        let drifted: AcpxProviderDescriptor = serde_json::from_value(drifted).unwrap();
        assert!(drifted.validate(&context()).is_err());
    }

    #[test]
    fn describes_process_replacement_as_same_session_continuity() {
        let identity = AcpxProviderSessionIdentity {
            kind: "acpx".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            acpx_record_id: "record-1".to_owned(),
            backend_session_id: "backend-1".to_owned(),
            agent_session_id: "agent-1".to_owned(),
            profile_digest: format!("sha256:{}", "1".repeat(64)),
            workspace_digest: format!("sha256:{}", "2".repeat(64)),
            requested_model: "gpt-5.6-sol".to_owned(),
            effective_model: "gpt-5.6-sol".to_owned(),
            permission_mode: Some(AcpxPermissionMode::ApproveReads),
        };

        let payload = replacement_continuity_payload(&identity, 41, 42, "turn-2");
        assert_eq!(payload["providerSessionId"], "record-1");
        assert_eq!(payload["sessionId"], "agent-1");
        assert_eq!(payload["previousProcessId"], 41);
        assert_eq!(payload["processId"], 42);
        assert_eq!(payload["activeProviderTurnId"], "turn-2");
        assert_eq!(payload["sameProviderSession"], true);
        assert_eq!(
            payload["continuityDisposition"],
            "qualified_provider_process_replacement"
        );
    }

    #[test]
    fn rejects_pi_before_process_launch() {
        let mut pi = descriptor("codex");
        pi["agent"] = json!("pi");
        let pi: AcpxProviderDescriptor = serde_json::from_value(pi).unwrap();
        assert!(pi.validate(&context()).is_err());
    }

    #[test]
    fn binds_sidecar_paths_arguments_and_contents_to_the_runner_profile() {
        let directory = temporary_directory("launch-binding");
        let command = directory.join("node");
        let sidecar = directory.join("sidecar.js");
        write_artifact(&command, b"qualified node", true);
        write_artifact(&sidecar, b"qualified sidecar", false);
        let args = vec![sidecar.to_string_lossy().into_owned()];
        let profile = AcpxLaunchProfile {
            authority_digest: format!("sha256:{}", "d".repeat(64)),
            command: command.clone(),
            args: args.clone(),
            artifacts: vec![artifact(&command), artifact(&sidecar)],
        };
        let mut value = descriptor("codex");
        value["sidecarCommand"] = json!(command);
        value["sidecarArgs"] = json!(args);
        let descriptor: AcpxProviderDescriptor = serde_json::from_value(value).unwrap();
        let transport = descriptor.verified_transport(Some(&profile)).unwrap();
        assert_eq!(transport.command, profile.command);
        assert_eq!(transport.args[0], sidecar.to_string_lossy());
        assert!(transport.verified_launch.is_some());

        let mut drifted_path = descriptor.clone();
        drifted_path.sidecar_command = directory.join("other-node");
        assert!(drifted_path.verified_transport(Some(&profile)).is_err());
        let mut drifted_args = descriptor.clone();
        drifted_args.sidecar_args.push("--untrusted".to_owned());
        assert!(drifted_args.verified_transport(Some(&profile)).is_err());

        write_artifact(&sidecar, b"modified sidecar", false);
        assert!(descriptor.verified_transport(Some(&profile)).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_launch_artifacts() {
        use std::os::unix::fs::symlink;

        let directory = temporary_directory("launch-symlink");
        let command = directory.join("node");
        let command_link = directory.join("node-link");
        write_artifact(&command, b"qualified node", true);
        symlink(&command, &command_link).unwrap();
        let profile = AcpxLaunchProfile {
            authority_digest: format!("sha256:{}", "d".repeat(64)),
            command: command_link.clone(),
            args: Vec::new(),
            artifacts: vec![QualifiedLaunchArtifact {
                path: command_link.clone(),
                sha256: artifact(&command).sha256,
            }],
        };
        let mut value = descriptor("codex");
        value["sidecarCommand"] = json!(command_link);
        value["sidecarArgs"] = json!([]);
        let descriptor: AcpxProviderDescriptor = serde_json::from_value(value).unwrap();
        assert!(descriptor.verified_transport(Some(&profile)).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn active_turn_recovery_closes_without_starting_the_provider() {
        let directory = temporary_directory("active-recovery");
        let runtime = directory.join("runtime");
        let workspace = directory.join("workspace");
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let marker = directory.join("provider-started");
        let command = directory.join("sidecar");
        write_artifact(
            &command,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()).as_bytes(),
            true,
        );
        let launch_profile = AcpxLaunchProfile {
            authority_digest: format!("sha256:{}", "d".repeat(64)),
            command: command.clone(),
            args: Vec::new(),
            artifacts: vec![artifact(&command)],
        };
        let mut value = descriptor("codex");
        value["sidecarCommand"] = json!(command);
        value["sidecarArgs"] = json!([]);
        value["runtimeDirectory"] = json!(runtime);
        value["cwd"] = json!(workspace);
        let descriptor: AcpxProviderDescriptor = serde_json::from_value(value).unwrap();
        let identity = AcpxProviderSessionIdentity {
            kind: "acpx".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            acpx_record_id: "record-1".to_owned(),
            backend_session_id: "backend-1".to_owned(),
            agent_session_id: "agent-1".to_owned(),
            profile_digest: descriptor.command_digest.clone(),
            workspace_digest: format!("sha256:{}", "a".repeat(64)),
            requested_model: descriptor.model.clone(),
            effective_model: descriptor.model.clone(),
            permission_mode: Some(descriptor.permission_mode),
        };
        let operations = Vec::new();
        let tool_set = AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        };
        let launch_profile_digest = launch_profile.canonical_digest().unwrap();
        let mut state = AcpxDurableState::new(descriptor, tool_set, launch_profile_digest);
        state.lifecycle = "turn_active".to_owned();
        state.identity = Some(identity);
        state.active_turn_id = Some("turn-1".to_owned());
        let config = test_config(&directory, Some(launch_profile));
        let mut original = AcpxCommandExecutor::with_runner_config(&directory, &config);
        original.state = Some(state);
        original.save_state().unwrap();
        drop(original);

        let mut drifted_config = config.clone();
        drifted_config
            .acpx_launch_profile
            .as_mut()
            .unwrap()
            .authority_digest = format!("sha256:{}", "e".repeat(64));
        let mut drifted = AcpxCommandExecutor::with_runner_config(&directory, &drifted_config);
        let drift_error = drifted
            .execute(&Command {
                schema: "paperclip.prp.command.v1".to_owned(),
                command_id: "command-drift".to_owned(),
                controller_seq: 1,
                command_type: "session.snapshot".to_owned(),
                issued_at: "2026-09-01T00:00:00.000Z".to_owned(),
                deadline_at: None,
                precondition: None,
                payload: json!({}),
            })
            .unwrap_err();
        assert!(drift_error
            .to_string()
            .contains("launch profile digest does not match runner startup"));
        let retry_error = drifted
            .execute(&Command {
                schema: "paperclip.prp.command.v1".to_owned(),
                command_id: "command-drift-retry".to_owned(),
                controller_seq: 2,
                command_type: "session.snapshot".to_owned(),
                issued_at: "2026-09-01T00:00:01.000Z".to_owned(),
                deadline_at: None,
                precondition: None,
                payload: json!({}),
            })
            .unwrap_err();
        assert!(retry_error
            .to_string()
            .contains("launch profile digest does not match runner startup"));
        assert!(!marker.exists());

        let mut recovered = AcpxCommandExecutor::with_runner_config(&directory, &config);
        let snapshot = recovered
            .execute(&Command {
                schema: "paperclip.prp.command.v1".to_owned(),
                command_id: "command-1".to_owned(),
                controller_seq: 1,
                command_type: "session.snapshot".to_owned(),
                issued_at: "2026-09-01T00:00:00.000Z".to_owned(),
                deadline_at: None,
                precondition: None,
                payload: json!({}),
            })
            .unwrap();
        assert_eq!(snapshot.result["status"], "closed");
        assert!(!marker.exists());
        let events = recovered.poll_events().unwrap();
        assert_eq!(events[0].event_type, "turn.failed");
        assert_eq!(events[1].event_type, "run.terminal");
        fs::remove_dir_all(directory).unwrap();
    }
}
