use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::{self, DirBuilder, File};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderRuntimePolicy, AcpxProviderSession, AcpxProviderSessionConfig,
    AcpxProviderSessionIdentity, AcpxTurnControlCapabilities, CursorMode,
};
use crate::acpx_sidecar_transport::AcpxSidecarTransportConfig;
#[cfg(test)]
use crate::durable::QualifiedLaunchArtifact;
use crate::durable::{
    create_private_temporary_file, open_private_regular_file, verify_private_directory,
    AcpxLaunchProfile, Command, CommandExecution, CommandExecutor, DurableRunnerConfig,
    DurableRunnerError, EventPriority, PolledEvent,
};
use crate::generated_acpx_sidecar_contract::GeneratedAcpxSidecarCommand;
use crate::process_supervisor::{VerifiedProcessArgument, VerifiedProcessLaunch};
use crate::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedToolSet, ToolResult, TOOL_SET_SCHEMA,
};
use crate::provider_events::{
    project_acpx_state_event, AcpxEventProjectionContext, NormalizedProviderEvent,
};
use crate::qualified_launch::verify_launch_artifact;

fn is_reserved_terminal_operation_id(operation_id: &str) -> bool {
    matches!(operation_id, "paperclip_finish" | "paperclip_block")
}
use crate::stable_identity::{is_stable_id, DURABLE_STABLE_ID_CHARS};

pub const ACPX_PROVIDER_STATE_FILE: &str = "acpx-provider-state.json";
const ACPX_PROVIDER_STATE_SCHEMA: &str = "paperclip.runner.acpx-provider-state.v3";
const MAX_PROVIDER_STATE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PENDING_EVENTS: usize = 8_320;
const MAX_EVENTS_PER_POLL: usize = 128;
const PROVIDER_LIFETIME_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(5);
const PROVIDER_LIFETIME_CONFIRMATION_RETRY: Duration = Duration::from_millis(10);

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

fn try_acquire_provider_lifetime_fence(
    candidates: [u16; 3],
) -> Result<Option<Vec<TcpListener>>, DurableRunnerError> {
    let mut listeners = Vec::with_capacity(2);
    for port in candidates {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                listeners.push(listener);
                if listeners.len() == 2 {
                    return Ok(Some(listeners));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
            Err(error) => {
                return Err(DurableRunnerError::invalid(format!(
                    "failed to prove ACPX provider lifetime cleanup: {error}"
                )))
            }
        }
    }
    Ok(None)
}

fn acquire_provider_lifetime_fence(
    candidates: [u16; 3],
) -> Result<Vec<TcpListener>, DurableRunnerError> {
    try_acquire_provider_lifetime_fence(candidates)?.ok_or_else(|| {
        DurableRunnerError::invalid(
            "ACPX original provider lifetime remains active; cleanup is not yet proven",
        )
    })
}

fn await_provider_lifetime_fence(
    candidates: [u16; 3],
) -> Result<Vec<TcpListener>, DurableRunnerError> {
    let deadline = Instant::now() + PROVIDER_LIFETIME_CONFIRMATION_TIMEOUT;
    loop {
        if let Some(listeners) = try_acquire_provider_lifetime_fence(candidates)? {
            return Ok(listeners);
        }
        if Instant::now() >= deadline {
            return Err(DurableRunnerError::invalid(
                "ACPX original provider lifetime remains active after suspension; provider exit is not confirmed",
            ));
        }
        std::thread::sleep(PROVIDER_LIFETIME_CONFIRMATION_RETRY);
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cursor_mode: Option<CursorMode>,
    permission_mode_pinned: bool,
    #[serde(default)]
    provider_policy: Option<AcpxProviderRuntimePolicy>,
    #[serde(default)]
    runtime_context: Value,
}

// Only controller-authenticated run grants move between provider lifetimes.
// Keep prompt, bundle/skill identities, assignment policy, and unknown fields
// in this comparison; a new filesystem copy is not a new provider profile.
fn runtime_context_session_identity(context: &Value) -> Option<Value> {
    let mut identity = context.clone();
    for pointer in [
        "/instructions/bundle/rootPath",
        "/instructions/workingCopy/rootPath",
    ] {
        if let Some(value) = identity.pointer_mut(pointer) {
            if !value.as_str().is_some_and(|path| !path.is_empty()) {
                return None;
            }
            *value = Value::Null;
        }
    }
    if let Some(skills) = identity.get_mut("skills").and_then(Value::as_array_mut) {
        for skill in skills {
            if let Some(value) = skill.pointer_mut("/bundle/rootPath") {
                if !value.as_str().is_some_and(|path| !path.is_empty()) {
                    return None;
                }
                *value = Value::Null;
            }
        }
    }
    if let Some(value) = identity.pointer_mut("/mcp/bindingId") {
        if !value.is_null() && !value.as_str().is_some_and(|binding| !binding.is_empty()) {
            return None;
        }
        *value = Value::Null;
    }
    Some(identity)
}

impl AcpxProviderDescriptor {
    fn validate_session(
        &self,
        context: &AcpxEventProjectionContext,
    ) -> Result<(), DurableRunnerError> {
        let expected = match self.agent.as_str() {
            "claude" => (
                "claude-sonnet-5",
                "@agentclientprotocol/claude-agent-acp",
                "0.73.0",
                Some("@anthropic-ai/claude-agent-sdk"),
                Some("0.3.280"),
                "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
            ),
            "codex" => (
                "gpt-5.6-sol",
                "@agentclientprotocol/codex-acp",
                "1.6.2",
                Some("@openai/codex"),
                Some("0.156.0"),
                "sha256:c4538599d1ab767db5dff50934f13bb5ba313a59d9c4a83e993fac4617ea63d3",
            ),
            "pi" => (
                "openrouter/deepseek/deepseek-v4-flash-0731",
                "pi-acp",
                "0.0.33",
                Some("@earendil-works/pi-coding-agent"),
                Some("0.84.2"),
                "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f",
            ),
            "cursor" => (
                self.model.as_str(),
                "cursor-agent",
                "2026.09.26-dd393fe",
                None,
                None,
                "sha256:2feb50c7b0a317dff454c00115a5bbe4d5c757189691586577be9c80234d477e",
            ),
            "copilot" => (
                self.model.as_str(),
                "@github/copilot",
                "1.0.88",
                None,
                None,
                "sha256:b18c01603dd0169d233140709cfaa8bf5304a03cf5de78ca4f625f30013e8457",
            ),
            "grok" => (
                "grok-4.7",
                "builtin:grok-acp",
                "1",
                Some("native:grok"),
                Some("1.0.13"),
                "sha256:f0b698395a3704ed2ffaf84ea19bdb20c36c8a0a70b7c629c7b6ffe144e59e55",
            ),
            _ => {
                return Err(DurableRunnerError::invalid(
                    "ACPX agent must name a known immutable profile",
                ))
            }
        };
        if self.kind != "acpx"
            || self.provider != "acpx"
            || self.driver != "acpx_runtime"
            || self.provider_version != "0.13.1"
            || self.acpx_version != "0.13.1"
            || (self.agent != "claude" && self.agent != "grok" && self.model != expected.0)
            || self.model.trim().is_empty()
            || self.model.len() > 240
            || self.model.contains('\0')
            || ((self.agent == "cursor") != self.cursor_mode.is_some())
            || (matches!(self.agent.as_str(), "pi" | "cursor" | "copilot")
                && self.provider_policy.is_none())
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
        if self.normalized_session_id != context.normalized_session_id {
            return Err(DurableRunnerError::invalid(
                "ACPX descriptor identity conflicts with the durable runner identity",
            ));
        }
        if self.run_id.is_empty()
            || self.run_id.len() > 160
            || !self.run_id.bytes().all(|value| {
                value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(DurableRunnerError::invalid(
                "ACPX descriptor run identity is malformed",
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

    fn validate(&self, context: &AcpxEventProjectionContext) -> Result<(), DurableRunnerError> {
        self.validate_session(context)?;
        if self.run_id != context.run_id {
            return Err(DurableRunnerError::invalid(
                "ACPX descriptor identity conflicts with the durable runner identity",
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
        // Keep the controller's full authority catalog durable so terminal
        // semantic results can be correlated through the reserved bridge.
        // The ACPX provider session receives only dynamic operations: its
        // reserved finish/block contract is runner-owned and validated by
        // AcpxProviderSession itself.
        let provider_operations = tool_set
            .operations
            .into_iter()
            .filter(|tool| !is_reserved_terminal_operation_id(&tool.operation_id))
            .collect::<Vec<_>>();
        let provider_tool_set = AuthorizedToolSet {
            schema: tool_set.schema.clone(),
            schema_version: tool_set.schema_version,
            catalog_digest: authorized_tool_catalog_digest(&provider_operations).map_err(
                |error| {
                    DurableRunnerError::invalid(format!(
                        "ACPX provider tool catalog is invalid: {error}"
                    ))
                },
            )?,
            operations: provider_operations,
        };
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
            cursor_mode: self.cursor_mode,
            permission_mode_pinned: self.permission_mode_pinned,
            provider_policy: self.provider_policy.clone(),
            system_instructions: self.instructions.clone(),
            runtime_context: self.runtime_context.clone(),
            tool_set: provider_tool_set,
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
            .enumerate()
            .map(|(index, argument)| {
                let path = Path::new(argument);
                if !path.is_absolute() {
                    return Ok(VerifiedProcessArgument::Literal(argument.clone()));
                }
                verified
                    .get(path)
                    .cloned()
                    .map(|artifact| {
                        if index == 0 {
                            VerifiedProcessArgument::CommonJsArtifact(artifact)
                        } else {
                            VerifiedProcessArgument::Artifact(artifact)
                        }
                    })
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
            verified_launch: Some(
                VerifiedProcessLaunch::new(command, verified_args)
                    .with_inherited_runtime_executable(),
            ),
            request_timeout: Duration::from_secs(30),
            shutdown_grace: Duration::from_secs(2),
        })
    }

    fn public_descriptor(&self, identity: Option<&AcpxProviderSessionIdentity>) -> Value {
        let mut descriptor = json!({
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
        });
        if let Some(mode) = self.cursor_mode {
            descriptor["cursorMode"] = json!(mode);
        }
        descriptor
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
    attempted_turn_controls: HashSet<String>,
    #[serde(default)]
    provider_exit_unconfirmed: bool,
    #[serde(default)]
    semantic_result: Option<Value>,
    #[serde(default)]
    goal_projection: Value,
    #[serde(default)]
    turn_controls: AcpxTurnControlCapabilities,
    #[serde(default)]
    goal_revision: u64,
    #[serde(default)]
    goal_source_revision: Option<u64>,
    #[serde(default)]
    pending_events: VecDeque<PolledEvent>,
    #[serde(default)]
    pending_runtime_requests: BTreeMap<String, Value>,
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
            attempted_turn_controls: HashSet::new(),
            provider_exit_unconfirmed: false,
            semantic_result: None,
            goal_projection: Value::Null,
            turn_controls: AcpxTurnControlCapabilities::default(),
            goal_revision: 0,
            goal_source_revision: None,
            pending_events: VecDeque::new(),
            pending_runtime_requests: BTreeMap::new(),
            next_event_sequence: initial_event_sequence(),
        }
    }

    fn validate(
        &self,
        context: &AcpxEventProjectionContext,
        expected_launch_profile_digest: &str,
    ) -> Result<(), DurableRunnerError> {
        // The normalized session is the durable provider boundary. A settled
        // provider can outlive one heartbeat run and be attached to the next,
        // so its persisted descriptor legitimately carries the prior run ID
        // until run.attach rotates authority. Fresh command descriptors still
        // use validate(), which binds them to the current run.
        self.descriptor.validate_session(context)?;
        if self.launch_profile_digest != expected_launch_profile_digest {
            return Err(DurableRunnerError::invalid(
                "ACPX durable launch profile digest does not match runner startup",
            ));
        }
        validate_pending_runtime_requests(&self.pending_runtime_requests)?;
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
            || self.attempted_turn_controls.len() > 1024
            || self
                .attempted_turn_controls
                .iter()
                .any(|id| !is_stable_id(id, 160))
            || (!self.pending_runtime_requests.is_empty() && self.active_turn_id.is_none())
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
            || (self.provider_exit_unconfirmed
                && (!matches!(self.lifecycle.as_str(), "prepared" | "closed")
                    || self.identity.is_none()))
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
            if identity.profile_digest != self.descriptor.command_digest
                || identity.cursor_mode != self.descriptor.cursor_mode
            {
                return Err(DurableRunnerError::invalid(
                    "ACPX durable identity no longer matches its qualified profile or Cursor mode",
                ));
            }
        }
        Ok(())
    }

    fn expire_runtime_requests(
        &mut self,
        reason: &str,
        cancelled: bool,
    ) -> Result<(), DurableRunnerError> {
        for request in self
            .pending_runtime_requests
            .values()
            .cloned()
            .collect::<Vec<_>>()
        {
            let input = request.get("type").and_then(Value::as_str) == Some("input");
            let mut payload = json!({
                "provider":"acpx", "requestId":request["requestId"],
                "requestKind":request["requestKind"], "requestType":request["type"],
                "turnId":request["turnId"], "itemId":request["itemId"],
                "reason":reason, "replayAllowed":false, "adapter":"acpx-runtime-sidecar",
            });
            if input {
                payload["request"] = request;
            }
            self.push(NormalizedProviderEvent {
                event_type: if cancelled {
                    "runtime_request.cancelled"
                } else {
                    "runtime_request.expired"
                }
                .to_owned(),
                priority: EventPriority::P0,
                payload,
            })?;
        }
        Ok(())
    }

    fn push(&mut self, event: NormalizedProviderEvent) -> Result<(), DurableRunnerError> {
        if self.pending_events.len() >= MAX_PENDING_EVENTS {
            return Err(DurableRunnerError::invalid(
                "ACPX provider event backlog exceeds its durable limit",
            ));
        }
        // Check every fallible admission condition before changing the request
        // ledger. A rejected settlement must leave its pending request intact.
        let sequence = self.next_event_sequence;
        let next_sequence = sequence
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("ACPX event sequence exhausted"))?;
        if event.event_type == "runtime_request.created" {
            let request = event.payload.get("request").cloned().ok_or_else(|| {
                DurableRunnerError::invalid("ACPX runtime request omitted its payload")
            })?;
            let request_id = request
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DurableRunnerError::invalid("ACPX runtime request omitted its identity")
                })?
                .to_owned();
            let mut next = self.pending_runtime_requests.clone();
            if next.insert(request_id, request).is_some() {
                return Err(DurableRunnerError::invalid(
                    "ACPX runtime request reused a pending durable identity",
                ));
            }
            validate_pending_runtime_requests(&next)?;
            self.pending_runtime_requests = next;
        } else if matches!(
            event.event_type.as_str(),
            "runtime_request.resolved" | "runtime_request.expired" | "runtime_request.cancelled"
        ) {
            if let Some(id) = event.payload.get("requestId").and_then(Value::as_str) {
                self.pending_runtime_requests.remove(id);
            }
        }
        self.next_event_sequence = next_sequence;
        self.pending_events.push_back(PolledEvent {
            executor_event_id: event_id(sequence),
            event_type: event.event_type,
            priority: event.priority,
            payload: event.payload,
        });
        Ok(())
    }
}

fn validate_pending_runtime_requests(
    requests: &BTreeMap<String, Value>,
) -> Result<(), DurableRunnerError> {
    if requests.len() > 1024
        || serde_json::to_vec(requests).map_or(true, |bytes| bytes.len() > 8 * 1024 * 1024)
    {
        return Err(DurableRunnerError::invalid(
            "ACPX durable runtime request ledger exceeds its bound",
        ));
    }
    for (id, request) in requests {
        let input = request.get("type").and_then(Value::as_str) == Some("input");
        if !is_stable_id(id, 160)
            || request.get("requestId").and_then(Value::as_str) != Some(id)
            || request.get("schema").and_then(Value::as_str) != Some("paperclip.runtime_request.v2")
            || request.get("status").and_then(Value::as_str) != Some("pending")
            || request.get("requestKind").and_then(Value::as_str)
                != Some(if input {
                    "runtime"
                } else {
                    "permission_approval"
                })
            || (!input && request.get("type").and_then(Value::as_str) != Some("permission"))
            || ["turnId", "itemId"].iter().any(|field| {
                request
                    .get(field)
                    .and_then(Value::as_str)
                    .is_none_or(|value| !is_stable_id(value, DURABLE_STABLE_ID_CHARS))
            })
            || (input
                && request.pointer("/input/schema").and_then(Value::as_str)
                    != Some("paperclip.question_set.v1"))
            || (!input && request.get("input").is_some())
            || serde_json::to_vec(request).map_or(true, |bytes| bytes.len() > 256 * 1024)
        {
            return Err(DurableRunnerError::invalid(
                "ACPX durable runtime request ledger has an invalid identity or type",
            ));
        }
        if input {
            crate::acpx_event_payload::validate_question_set(&request["input"])
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        }
    }
    Ok(())
}

pub struct AcpxCommandExecutor {
    state_dir: PathBuf,
    context: AcpxEventProjectionContext,
    state: Option<AcpxDurableState>,
    session: Option<AcpxProviderSession>,
    restore_checked: bool,
    restore_error: Option<DurableRunnerError>,
    persistence_error: Option<DurableRunnerError>,
    #[cfg(test)]
    fail_after_state_rename: bool,
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
                provider_turn_id: None,
                item_id: config.item_id.clone(),
            },
            state: None,
            session: None,
            restore_checked: false,
            restore_error: None,
            persistence_error: None,
            #[cfg(test)]
            fail_after_state_rename: false,
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
        self.ensure_persistence_healthy()?;
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
        // A replacement runner for a new heartbeat run must first execute
        // run.attach. Do not restart the provider under the prior run authority
        // or emit prior-run events into the new run while attachment is pending.
        if state.descriptor.run_id != self.context.run_id {
            return Ok(());
        }
        if !matches!(
            state.lifecycle.as_str(),
            "session_open" | "turn_starting" | "turn_active" | "suspended"
        ) {
            return Ok(());
        }
        let unsafe_active = matches!(state.lifecycle.as_str(), "turn_starting" | "turn_active");
        let previous_turn = state.active_turn_id.clone();
        if unsafe_active {
            self.context.provider_turn_id = None;
            let state = self
                .state
                .as_mut()
                .expect("ACPX state remains available during recovery");
            state.expire_runtime_requests("provider_process_lost", false)?;
            state.lifecycle = "closed".to_owned();
            state.active_turn_id = None;
            state.provider_exit_unconfirmed = true;
            state.push(NormalizedProviderEvent {
                event_type: "turn.failed".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": "acpx",
                    "providerTurnId": previous_turn,
                    "status": "failed",
                    "providerTerminalObserved": false,
                    "code": "acpx_active_turn_recovery_closed",
                    "providerShutdownFailed": true,
                }),
            })?;
            state.push(NormalizedProviderEvent {
                event_type: "run.terminal".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "schema": "paperclip.prp.terminal.v1",
                    "status": "failed",
                    "turnTerminalState": "failed",
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
        let turn_controls = session.turn_control_capabilities();
        let state = self
            .state
            .as_mut()
            .expect("ACPX state remains available during recovery");
        state.lifecycle = "session_open".to_owned();
        state.turn_controls = turn_controls;
        state.push(NormalizedProviderEvent {
            event_type: "session.resumed".to_owned(),
            priority: EventPriority::P0,
            payload: session_event_payload(&state.descriptor, &identity, process_id, turn_controls),
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

    fn ensure_persistence_healthy(&self) -> Result<(), DurableRunnerError> {
        match self.persistence_error.as_ref() {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    fn record_state_write(
        &mut self,
        result: Result<(), DurableRunnerError>,
    ) -> Result<(), DurableRunnerError> {
        if let Err(error) = result.as_ref() {
            // A rename may have succeeded before directory fsync or protection
            // failed. Neither rolling back nor continuing from memory can prove
            // which state survived. Stop publication and mutations until a fresh
            // executor reloads the complete atomic snapshot; never resend input.
            self.persistence_error = Some(error.clone());
        }
        result
    }

    fn save_state(&mut self) -> Result<(), DurableRunnerError> {
        self.ensure_persistence_healthy()?;
        let result = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider state is unavailable"))
            .and_then(|state| self.write_state(state));
        self.record_state_write(result)
    }

    fn commit_staged_state(&mut self, state: AcpxDurableState) -> Result<(), DurableRunnerError> {
        self.ensure_persistence_healthy()?;
        let result = self.write_state(&state);
        self.record_state_write(result)?;
        self.state = Some(state);
        Ok(())
    }

    fn write_state(&self, state: &AcpxDurableState) -> Result<(), DurableRunnerError> {
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
            #[cfg(test)]
            if self.fail_after_state_rename {
                return Err(std::io::Error::other("injected post-rename sync failure"));
            }
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
        let mut attachment_context = self.context.clone();
        if let Some(boundary) = payload.get("paperclipNextAuthority") {
            // The durable runner validates this authority's immutable bindings
            // and PRP v2 handoff capability before dispatching run.attach. Its
            // activation follows our command result, so self.context must keep
            // correlating audit events with the old run until rotate_authority.
            let identity = boundary.get("identity").ok_or_else(|| {
                DurableRunnerError::invalid("run.attach authority identity is required")
            })?;
            let run_id = identity
                .get("runId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DurableRunnerError::invalid("run.attach authority runId is required")
                })?;
            if run_id == self.context.run_id
                || identity.get("normalizedSessionId").and_then(Value::as_str)
                    != Some(self.context.normalized_session_id.as_str())
            {
                return Err(DurableRunnerError::invalid(
                    "run.attach authority changed an immutable session binding",
                ));
            }
            attachment_context.run_id = run_id.to_owned();
        }
        descriptor.validate(&attachment_context)?;
        let tool_set = authorized_tool_set(payload)?;
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider has not been prepared"))?;
        let mut durable_descriptor = descriptor.clone();
        durable_descriptor.run_id = state.descriptor.run_id.clone();
        // session/load reconnects MCP using this attachment's bindings. All
        // other context remains part of the immutable provider profile.
        let mut previous_descriptor = state.descriptor.clone();
        for context in [
            &mut durable_descriptor.runtime_context,
            &mut previous_descriptor.runtime_context,
        ] {
            if let Some(object) = context.as_object_mut() {
                object.remove("mcp");
                object.remove("aggregateDigest");
            }
        }
        if descriptor.agent == "cursor" {
            // New runs rotate authenticated instruction text and registered
            // file-copy grants. Preserve mainline MCP refresh while comparing
            // every remaining context identity, including unknown policy fields.
            let compatible = runtime_context_session_identity(&durable_descriptor.runtime_context)
                .zip(runtime_context_session_identity(
                    &previous_descriptor.runtime_context,
                ))
                .is_some_and(|(current, prior)| current == prior);
            let grants_changed = descriptor.instructions != state.descriptor.instructions
                || descriptor.runtime_context != state.descriptor.runtime_context;
            if !compatible || (grants_changed && descriptor.run_id == state.descriptor.run_id) {
                return Err(DurableRunnerError::invalid(
                    "Cursor run.attach changed runtime context outside a new authenticated run",
                ));
            }
            durable_descriptor.instructions = previous_descriptor.instructions.clone();
            durable_descriptor.runtime_context = previous_descriptor.runtime_context.clone();
        }
        let only_recovery_notice_pending = state
            .pending_events
            .iter()
            .all(|event| event.event_type == "session.resumed");
        if state.lifecycle == "closed"
            || state.provider_exit_unconfirmed
            || state.identity.is_none()
            || state.active_turn_id.is_some()
            || !only_recovery_notice_pending
            || durable_descriptor != previous_descriptor
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
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.provider_exit_unconfirmed)
        {
            return Err(DurableRunnerError::invalid(
                "ACPX provider lifetime cleanup is not yet proven",
            ));
        }
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
        let turn_controls = session.turn_control_capabilities();
        let resumed = self
            .state
            .as_ref()
            .and_then(|state| state.identity.as_ref())
            .is_some();
        self.context.provider_turn_id = None;
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider has not been prepared"))?;
        state.identity = Some(identity.clone());
        state.active_turn_id = None;
        state.lifecycle = "session_open".to_owned();
        state.turn_controls = turn_controls;
        let payload =
            session_event_payload(&state.descriptor, &identity, process_id, turn_controls);
        let goal = self.goal_control("session.goal.get", &json!({}))?;
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
            events: [(
                if resumed {
                    "session.resumed"
                } else {
                    "session.started"
                }
                .to_owned(),
                EventPriority::P0,
                payload,
            )]
            .into_iter()
            .chain(goal.events)
            .collect(),
        })
    }

    fn goal_control(
        &mut self,
        command: &str,
        payload: &Value,
    ) -> Result<CommandExecution, DurableRunnerError> {
        let sidecar_command = match command {
            "session.goal.get" => GeneratedAcpxSidecarCommand::SessionGoalGet,
            "session.goal.set" => GeneratedAcpxSidecarCommand::SessionGoalSet,
            "session.goal.clear" => GeneratedAcpxSidecarCommand::SessionGoalClear,
            _ => return Err(DurableRunnerError::invalid("unknown ACPX goal control")),
        };
        if command != "session.goal.get" {
            let action = if command == "session.goal.clear" {
                "clear"
            } else if payload.get("objective").is_some() {
                "set"
            } else if payload.get("status").and_then(Value::as_str) == Some("paused") {
                "pause"
            } else {
                "resume"
            };
            let available = self.state.as_ref().is_some_and(|state| {
                state
                    .goal_projection
                    .pointer("/sessionGoals/availability")
                    .and_then(Value::as_str)
                    == Some("available")
                    && state
                        .goal_projection
                        .pointer("/sessionGoals/actions")
                        .and_then(Value::as_array)
                        .is_some_and(|actions| {
                            actions.iter().any(|value| value.as_str() == Some(action))
                        })
            });
            if !available {
                return Ok(CommandExecution::result(
                    json!({"status":"rejected", "code":"session_goal_action_unavailable", "message":"The negotiated ACP extension does not support this goal action"}),
                ));
            }
        }
        let mut projection = self
            .session
            .as_mut()
            .ok_or_else(|| {
                DurableRunnerError::invalid("ACPX goal control requires an open session")
            })?
            .goal_control(sidecar_command, payload.clone())
            .map_err(|error| {
                DurableRunnerError::invalid(format!("ACPX goal control failed: {error}"))
            })?;
        if projection.get("schema").and_then(Value::as_str)
            != Some("paperclip.session_goal.snapshot.v1")
        {
            return Err(DurableRunnerError::invalid(
                "ACPX returned an invalid goal snapshot",
            ));
        }
        let state = self
            .state
            .as_mut()
            .expect("open ACPX session has durable state");
        state.goal_revision += 1;
        state.goal_source_revision = projection.get("providerRevision").and_then(Value::as_u64);
        projection["revision"] = json!(state.goal_revision);
        if let Some(request_id) = payload.get("requestId") {
            projection["requestId"] = request_id.clone();
        }
        state.goal_projection = projection.clone();
        let turn_controls = state.turn_controls;
        self.save_state()?;
        let event_type = match command {
            "session.goal.clear" => "session.goal.cleared",
            "session.goal.set" => "session.goal.updated",
            _ => "session.goal.snapshot",
        };
        Ok(CommandExecution {
            result: projection.clone(),
            events: vec![
                (
                    "session.capabilities.updated".to_owned(),
                    EventPriority::P0,
                    json!({"sessionGoals":projection["sessionGoals"], "turnControls":turn_controls}),
                ),
                (event_type.to_owned(), EventPriority::P0, projection),
            ],
        })
    }

    fn start_turn(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("turn.start payload.text is required"))?;
        let requested_provider_turn_id = payload
            .get("turnId")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("turn.start payload.turnId is required"))?;
        let provider_turn_id = requested_provider_turn_id.to_owned();
        if !is_stable_id(&provider_turn_id, DURABLE_STABLE_ID_CHARS) {
            return Err(DurableRunnerError::invalid(
                "turn.start payload.turnId is invalid",
            ));
        }
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
            state.active_turn_id = Some(provider_turn_id.clone());
            state.attempted_turn_controls.clear();
            state.semantic_result = None;
            state.lifecycle = "turn_starting".to_owned();
        }
        // ACPX provider events are scoped to the requested provider turn while
        // semantic events remain correlated to the immutable durable PRP turn.
        self.context.provider_turn_id = Some(provider_turn_id.clone());
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
            .start_turn(&provider_turn_id, text, &working_directory)
        {
            let state = self
                .state
                .as_mut()
                .expect("ACPX state remains available after failed turn start");
            state.lifecycle = "closed".to_owned();
            state.active_turn_id = None;
            self.context.provider_turn_id = None;
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
        let previous_turn_controls = state.turn_controls;
        state.turn_controls = self
            .session
            .as_ref()
            .expect("live ACPX session")
            .turn_control_capabilities();
        // session.open already published these capabilities. Preserve legacy
        // turn ordering when nothing changed, while exposing lazy discovery
        // and capability loss after a provider process replacement.
        let capabilities = (state.turn_controls != previous_turn_controls).then(|| {
            json!({"sessionGoals": state.goal_projection["sessionGoals"], "turnControls":state.turn_controls})
        });
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
                    &provider_turn_id,
                ),
            ));
        }
        if let Some(capabilities) = capabilities {
            events.push((
                "session.capabilities.updated".to_owned(),
                EventPriority::P0,
                capabilities,
            ));
        }
        events.push((
            "turn.started".to_owned(),
            EventPriority::P0,
            json!({
                "provider": "acpx",
                "providerTurnId": provider_turn_id.clone(),
                "status": "inProgress",
                "turn": {"id": provider_turn_id.clone(), "status": "inProgress"},
            }),
        ));
        Ok(CommandExecution {
            result: json!({"status": "accepted", "providerTurnId": provider_turn_id}),
            events,
        })
    }

    fn steer_turn(
        &mut self,
        command_id: &str,
        payload: &Value,
    ) -> Result<CommandExecution, DurableRunnerError> {
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("turn.steer payload.text is required"))?;
        let turn_id = payload
            .get("turnId")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("turn.steer payload.turnId is required"))?;
        let mode = match payload.get("mode") {
            None => "steer",
            Some(Value::String(mode)) => mode.as_str(),
            _ => {
                return Err(DurableRunnerError::invalid(
                    "turn.steer payload.mode must be a string",
                ))
            }
        };
        if !matches!(mode, "steer" | "follow_up")
            || text.trim().is_empty()
            || text.len() > 65_536
            || text.contains('\0')
        {
            return Err(DurableRunnerError::invalid(
                "turn.steer violates its bounded contract",
            ));
        }
        let control_id = match payload.get("correlationId") {
            Some(Value::String(id)) if is_stable_id(id, 160) => id.clone(),
            None => format!("control-{:x}", Sha256::digest(command_id.as_bytes())),
            _ => {
                return Err(DurableRunnerError::invalid(
                    "turn.steer correlationId is invalid",
                ))
            }
        };
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider is not prepared"))?;
        if state.lifecycle != "turn_active"
            || state.active_turn_id.as_deref() != Some(turn_id)
            || self.session.is_none()
        {
            return Err(DurableRunnerError::invalid(
                "turn.steer named a stale or inactive turn",
            ));
        }
        if state.attempted_turn_controls.contains(&control_id)
            || state.attempted_turn_controls.len() >= 1024
        {
            return Err(DurableRunnerError::invalid(
                "turn.steer is duplicate or exceeds the turn control limit",
            ));
        }
        state.attempted_turn_controls.insert(control_id.clone());
        // Retain before the potentially mutating RPC. Controller reconnects may
        // read its acknowledgement but must not replay an ambiguous attempt.
        self.save_state()?;
        self.session
            .as_mut()
            .expect("checked live session")
            .steer_turn(turn_id, &control_id, mode, text)
            .map_err(|error| {
                DurableRunnerError::invalid(format!("ACPX turn control failed: {error}"))
            })?;
        Ok(CommandExecution {
            result: json!({"status": "accepted", "mode": mode, "providerTurnId": turn_id, "correlationId": control_id}),
            events: vec![(
                "item.completed".to_owned(),
                EventPriority::P0,
                json!({
                    "provider": "acpx", "providerTurnId": turn_id,
                    "itemId": format!("acpx-control-{:x}", Sha256::digest(format!("{turn_id}:{control_id}").as_bytes())),
                    "kind": "steering_acknowledgement", "mode": mode, "status": "acknowledged",
                    "text": if mode == "steer" { "Steering acknowledged for the active turn." } else { "Follow-up queued after the active work." },
                }),
            )],
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

    fn stop_turn_for_suspension(
        &mut self,
        reason: &str,
    ) -> Result<CommandExecution, DurableRunnerError> {
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
        let provider_lifetime_fence_candidates = {
            let session = self
                .session
                .as_mut()
                .ok_or_else(|| DurableRunnerError::invalid("ACPX session is unavailable"))?;
            let candidates = session.identity().provider_lifetime_fence_candidates;
            session
                .terminate_active_turn_for_suspension(&turn_id)
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to terminate ACPX turn at the suspension boundary: {error}"
                    ))
                })?;
            candidates
        };
        // Process-group termination reaps the sidecar leader and its ordinary
        // descendants, but an escaped provider or guardian can outlive that
        // group. Require the inherited listener quorum before making this
        // durable session attachable, and retain it through the state write.
        self.session = None;
        let state = self
            .state
            .as_mut()
            .expect("ACPX state remains available after provider termination");
        state.expire_runtime_requests("explicit_cancellation", true)?;
        state.active_turn_id = None;
        self.context.provider_turn_id = None;
        // Persist a non-attachable, recoverable boundary before the fallible
        // lifetime proof. Terminal cleanup can then retry a timed-out fence
        // without reviving the stopped provider.
        state.lifecycle = "prepared".to_owned();
        state.provider_exit_unconfirmed = true;
        self.save_state()?;
        let _provider_lifetime_fence =
            await_provider_lifetime_fence(provider_lifetime_fence_candidates)?;
        let state = self
            .state
            .as_mut()
            .expect("ACPX state remains available after provider termination");
        state.provider_exit_unconfirmed = false;
        if let Err(error) = self.save_state() {
            self.state
                .as_mut()
                .expect("ACPX state remains available after save failure")
                .provider_exit_unconfirmed = true;
            return Err(error);
        }
        Ok(CommandExecution::result(json!({
            "status": "stopped",
            "providerTurnId": turn_id,
            "reason": reason,
            "providerExitConfirmed": true,
        })))
    }

    fn resolve_request(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let request_id = payload
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires requestId"))?;
        let turn_id = self
            .state
            .as_ref()
            .and_then(|state| state.active_turn_id.clone())
            .ok_or_else(|| DurableRunnerError::invalid("ACPX provider has no active turn"))?;
        if payload
            .get("turnId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != self.context.turn_id)
        {
            return Err(DurableRunnerError::invalid(
                "ACPX runtime response belongs to a stale turn",
            ));
        }
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("ACPX session is unavailable"))?;
        let resolution = payload
            .get("resolution")
            .cloned()
            .or_else(|| {
                payload
                    .get("response")
                    .map(|response| json!({"action":"submit","response":response}))
            })
            .ok_or_else(|| {
                DurableRunnerError::invalid("request.resolve requires resolution or response")
            })?;
        let permission = session.state().pending_permission(request_id).is_some();
        // Admit the event before sending the response, but keep its request
        // retirement and outbox entry private until the state write succeeds.
        let mut staged = self
            .state
            .clone()
            .expect("ACPX response has an active durable turn");
        staged.push(NormalizedProviderEvent {
            event_type: "runtime_request.resolved".to_owned(),
            priority: EventPriority::P0,
            payload: json!({"provider": "acpx", "requestId": request_id, "status": "delivered",
                "requestKind": if permission {"permission_approval"} else {"runtime"},
                "turnId":self.context.turn_id,"itemId":self.context.item_id,"action":resolution.get("action")}),
        })?;
        (if permission {
            session.resolve_permission(request_id, &turn_id, &resolution)
        } else {
            session.resolve_input(request_id, &turn_id, &resolution)
        })
        .map_err(|error| {
            DurableRunnerError::invalid(format!("ACPX runtime response failed: {error}"))
        })?;
        // The sidecar ACK proves delivery, not durable controller settlement.
        // Retain that fact in the same atomic state write that retires the
        // pending request. A crash before this write expires the old request;
        // a crash after it replays this event, never the provider response.
        self.commit_staged_state(staged)?;
        Ok(CommandExecution::result(
            json!({"status": "delivered", "requestId": request_id}),
        ))
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
        // The shared transport waits for an explicit readiness contract before
        // rotating run authority. ACPX checkpoints its process during attach,
        // but must first settle the same durable guards enforced by attach_run.
        // Do not consume events here: the durable runner commits and ACKs the
        // old authority's retained prefix before a later probe can report ready.
        let mut warm_attach_blockers = Vec::new();
        if state.lifecycle == "closed" {
            warm_attach_blockers.push("durable_closed");
        }
        if state.provider_exit_unconfirmed {
            warm_attach_blockers.push("provider_exit_unconfirmed");
        }
        if state.identity.is_none() {
            warm_attach_blockers.push("provider_identity_unavailable");
        }
        if state.active_turn_id.is_some() {
            warm_attach_blockers.push("durable_active_turn");
        }
        if !state.pending_events.is_empty() {
            warm_attach_blockers.push("durable_pending_events");
        }
        Ok(CommandExecution::result(json!({
            "status": state.lifecycle,
            "provider": "acpx",
            "driver": "acpx_runtime",
            "driverSessionId": state.identity.as_ref().map(|value| value.acpx_record_id.as_str()),
            "providerSessionId": state.identity.as_ref().map(|value| value.acpx_record_id.as_str()),
            "sessionId": state.identity.as_ref().map(|value| value.agent_session_id.as_str()),
            "providerAccountSessionId": state.identity.as_ref().map(|value| value.agent_session_id.as_str()),
            "providerIdentity": state.identity,
            "activeProviderTurnId": state.active_turn_id,
            "warmAttachReady": warm_attach_blockers.is_empty(),
            "warmAttachBlockers": warm_attach_blockers,
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
        state.expire_runtime_requests("explicit_cancellation", true)?;
        state.lifecycle = "closed".to_owned();
        state.active_turn_id = None;
        self.context.provider_turn_id = None;
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
            self.context.provider_turn_id = None;
            self.session = None;
            self.save_state()?;
        } else if self.state.as_ref().is_some_and(|state| {
            state.lifecycle == "prepared"
                && state.identity.is_some()
                && !state.provider_exit_unconfirmed
                && state.active_turn_id.is_none()
        }) {
            // turn.stop deliberately leaves an already-reaped provider in a
            // non-recoverable `prepared` state while runner.drain crosses the
            // durable event barrier. Once the following runner.suspend reaches
            // this boundary, publish the exact stopped checkpoint as
            // recoverable instead of reporting a no-op success that can never
            // emit session.resumed in the replacement runner.
            self.state
                .as_mut()
                .expect("ACPX stopped provider state remains available")
                .lifecycle = "suspended".to_owned();
            self.save_state()?;
        }
        Ok(CommandExecution::result(json!({"status": "completed"})))
    }

    fn poll_provider(&mut self) -> Result<(), DurableRunnerError> {
        self.restore()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| !state.pending_events.is_empty() || state.lifecycle == "closed")
            || self.session.is_none()
        {
            return Ok(());
        }
        for _ in 0..MAX_EVENTS_PER_POLL {
            let events = self
                .session
                .as_mut()
                .expect("ACPX session remains available while polling")
                .poll_event(Duration::from_millis(1));
            let events = match events {
                Ok(events) => events,
                Err(error) => {
                    let state = self
                        .state
                        .as_mut()
                        .expect("ACPX failed provider has durable state");
                    state.expire_runtime_requests("provider_process_lost", false)?;
                    let failed_turn = state.active_turn_id.take();
                    state.lifecycle = "closed".to_owned();
                    state.provider_exit_unconfirmed = true;
                    if let Some(turn_id) = failed_turn {
                        state.push(NormalizedProviderEvent { event_type: "turn.failed".to_owned(), priority: EventPriority::P0,
                            payload: json!({"provider":"acpx","providerTurnId":turn_id,"status":"failed","providerTerminalObserved":false,
                                "code":"acpx_provider_transport_failed","message":crate::durable::redact_text(&error.to_string())}) })?;
                        state.push(NormalizedProviderEvent { event_type: "run.terminal".to_owned(), priority: EventPriority::P0,
                            payload: json!({"schema":"paperclip.prp.terminal.v1","status":"failed","turnTerminalState":"failed","runTerminalState":"failed","reportedWorkDisposition":"unknown","provider":"acpx"}) })?;
                    }
                    self.context.provider_turn_id = None;
                    // A failed transport cannot attest escaped provider cleanup.
                    // Drop the closed process owner; later cleanup must prove the lifetime fence.
                    self.session = None;
                    self.save_state()?;
                    return Ok(());
                }
            };
            let Some(events) = events else { break };
            let mut provider_turn_settled = false;
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
                if terminal.is_some() {
                    let snapshot = self.goal_control("session.goal.get", &json!({}))?;
                    let state = self.state.as_mut().expect("ACPX session has durable state");
                    for (event_type, priority, payload) in snapshot.events {
                        state.push(NormalizedProviderEvent {
                            event_type,
                            priority,
                            payload,
                        })?;
                    }
                }
                let state = self
                    .state
                    .as_mut()
                    .expect("ACPX state remains available while polling");
                for mut event in normalized {
                    if matches!(
                        event.event_type.as_str(),
                        "session.goal.updated" | "session.goal.cleared"
                    ) {
                        let revision = event
                            .payload
                            .get("providerRevision")
                            .and_then(Value::as_u64);
                        // Requests consume a newer authoritative snapshot while
                        // older notifications may still be queued in the transport.
                        if !goal_notification_is_newer(revision, state.goal_source_revision) {
                            continue;
                        }
                        state.goal_source_revision = revision;
                        state.goal_revision += 1;
                        event.payload["revision"] = json!(state.goal_revision);
                        state.goal_projection = event.payload.clone();
                    }
                    if event.event_type == "run.result.proposed" {
                        state.semantic_result = Some(event.payload.clone());
                    }
                    state.push(event)?;
                }
                if let Some(event_type) = terminal {
                    state.active_turn_id = None;
                    state.lifecycle = if self
                        .session
                        .as_ref()
                        .is_some_and(|session| session.runtime_retired())
                    {
                        "closed"
                    } else {
                        "session_open"
                    }
                    .to_owned();
                    provider_turn_settled = true;
                    // An ACP goal has session lifetime, not prompt lifetime.
                    // Out-of-prompt goal updates remain observable after quiescence.
                    if state
                        .goal_projection
                        .pointer("/goal/status")
                        .and_then(Value::as_str)
                        == Some("active")
                    {
                        continue;
                    }
                    let (turn_terminal_state, status) = match event_type.as_str() {
                        "turn.completed" => ("completed", "succeeded"),
                        "turn.cancelled" => ("cancelled", "cancelled"),
                        "turn.interrupted" => ("interrupted", "cancelled"),
                        _ => ("failed", "failed"),
                    };
                    let disposition = goal_terminal_disposition(
                        state
                            .goal_projection
                            .pointer("/goal/status")
                            .and_then(Value::as_str),
                        state
                            .semantic_result
                            .as_ref()
                            .and_then(|result| result.get("reportedWorkDisposition"))
                            .and_then(Value::as_str),
                        status == "succeeded",
                    );
                    state.push(NormalizedProviderEvent {
                        event_type: "run.terminal".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({
                            "schema": "paperclip.prp.terminal.v1",
                            "status": status,
                            "turnTerminalState": turn_terminal_state,
                            "runTerminalState": status,
                            "reportedWorkDisposition": disposition,
                            "provider": "acpx",
                        }),
                    })?;
                }
            }
            if provider_turn_settled {
                self.context.provider_turn_id = None;
            }
            self.save_state()?;
        }
        Ok(())
    }
}

fn goal_notification_is_newer(next: Option<u64>, last: Option<u64>) -> bool {
    next.is_some_and(|next| last.is_none_or(|last| next > last))
}

fn goal_terminal_disposition<'a>(
    goal_status: Option<&str>,
    semantic_disposition: Option<&'a str>,
    succeeded: bool,
) -> &'a str {
    match goal_status {
        Some("blocked") => "blocked",
        Some("paused" | "limited" | "usage_limited" | "budget_limited") => "yielded",
        Some("complete") => "done",
        _ => semantic_disposition.unwrap_or(if succeeded { "done" } else { "needs_review" }),
    }
}

impl CommandExecutor for AcpxCommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        self.restore()?;
        if command.command_type != "run.attach"
            && self
                .state
                .as_ref()
                .is_some_and(|state| state.descriptor.run_id != self.context.run_id)
        {
            return Err(DurableRunnerError::invalid(
                "ACPX durable session requires run.attach before commands from a new run",
            ));
        }
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
            "session.goal.get" | "session.goal.set" | "session.goal.clear" => {
                self.goal_control(&command.command_type, &command.payload)
            }
            "turn.start" => self.start_turn(&command.payload),
            "turn.steer" => self.steer_turn(&command.command_id, &command.payload),
            "turn.interrupt" | "run.cancel" => self.interrupt_turn(&command.command_type),
            "turn.stop" => self.stop_turn_for_suspension(&command.command_type),
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

    fn rotate_authority(&mut self, config: &DurableRunnerConfig) {
        self.context.run_id = config.run_id.clone();
        self.context.normalized_session_id = config.normalized_session_id.clone();
        self.context.turn_id = config.turn_id.clone();
        self.context.item_id = config.item_id.clone();
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.restore()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.descriptor.run_id != self.context.run_id)
        {
            return Ok(Vec::new());
        }
        self.poll_provider()?;
        self.retained_events()
    }

    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.ensure_persistence_healthy()?;
        // Explicit drain runs while control traffic suppresses provider polling.
        // Expose the already-retained suffix so runnerd can commit and ACK it
        // before suspension, without restoring or advancing the provider.
        Ok(self
            .state
            .as_ref()
            .into_iter()
            .flat_map(|state| state.pending_events.iter().take(MAX_EVENTS_PER_POLL))
            .cloned()
            .collect())
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        self.ensure_persistence_healthy()?;
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
        if let Some(error) = self.persistence_error.clone() {
            // Reap our owned process even when durable cleanup is uncertain,
            // but do not overwrite the last atomic snapshot or claim success.
            if let Some(mut session) = self.session.take() {
                session
                    .shutdown("ACPX provider state persistence failed")
                    .map_err(|cleanup| {
                        DurableRunnerError::invalid(format!(
                            "{error}; failed to stop ACPX provider: {cleanup}"
                        ))
                    })?;
            }
            return Err(error);
        }
        // A replacement durable runner may reach terminal reconciliation
        // before any provider command or event poll. Restore the persisted
        // session first so cleanup cannot succeed merely because this process
        // has no in-memory session yet.
        self.restore()?;
        let provider_exit_unconfirmed = self
            .state
            .as_ref()
            .is_some_and(|state| state.provider_exit_unconfirmed);
        // The prior provider, guardian, and sidecar inherit two listeners from
        // this exact three-port set. A replacement can bind any two only after
        // the original lifetime has lost quorum. Keep the acquired quorum live
        // through the durable state update so no successor can race the proof.
        let _provider_lifetime_fence = if self.session.is_none() && provider_exit_unconfirmed {
            let candidates = self
                .state
                .as_ref()
                .and_then(|state| state.identity.as_ref())
                .expect("provider cleanup state has a validated identity")
                .provider_lifetime_fence_candidates;
            Some(acquire_provider_lifetime_fence(candidates)?)
        } else {
            None
        };
        if let Some(session) = self.session.as_mut() {
            session
                .shutdown("runner process shutdown")
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("failed to stop ACPX provider: {error}"))
                })?;
        }
        self.session = None;
        if provider_exit_unconfirmed {
            let state = self
                .state
                .as_mut()
                .expect("ACPX state exists for replacement cleanup");
            state.provider_exit_unconfirmed = false;
            if let Err(error) = self.save_state() {
                self.state
                    .as_mut()
                    .expect("ACPX state remains available after save failure")
                    .provider_exit_unconfirmed = true;
                return Err(error);
            }
        }
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
    turn_controls: AcpxTurnControlCapabilities,
) -> Value {
    let mut public_descriptor = descriptor.public_descriptor(Some(identity));
    public_descriptor["turnControls"] = json!(turn_controls);
    json!({
        "provider": "acpx",
        "driver": "acpx_runtime",
        "providerDescriptor": public_descriptor,
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
            provider_turn_id: None,
            item_id: "item-1".to_owned(),
        }
    }

    fn descriptor(agent: &str) -> Value {
        let (model, package, version, runtime_package, runtime_version, digest) =
            if agent == "claude" {
                (
                    "claude-sonnet-5",
                    "@agentclientprotocol/claude-agent-acp",
                    "0.73.0",
                    json!("@anthropic-ai/claude-agent-sdk"),
                    json!("0.3.280"),
                    "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
                )
            } else if agent == "cursor" {
                (
                    "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]",
                    "cursor-agent",
                    "2026.09.26-dd393fe",
                    Value::Null,
                    Value::Null,
                    "sha256:2feb50c7b0a317dff454c00115a5bbe4d5c757189691586577be9c80234d477e",
                )
            } else {
                (
                    "gpt-5.6-sol",
                    "@agentclientprotocol/codex-acp",
                    "1.6.2",
                    json!("@openai/codex"),
                    json!("0.156.0"),
                    "sha256:c4538599d1ab767db5dff50934f13bb5ba313a59d9c4a83e993fac4617ea63d3",
                )
            };
        let mut value = json!({
            "kind": "acpx",
            "provider": "acpx",
            "driver": "acpx_runtime",
            "providerVersion": "0.13.1",
            "agent": agent,
            "model": model,
            "acpxVersion": "0.13.1",
            "agentServerPackage": package,
            "agentServerVersion": version,
            "agentRuntimePackage": runtime_package,
            "agentRuntimeVersion": runtime_version,
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
        });
        if agent == "cursor" {
            value["cursorMode"] = json!("agent");
            value["providerPolicy"] = json!({"readOnly": true});
        }
        value
    }

    fn pending_input_request(id: &str) -> Value {
        json!({"schema":"paperclip.runtime_request.v2","requestId":id,"requestKind":"runtime","type":"input","status":"pending",
            "turnId":"turn-1","itemId":"item-1","prompt":"Choose","input":{"schema":"paperclip.question_set.v1","questions":[{"id":"q","prompt":"Choose","answerMode":"text","required":true}]},
            "origin":{"adapter":"acpx-runtime-sidecar","provider":"cursor","method":"cursor/ask_question"}})
    }

    #[test]
    fn durable_runtime_ledger_retains_only_unsettled_requests_and_rejects_forged_types() {
        let operations = Vec::new();
        let tool_set = AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.into(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        };
        let mut state = AcpxDurableState::new(
            serde_json::from_value(descriptor("codex")).unwrap(),
            tool_set,
            "test".into(),
        );
        state
            .push(NormalizedProviderEvent {
                event_type: "runtime_request.created".into(),
                priority: EventPriority::P0,
                payload: json!({"request":pending_input_request("input-1")}),
            })
            .unwrap();
        assert!(state
            .push(NormalizedProviderEvent {
                event_type: "runtime_request.created".into(),
                priority: EventPriority::P0,
                payload: json!({"request":pending_input_request("input-1")})
            })
            .is_err());
        let mut forged = pending_input_request("forged");
        forged["requestKind"] = json!("permission_approval");
        assert!(state
            .push(NormalizedProviderEvent {
                event_type: "runtime_request.created".into(),
                priority: EventPriority::P0,
                payload: json!({"request":forged})
            })
            .is_err());
        state.pending_events.clear();
        let mut restored: AcpxDurableState =
            serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
        restored
            .expire_runtime_requests("provider_process_lost", false)
            .unwrap();
        assert_eq!(restored.pending_events.len(), 1);
        assert_eq!(
            restored.pending_events[0].event_type,
            "runtime_request.expired"
        );
        assert_eq!(
            restored.pending_events[0].payload["request"],
            pending_input_request("input-1")
        );
        assert_eq!(restored.pending_events[0].payload["replayAllowed"], false);
        restored
            .expire_runtime_requests("provider_process_lost", false)
            .unwrap();
        assert_eq!(restored.pending_events.len(), 1);
        state
            .push(NormalizedProviderEvent {
                event_type: "runtime_request.resolved".into(),
                priority: EventPriority::P0,
                payload: json!({"requestId":"input-1"}),
            })
            .unwrap();
        assert!(state.pending_runtime_requests.is_empty());
        let mut old = serde_json::to_value(state).unwrap();
        old.as_object_mut()
            .unwrap()
            .remove("pendingRuntimeRequests");
        assert!(serde_json::from_value::<AcpxDurableState>(old)
            .unwrap()
            .pending_runtime_requests
            .is_empty());
    }

    #[test]
    fn rejected_runtime_settlement_preserves_the_pending_request() {
        for event_type in [
            "runtime_request.resolved",
            "runtime_request.expired",
            "runtime_request.cancelled",
        ] {
            for exhausted_sequence in [false, true] {
                let operations = Vec::new();
                let mut state = AcpxDurableState::new(
                    serde_json::from_value(descriptor("codex")).unwrap(),
                    AuthorizedToolSet {
                        schema: TOOL_SET_SCHEMA.into(),
                        schema_version: 1,
                        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
                        operations,
                    },
                    "test".into(),
                );
                state
                    .push(NormalizedProviderEvent {
                        event_type: "runtime_request.created".into(),
                        priority: EventPriority::P0,
                        payload: json!({"request":pending_input_request("input-1")}),
                    })
                    .unwrap();
                if exhausted_sequence {
                    state.next_event_sequence = u64::MAX;
                } else {
                    state
                        .pending_events
                        .resize(MAX_PENDING_EVENTS, state.pending_events[0].clone());
                }
                let before = state.clone();
                assert!(state
                    .push(NormalizedProviderEvent {
                        event_type: event_type.into(),
                        priority: EventPriority::P0,
                        payload: json!({"requestId":"input-1"}),
                    })
                    .is_err());
                assert_eq!(
                    state, before,
                    "{event_type} must not retire a request without its event"
                );
            }
        }
    }

    #[test]
    fn post_rename_failure_blocks_settlement_publication_until_fresh_recovery() {
        for event_type in [
            "runtime_request.resolved",
            "runtime_request.expired",
            "runtime_request.cancelled",
        ] {
            let directory = temporary_directory("post-rename-settlement");
            let marker = directory.join("must-not-start-provider");
            let command_path = directory.join("sidecar");
            write_artifact(
                &command_path,
                format!("#!/bin/sh\ntouch '{}'\n", marker.display()).as_bytes(),
                true,
            );
            let launch_profile = AcpxLaunchProfile {
                authority_digest: format!("sha256:{}", "d".repeat(64)),
                command: command_path.clone(),
                args: Vec::new(),
                artifacts: vec![artifact(&command_path)],
            };
            let mut value = descriptor("codex");
            value["sidecarCommand"] = json!(command_path);
            value["sidecarArgs"] = json!([]);
            let descriptor: AcpxProviderDescriptor = serde_json::from_value(value).unwrap();
            let identity = AcpxProviderSessionIdentity {
                kind: "acpx".into(),
                normalized_session_id: "session-1".into(),
                acpx_record_id: "record-1".into(),
                backend_session_id: "backend-1".into(),
                agent_session_id: "agent-1".into(),
                profile_digest: descriptor.command_digest.clone(),
                workspace_digest: format!("sha256:{}", "a".repeat(64)),
                requested_model: descriptor.model.clone(),
                effective_model: descriptor.model.clone(),
                permission_mode: Some(descriptor.permission_mode),
                cursor_mode: descriptor.cursor_mode,
                provider_lifetime_fence_candidates: [60_001, 60_002, 60_003],
            };
            let operations = Vec::new();
            let mut state = AcpxDurableState::new(
                descriptor,
                AuthorizedToolSet {
                    schema: TOOL_SET_SCHEMA.into(),
                    schema_version: 1,
                    catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
                    operations,
                },
                launch_profile.canonical_digest().unwrap(),
            );
            state.identity = Some(identity);
            state.lifecycle = "turn_active".into();
            state.active_turn_id = Some("turn-1".into());
            for request_id in ["input-1", "input-2"] {
                state
                    .push(NormalizedProviderEvent {
                        event_type: "runtime_request.created".into(),
                        priority: EventPriority::P0,
                        payload: json!({"request":pending_input_request(request_id)}),
                    })
                    .unwrap();
            }
            state.pending_events.clear();
            let config = test_config(&directory, Some(launch_profile));
            let mut original = AcpxCommandExecutor::with_runner_config(&directory, &config);
            original.restore_checked = true;
            original.state = Some(state.clone());
            original.save_state().unwrap();
            let mut staged = state.clone();
            staged
                .push(NormalizedProviderEvent {
                    event_type: event_type.into(),
                    priority: EventPriority::P0,
                    payload: json!({"requestId":"input-1"}),
                })
                .unwrap();
            original.fail_after_state_rename = true;
            let error = if event_type == "runtime_request.resolved" {
                let error = original.commit_staged_state(staged.clone()).unwrap_err();
                assert_eq!(original.state.as_ref(), Some(&state));
                error
            } else {
                // Existing cancellation/expiry paths mutate their working
                // state before save; the same latch must quarantine them.
                original.state = Some(staged.clone());
                original.save_state().unwrap_err()
            };
            assert!(error
                .to_string()
                .contains("injected post-rename sync failure"));
            original.fail_after_state_rename = false;
            let disk = fs::read(original.state_path()).unwrap();
            assert_eq!(
                serde_json::from_slice::<AcpxDurableState>(&disk).unwrap(),
                staged
            );
            for result in [
                original.retained_events().map(|_| ()),
                original.poll_events().map(|_| ()),
                original.acknowledge_events(0),
                original.acknowledge_events(1),
                original.restore(),
                original.save_state(),
                original.shutdown(),
            ] {
                assert_eq!(result.unwrap_err().to_string(), error.to_string());
            }
            for command_type in ["request.resolve", "runner.drain", "runner.suspend"] {
                let blocked = original.execute(&Command {
                    schema: "paperclip.prp.command.v1".into(),
                    command_id: "blocked-command".into(),
                    controller_seq: 1,
                    command_type: command_type.into(),
                    issued_at: "2026-09-01T00:00:00.000Z".into(),
                    deadline_at: None,
                    precondition: None,
                    payload: json!({"requestId":"input-1", "resolution":{"action":"submit"}}),
                });
                assert_eq!(blocked.unwrap_err().to_string(), error.to_string());
            }
            assert_eq!(fs::read(original.state_path()).unwrap(), disk);
            drop(original);

            let mut recovered = AcpxCommandExecutor::with_runner_config(&directory, &config);
            let events = recovered.poll_events().unwrap();
            let settlements: Vec<_> = events
                .iter()
                .filter(|event| event.event_type.starts_with("runtime_request."))
                .collect();
            assert_eq!(settlements.len(), 2);
            assert_eq!(settlements[0].event_type, event_type);
            assert_eq!(settlements[0].payload["requestId"], "input-1");
            assert_eq!(
                settlements[0].executor_event_id,
                staged.pending_events[0].executor_event_id
            );
            assert_eq!(settlements[1].event_type, "runtime_request.expired");
            assert_eq!(settlements[1].payload["requestId"], "input-2");
            assert_eq!(settlements[1].payload["replayAllowed"], false);
            assert!(
                event_sequence(&settlements[0].executor_event_id).unwrap()
                    < event_sequence(&settlements[1].executor_event_id).unwrap()
            );
            assert!(recovered
                .resolve_request(&json!({"requestId":"input-1", "resolution":{"action":"submit"}}))
                .is_err());
            assert_eq!(recovered.poll_events().unwrap(), events);
            recovered.acknowledge_events(events.len()).unwrap();
            drop(recovered);
            let mut recovered_again = AcpxCommandExecutor::with_runner_config(&directory, &config);
            assert!(recovered_again.poll_events().unwrap().is_empty());
            assert!(
                !marker.exists(),
                "recovery must not restart a provider or replay input"
            );
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn turn_control_rejects_nonstring_mode_before_provider_access() {
        let directory = temporary_directory("control-mode");
        let config = test_config(&directory, None);
        let mut executor = AcpxCommandExecutor::with_runner_config(&directory, &config);
        for mode in [Value::Null, json!(1), json!(false), json!({})] {
            let error = executor
                .steer_turn(
                    "command-1",
                    &json!({"text":"change direction", "turnId":"turn-1", "mode":mode}),
                )
                .err()
                .unwrap();
            assert!(error.to_string().contains("mode must be a string"));
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn retained_events_exposes_terminal_suffix_without_restoring_provider() {
        let directory = temporary_directory("retained-terminal-suffix");
        let config = test_config(&directory, None);
        let mut executor = AcpxCommandExecutor::with_runner_config(&directory, &config);
        // Invalid on-disk state would fail restoration. Retained-only reads
        // must neither restore a provider nor inspect a different state owner.
        fs::write(executor.state_path(), b"not provider state").unwrap();
        assert!(executor.retained_events().unwrap().is_empty());

        let operations = Vec::new();
        let tool_set = AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        };
        let mut state = AcpxDurableState::new(
            serde_json::from_value(descriptor("claude")).unwrap(),
            tool_set,
            "retained-only-test".to_owned(),
        );
        state.lifecycle = "session_open".to_owned();
        for event_type in ["turn.completed", "run.usage", "run.completed"] {
            state
                .push(NormalizedProviderEvent {
                    event_type: event_type.to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({}),
                })
                .unwrap();
        }
        executor.state = Some(state);
        let suffix = executor.retained_events().unwrap();
        assert_eq!(
            suffix
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            vec!["turn.completed", "run.usage", "run.completed"],
        );
        // Reading is not acknowledgement: a retry sees the exact same FIFO.
        assert_eq!(executor.retained_events().unwrap(), suffix);
        assert!(executor.session.is_none());
        assert_eq!(
            fs::read(executor.state_path()).unwrap(),
            b"not provider state"
        );
        fs::remove_dir_all(directory).unwrap();
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
    fn authoritative_clear_fences_queued_and_unsequenced_goal_notifications() {
        assert!(!goal_notification_is_newer(Some(3), Some(4)));
        assert!(!goal_notification_is_newer(Some(4), Some(4)));
        assert!(!goal_notification_is_newer(None, Some(4)));
        assert!(goal_notification_is_newer(Some(5), Some(4)));
        assert!(goal_notification_is_newer(Some(1), None));
    }

    #[test]
    fn goal_state_overrides_optimistic_prompt_disposition() {
        assert_eq!(
            goal_terminal_disposition(Some("blocked"), Some("done"), true),
            "blocked"
        );
        for status in ["paused", "limited", "usage_limited", "budget_limited"] {
            assert_eq!(
                goal_terminal_disposition(Some(status), Some("done"), true),
                "yielded"
            );
        }
        assert_eq!(
            goal_terminal_disposition(Some("complete"), Some("yielded"), true),
            "done"
        );
        assert_eq!(
            goal_terminal_disposition(None, Some("yielded"), true),
            "yielded"
        );
        assert_eq!(goal_terminal_disposition(None, None, false), "needs_review");
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
            cursor_mode: None,
            provider_lifetime_fence_candidates: [60_001, 60_002, 60_003],
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
    fn admits_candidate_descriptors_only_with_explicit_policy_and_exact_distribution() {
        for (agent, package, version, digest, runtime_package, runtime_version, model) in [
            (
                "cursor",
                "cursor-agent",
                "2026.09.26-dd393fe",
                "sha256:2feb50c7b0a317dff454c00115a5bbe4d5c757189691586577be9c80234d477e",
                None,
                None,
                "explicit-model",
            ),
            (
                "copilot",
                "@github/copilot",
                "1.0.88",
                "sha256:b18c01603dd0169d233140709cfaa8bf5304a03cf5de78ca4f625f30013e8457",
                None,
                None,
                "explicit-model",
            ),
            (
                "pi",
                "pi-acp",
                "0.0.33",
                "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f",
                Some("@earendil-works/pi-coding-agent"),
                Some("0.84.2"),
                "openrouter/deepseek/deepseek-v4-flash-0731",
            ),
        ] {
            let mut value = descriptor("codex");
            value["agent"] = json!(agent);
            value["model"] = json!(model);
            value["agentServerPackage"] = json!(package);
            value["agentServerVersion"] = json!(version);
            value["agentRuntimePackage"] = json!(runtime_package);
            value["agentRuntimeVersion"] = json!(runtime_version);
            value["commandDigest"] = json!(digest);
            let missing: AcpxProviderDescriptor = serde_json::from_value(value.clone()).unwrap();
            assert!(missing.validate(&context()).is_err());
            value["providerPolicy"] = json!({"readOnly":true});
            if agent == "cursor" {
                value["cursorMode"] = json!("agent");
            }
            let valid: AcpxProviderDescriptor = serde_json::from_value(value.clone()).unwrap();
            valid.validate(&context()).unwrap();
            if matches!(agent, "cursor" | "copilot") {
                let mut previous_v9 = value.clone();
                previous_v9["commandDigest"] = json!(match agent {
                    "cursor" =>
                        "sha256:a76ad26878a3b3328154901563cbda857e53583e4e01787f35a797992ef76162",
                    "copilot" =>
                        "sha256:98936d763497bd6f0e5605f52831a344f456357de58c457e440e69a1a468a2f4",
                    _ => unreachable!(),
                });
                let previous_v9: AcpxProviderDescriptor =
                    serde_json::from_value(previous_v9).unwrap();
                assert!(previous_v9.validate(&context()).is_err());
            }
            if agent == "cursor" {
                let mut previous_v8 = value.clone();
                previous_v8["commandDigest"] = json!(
                    "sha256:b9e94cbcdce2783665612c85caf019c4defe37d3d245a694de590ebdf5b1f1a3"
                );
                let previous_v8: AcpxProviderDescriptor =
                    serde_json::from_value(previous_v8).unwrap();
                assert!(previous_v8.validate(&context()).is_err());
            }
            let mut previous_identity = value.clone();
            previous_identity["commandDigest"] = json!(match agent {
                "cursor" =>
                    "sha256:f4c7af914738149cf868d071e53ac4917658fb055224715a2c89d3f59b335503",
                "copilot" =>
                    "sha256:b11721382293b39c1d6dd363eae547b5eae0ccca2cd5dcafc9127cc060ee9526",
                "pi" => "sha256:edf058835ee84de3869c4a8e8bdb71a934ffdb9f34daa37ae6faeb92371d1cdf",
                _ => unreachable!(),
            });
            let previous_identity: AcpxProviderDescriptor =
                serde_json::from_value(previous_identity).unwrap();
            assert!(previous_identity.validate(&context()).is_err());
            let mut previous_contract = value.clone();
            previous_contract["commandDigest"] = json!(match agent {
                "cursor" =>
                    "sha256:377dcea64a727ce799cc112458d4b40ba4bc6574cd6c6f7233b6efd5917a6c4b",
                "copilot" =>
                    "sha256:ece77e40876631a69a828b91813722001d71b6fc81be47ecd4b3dced84ff9473",
                "pi" => "sha256:843d30e419914529755c9827d9151a306da1b50b643be7eab1abe797641a37ce",
                _ => unreachable!(),
            });
            let previous_contract: AcpxProviderDescriptor =
                serde_json::from_value(previous_contract).unwrap();
            assert!(previous_contract.validate(&context()).is_err());
            if agent == "cursor" {
                assert_eq!(valid.public_descriptor(None)["cursorMode"], json!("agent"));
                let mut previous_v4 = value.clone();
                previous_v4["commandDigest"] = json!(
                    "sha256:b1440d559ebc4eef5c7a582f1c81fc153270cfbafa1731a8ee76d83713bdf61b"
                );
                let previous_v4: AcpxProviderDescriptor =
                    serde_json::from_value(previous_v4).unwrap();
                assert!(previous_v4.validate(&context()).is_err());
                let mut missing = value.clone();
                missing.as_object_mut().unwrap().remove("cursorMode");
                let missing: AcpxProviderDescriptor = serde_json::from_value(missing).unwrap();
                assert!(missing.validate(&context()).is_err());
                let mut unknown = value.clone();
                unknown["cursorMode"] = json!("autopilot");
                assert!(serde_json::from_value::<AcpxProviderDescriptor>(unknown).is_err());
            } else {
                assert!(valid.public_descriptor(None).get("cursorMode").is_none());
                let mut wrong_agent = value.clone();
                wrong_agent["cursorMode"] = json!("plan");
                let wrong_agent: AcpxProviderDescriptor =
                    serde_json::from_value(wrong_agent).unwrap();
                assert!(wrong_agent.validate(&context()).is_err());
            }

            for field in ["model", "agentServerVersion", "commandDigest"] {
                let mut wrong = value.clone();
                wrong[field] = json!("");
                let invalid: AcpxProviderDescriptor = serde_json::from_value(wrong).unwrap();
                assert!(invalid.validate(&context()).is_err());
            }
            value["providerPolicy"] = json!({"readOnly":true, "protectedPaths":[]});
            assert!(serde_json::from_value::<AcpxProviderDescriptor>(value).is_err());
        }
    }

    #[test]
    fn rejects_pi_with_another_profile_identity_before_process_launch() {
        let mut pi = descriptor("codex");
        pi["agent"] = json!("pi");
        let pi: AcpxProviderDescriptor = serde_json::from_value(pi).unwrap();
        assert!(pi.validate(&context()).is_err());
    }

    #[test]
    fn binds_sidecar_paths_arguments_and_contents_to_the_runner_profile() {
        let directory = temporary_directory("launch-binding");
        let command = directory.join("node");
        let sidecar = directory.join("sidecar.cjs");
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
        let verified_launch = transport.verified_launch.as_ref().unwrap();
        assert!(matches!(
            verified_launch.arguments().first(),
            Some(VerifiedProcessArgument::CommonJsArtifact(_))
        ));

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
    fn restores_settled_session_for_explicit_run_attachment_only() {
        let directory = temporary_directory("cross-run-attach");
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
        let mut descriptor_value = descriptor("codex");
        descriptor_value["sidecarCommand"] = json!(command);
        descriptor_value["runtimeContext"] = json!({ "instructions": { "digest": "stable" }, "mcp": { "digest": "before" }, "aggregateDigest": "before" });
        descriptor_value["sidecarArgs"] = json!([]);
        descriptor_value["runtimeDirectory"] = json!(runtime);
        descriptor_value["cwd"] = json!(workspace);
        let original_descriptor: AcpxProviderDescriptor =
            serde_json::from_value(descriptor_value.clone()).unwrap();
        let identity = AcpxProviderSessionIdentity {
            kind: "acpx".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            acpx_record_id: "record-1".to_owned(),
            backend_session_id: "backend-1".to_owned(),
            agent_session_id: "agent-1".to_owned(),
            profile_digest: original_descriptor.command_digest.clone(),
            workspace_digest: format!("sha256:{}", "a".repeat(64)),
            requested_model: original_descriptor.model.clone(),
            effective_model: original_descriptor.model.clone(),
            permission_mode: Some(original_descriptor.permission_mode),
            cursor_mode: original_descriptor.cursor_mode,
            provider_lifetime_fence_candidates: [60_001, 60_002, 60_003],
        };
        let operations = Vec::new();
        let tool_set = AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        };
        let launch_profile_digest = launch_profile.canonical_digest().unwrap();
        let mut state = AcpxDurableState::new(original_descriptor, tool_set, launch_profile_digest);
        state.lifecycle = "suspended".to_owned();
        state.identity = Some(identity);
        let original_config = test_config(&directory, Some(launch_profile.clone()));
        let mut original = AcpxCommandExecutor::with_runner_config(&directory, &original_config);
        original.state = Some(state);
        let settled = original.state.clone().unwrap();
        let ready = original.snapshot().unwrap().result;
        assert_eq!(ready["warmAttachReady"], true);
        assert_eq!(ready["warmAttachBlockers"], json!([]));
        let blocked_states: [(&str, fn(&mut AcpxDurableState)); 4] = [
            ("durable_closed", |state| {
                state.lifecycle = "closed".to_owned()
            }),
            ("provider_exit_unconfirmed", |state| {
                state.lifecycle = "prepared".to_owned();
                state.provider_exit_unconfirmed = true;
            }),
            ("provider_identity_unavailable", |state| {
                state.lifecycle = "prepared".to_owned();
                state.identity = None;
            }),
            ("durable_active_turn", |state| {
                state.lifecycle = "turn_active".to_owned();
                state.active_turn_id = Some("turn-1".to_owned());
            }),
        ];
        for (blocker, mutate) in blocked_states {
            original.state = Some(settled.clone());
            mutate(original.state.as_mut().unwrap());
            let snapshot = original.snapshot().unwrap().result;
            assert_eq!(snapshot["warmAttachReady"], false, "{blocker}");
            assert_eq!(snapshot["warmAttachBlockers"], json!([blocker]));
        }
        // A readiness probe must retain the old authority's audit events until
        // the durable runner commits and acknowledges them, including recovery
        // notices that run.attach itself is allowed to consume.
        for event_type in ["session.resumed", "harness.diagnostic"] {
            original.state = Some(settled.clone());
            original
                .state
                .as_mut()
                .unwrap()
                .push(NormalizedProviderEvent {
                    event_type: event_type.to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({}),
                })
                .unwrap();
            let snapshot = original.snapshot().unwrap().result;
            assert_eq!(snapshot["warmAttachReady"], false);
            assert_eq!(
                snapshot["warmAttachBlockers"],
                json!(["durable_pending_events"])
            );
            assert_eq!(original.retained_events().unwrap().len(), 1);
            original.acknowledge_events(1).unwrap();
            assert_eq!(original.snapshot().unwrap().result["warmAttachReady"], true);
        }
        original.state = Some(settled);
        assert!(!marker.exists(), "readiness must not start a provider");
        original.save_state().unwrap();

        let mut wrong_session_config = original_config.clone();
        wrong_session_config.run_id = "run-2".to_owned();
        wrong_session_config.normalized_session_id = "session-2".to_owned();
        let mut wrong_session =
            AcpxCommandExecutor::with_runner_config(&directory, &wrong_session_config);
        assert!(wrong_session.restore().is_err());

        let mut attached_config = original_config.clone();
        attached_config.run_id = "run-2".to_owned();
        let mut attached = AcpxCommandExecutor::with_runner_config(&directory, &attached_config);
        attached.restore().unwrap();
        assert!(!marker.exists());
        let non_attach_error = attached
            .execute(&Command {
                schema: "paperclip.prp.command.v1".to_owned(),
                command_id: "command-before-attach".to_owned(),
                controller_seq: 1,
                command_type: "session.snapshot".to_owned(),
                issued_at: "2026-09-01T00:00:00.000Z".to_owned(),
                deadline_at: None,
                precondition: None,
                payload: json!({}),
            })
            .unwrap_err();
        assert!(non_attach_error
            .to_string()
            .contains("requires run.attach before commands from a new run"));

        descriptor_value["runId"] = json!("run-2");
        attached
            .attach_run(&json!({"provider": descriptor_value}))
            .unwrap();
        assert_eq!(attached.state.as_ref().unwrap().descriptor.run_id, "run-2");
        assert!(!marker.exists());

        // In-place warm handoff executes under the old authority. Only the
        // authenticated next-authority boundary may admit the new descriptor;
        // event correlation stays on run-1 until durable activation completes.
        assert!(original
            .attach_run(&json!({"provider": descriptor_value}))
            .is_err());
        let warm_payload = json!({
            "provider": descriptor_value,
            "paperclipNextAuthority": {
                "identity": {
                    "runnerInstanceId": original_config.runner_instance_id,
                    "environmentLeaseId": original_config.environment_lease_id,
                    "runId": "run-2",
                    "normalizedSessionId": original_config.normalized_session_id,
                    "turnId": "turn-2",
                    "itemId": "item-2",
                },
                "connection": {"mode": "connect", "connectUrl": original_config.connect_url},
            },
        });
        let mut wrong_run = warm_payload.clone();
        wrong_run["paperclipNextAuthority"]["identity"]["runId"] = json!("run-3");
        assert!(original.attach_run(&wrong_run).is_err());
        let mut wrong_session = warm_payload.clone();
        wrong_session["paperclipNextAuthority"]["identity"]["normalizedSessionId"] =
            json!("other-session");
        assert!(original.attach_run(&wrong_session).is_err());
        let mut changed_profile = warm_payload.clone();
        changed_profile["provider"]["instructions"] = json!("different profile");
        assert!(original.attach_run(&changed_profile).is_err());
        let mut refreshed = warm_payload.clone();
        refreshed["provider"]["runtimeContext"]["mcp"] = json!({ "digest": "after" });
        refreshed["provider"]["runtimeContext"]["aggregateDigest"] = json!("after");
        let mut changed_context = refreshed.clone();
        changed_context["provider"]["runtimeContext"]["instructions"] =
            json!({ "digest": "changed" });
        assert!(original.attach_run(&changed_context).is_err());
        original.attach_run(&refreshed).unwrap();
        assert_eq!(
            original.state.as_ref().unwrap().descriptor.runtime_context["mcp"]["digest"],
            "after"
        );
        assert_eq!(original.state.as_ref().unwrap().descriptor.run_id, "run-2");
        assert_eq!(original.context.run_id, "run-1");
        original.rotate_authority(&attached_config);
        assert_eq!(original.context.run_id, "run-2");
        assert!(!marker.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cursor_attachment_rotates_only_authenticated_run_grants() {
        let directory = temporary_directory("cursor-cross-run-attach");
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
        let mut descriptor_value = descriptor("cursor");
        descriptor_value["sidecarCommand"] = json!(command);
        descriptor_value["runtimeContext"] = json!({ "instructions": { "digest": "stable" }, "mcp": { "digest": "before" }, "aggregateDigest": "before" });
        descriptor_value["sidecarArgs"] = json!([]);
        descriptor_value["runtimeDirectory"] = json!(runtime);
        descriptor_value["cwd"] = json!(workspace);
        let prior_root = directory.join("old-registered-copy");
        let current_root = directory.join("new-registered-copy");
        fs::create_dir_all(&prior_root).unwrap();
        fs::create_dir_all(&current_root).unwrap();
        descriptor_value["instructions"] = json!(format!(
            "Current AGENT_HOME: {}. Custom entry.",
            prior_root.display()
        ));
        descriptor_value["runtimeContext"] = json!({
            "aggregateDigest": "a".repeat(64),
            "prompt": {"revision": "pinned", "digest": "b".repeat(64)},
            "instructions": {
                "entryPath": "AGENTS.md",
                "bundle": {"digest": "c".repeat(64), "rootPath": "/old-bundle"},
                "workingCopy": {"kind": "agent_files", "entryPath": "AGENTS.md", "rootPath": prior_root},
            },
            "skills": [{"key": "skill-1", "bundle": {"digest": "d".repeat(64), "rootPath": "/old-skill"}}],
            "mcp": {"assignmentSetId": "assignment-1", "digest": "e".repeat(64), "bindingId": "old-run-binding"},
            "futurePolicy": {"companyId": "company-1"},
        });
        let original_descriptor: AcpxProviderDescriptor =
            serde_json::from_value(descriptor_value.clone()).unwrap();
        let identity = AcpxProviderSessionIdentity {
            kind: "acpx".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            acpx_record_id: "record-1".to_owned(),
            backend_session_id: "backend-1".to_owned(),
            agent_session_id: "agent-1".to_owned(),
            profile_digest: original_descriptor.command_digest.clone(),
            workspace_digest: format!("sha256:{}", "a".repeat(64)),
            requested_model: original_descriptor.model.clone(),
            effective_model: original_descriptor.model.clone(),
            permission_mode: Some(original_descriptor.permission_mode),
            cursor_mode: original_descriptor.cursor_mode,
            provider_lifetime_fence_candidates: [60_001, 60_002, 60_003],
        };
        let operations = Vec::new();
        let tool_set = AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        };
        let launch_profile_digest = launch_profile.canonical_digest().unwrap();
        let mut state = AcpxDurableState::new(original_descriptor, tool_set, launch_profile_digest);
        state.lifecycle = "suspended".to_owned();
        state.identity = Some(identity);
        let original_config = test_config(&directory, Some(launch_profile.clone()));
        let mut original = AcpxCommandExecutor::with_runner_config(&directory, &original_config);
        original.state = Some(state);
        let settled = original.state.clone().unwrap();
        let ready = original.snapshot().unwrap().result;
        assert_eq!(ready["warmAttachReady"], true);
        assert_eq!(ready["warmAttachBlockers"], json!([]));
        let blocked_states: [(&str, fn(&mut AcpxDurableState)); 4] = [
            ("durable_closed", |state| {
                state.lifecycle = "closed".to_owned()
            }),
            ("provider_exit_unconfirmed", |state| {
                state.lifecycle = "prepared".to_owned();
                state.provider_exit_unconfirmed = true;
            }),
            ("provider_identity_unavailable", |state| {
                state.lifecycle = "prepared".to_owned();
                state.identity = None;
            }),
            ("durable_active_turn", |state| {
                state.lifecycle = "turn_active".to_owned();
                state.active_turn_id = Some("turn-1".to_owned());
            }),
        ];
        for (blocker, mutate) in blocked_states {
            original.state = Some(settled.clone());
            mutate(original.state.as_mut().unwrap());
            let snapshot = original.snapshot().unwrap().result;
            assert_eq!(snapshot["warmAttachReady"], false, "{blocker}");
            assert_eq!(snapshot["warmAttachBlockers"], json!([blocker]));
        }
        // A readiness probe must retain the old authority's audit events until
        // the durable runner commits and acknowledges them, including recovery
        // notices that run.attach itself is allowed to consume.
        for event_type in ["session.resumed", "harness.diagnostic"] {
            original.state = Some(settled.clone());
            original
                .state
                .as_mut()
                .unwrap()
                .push(NormalizedProviderEvent {
                    event_type: event_type.to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({}),
                })
                .unwrap();
            let snapshot = original.snapshot().unwrap().result;
            assert_eq!(snapshot["warmAttachReady"], false);
            assert_eq!(
                snapshot["warmAttachBlockers"],
                json!(["durable_pending_events"])
            );
            assert_eq!(original.retained_events().unwrap().len(), 1);
            original.acknowledge_events(1).unwrap();
            assert_eq!(original.snapshot().unwrap().result["warmAttachReady"], true);
        }
        original.state = Some(settled);
        assert!(!marker.exists(), "readiness must not start a provider");
        original.save_state().unwrap();

        let mut wrong_session_config = original_config.clone();
        wrong_session_config.run_id = "run-2".to_owned();
        wrong_session_config.normalized_session_id = "session-2".to_owned();
        let mut wrong_session =
            AcpxCommandExecutor::with_runner_config(&directory, &wrong_session_config);
        assert!(wrong_session.restore().is_err());

        let mut attached_config = original_config.clone();
        attached_config.run_id = "run-2".to_owned();
        let mut attached = AcpxCommandExecutor::with_runner_config(&directory, &attached_config);
        attached.restore().unwrap();
        assert!(!marker.exists());
        let non_attach_error = attached
            .execute(&Command {
                schema: "paperclip.prp.command.v1".to_owned(),
                command_id: "command-before-attach".to_owned(),
                controller_seq: 1,
                command_type: "session.snapshot".to_owned(),
                issued_at: "2026-09-01T00:00:00.000Z".to_owned(),
                deadline_at: None,
                precondition: None,
                payload: json!({}),
            })
            .unwrap_err();
        assert!(non_attach_error
            .to_string()
            .contains("requires run.attach before commands from a new run"));

        descriptor_value["runId"] = json!("run-2");
        fs::remove_dir_all(&prior_root).unwrap();
        descriptor_value["instructions"] = json!(format!(
            "Current AGENT_HOME: {}. Fresh custom entry.",
            current_root.display()
        ));
        descriptor_value["runtimeContext"]["instructions"]["workingCopy"]["rootPath"] =
            json!(current_root);
        descriptor_value["runtimeContext"]["instructions"]["bundle"]["rootPath"] =
            json!("/new-bundle");
        descriptor_value["runtimeContext"]["skills"][0]["bundle"]["rootPath"] = json!("/new-skill");
        descriptor_value["runtimeContext"]["mcp"]["bindingId"] = json!("new-run-binding");
        attached
            .attach_run(&json!({"provider": descriptor_value}))
            .unwrap();
        assert_eq!(attached.state.as_ref().unwrap().descriptor.run_id, "run-2");
        assert!(!marker.exists());
        let refreshed = &attached.state.as_ref().unwrap().descriptor;
        assert_eq!(
            refreshed.runtime_context,
            descriptor_value["runtimeContext"]
        );
        assert_eq!(refreshed.instructions, descriptor_value["instructions"]);
        let session_config = refreshed
            .session_config(
                attached.state.as_ref().unwrap().tool_set.clone(),
                attached.state.as_ref().unwrap().identity.clone(),
                Some(&launch_profile),
            )
            .unwrap();
        assert_eq!(
            session_config.runtime_context,
            descriptor_value["runtimeContext"]
        );
        assert_eq!(
            session_config.system_instructions,
            descriptor_value["instructions"]
        );
        // Both persistence and the sidecar launch config receive the new grant.
        let persisted: AcpxDurableState =
            serde_json::from_slice(&fs::read(attached.state_path()).unwrap()).unwrap();
        assert_eq!(
            persisted.descriptor.runtime_context,
            descriptor_value["runtimeContext"]
        );
        let mut same_run_mutation = descriptor_value.clone();
        same_run_mutation["instructions"] = json!("A different grant in the same run");
        assert!(attached
            .attach_run(&json!({"provider": same_run_mutation}))
            .unwrap_err()
            .to_string()
            .contains("new authenticated run"));

        // In-place warm handoff executes under the old authority. Only the
        // authenticated next-authority boundary may admit the new descriptor;
        // event correlation stays on run-1 until durable activation completes.
        assert!(original
            .attach_run(&json!({"provider": descriptor_value}))
            .is_err());
        let warm_payload = json!({
            "provider": descriptor_value,
            "paperclipNextAuthority": {
                "identity": {
                    "runnerInstanceId": original_config.runner_instance_id,
                    "environmentLeaseId": original_config.environment_lease_id,
                    "runId": "run-2",
                    "normalizedSessionId": original_config.normalized_session_id,
                    "turnId": "turn-2",
                    "itemId": "item-2",
                },
                "connection": {"mode": "connect", "connectUrl": original_config.connect_url},
            },
        });
        let mut wrong_run = warm_payload.clone();
        wrong_run["paperclipNextAuthority"]["identity"]["runId"] = json!("run-3");
        assert!(original.attach_run(&wrong_run).is_err());
        let mut wrong_session = warm_payload.clone();
        wrong_session["paperclipNextAuthority"]["identity"]["normalizedSessionId"] =
            json!("other-session");
        assert!(original.attach_run(&wrong_session).is_err());
        let mut changed_profile = warm_payload.clone();
        changed_profile["provider"]["cwd"] = json!("/different-workspace");
        assert!(original.attach_run(&changed_profile).is_err());
        let mut refreshed = warm_payload.clone();
        refreshed["provider"]["runtimeContext"]["mcp"] = json!({ "digest": "after" });
        refreshed["provider"]["runtimeContext"]["aggregateDigest"] = json!("after");
        let mut changed_context = refreshed.clone();
        changed_context["provider"]["runtimeContext"]["instructions"] =
            json!({ "digest": "changed" });
        assert!(original.attach_run(&changed_context).is_err());
        original.attach_run(&refreshed).unwrap();
        assert_eq!(
            original.state.as_ref().unwrap().descriptor.runtime_context["mcp"]["digest"],
            "after"
        );
        assert_eq!(original.state.as_ref().unwrap().descriptor.run_id, "run-2");
        assert_eq!(original.context.run_id, "run-1");
        original.rotate_authority(&attached_config);
        assert_eq!(original.context.run_id, "run-2");
        assert!(!marker.exists());
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
        let (provider_lifetime_fence_candidates, original_lifetime_fence) =
            reserve_provider_lifetime_fence();
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
            cursor_mode: descriptor.cursor_mode,
            provider_lifetime_fence_candidates,
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
        state
            .push(NormalizedProviderEvent {
                event_type: "runtime_request.created".into(),
                priority: EventPriority::P0,
                payload: json!({"request":pending_input_request("restart-input")}),
            })
            .unwrap();
        state.pending_events.clear(); // The controller already acknowledged creation.

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
        assert_eq!(events[0].event_type, "runtime_request.expired");
        assert_eq!(events[0].payload["requestId"], "restart-input");
        assert_eq!(events[0].payload["replayAllowed"], false);
        assert_eq!(events[1].event_type, "turn.failed");
        assert_eq!(events[1].payload["providerShutdownFailed"], true);
        assert_eq!(events[2].event_type, "run.terminal");
        assert_eq!(events[2].payload["schema"], "paperclip.prp.terminal.v1");
        assert_eq!(events[2].payload["turnTerminalState"], "failed");
        assert_eq!(recovered.poll_events().unwrap(), events);
        let cleanup_error = recovered
            .shutdown()
            .expect_err("cleanup must not succeed while the original lifetime remains active");
        assert!(cleanup_error
            .to_string()
            .contains("original provider lifetime remains active"));
        let persisted: AcpxDurableState = serde_json::from_slice(
            &fs::read(recovered.state_path()).expect("read retained ACPX state"),
        )
        .expect("parse retained ACPX state");
        assert!(persisted.provider_exit_unconfirmed);
        assert!(!marker.exists());

        drop(original_lifetime_fence);
        recovered.shutdown().unwrap();
        let persisted: AcpxDurableState = serde_json::from_slice(
            &fs::read(recovered.state_path()).expect("read cleared ACPX state"),
        )
        .expect("parse cleared ACPX state");
        assert!(!persisted.provider_exit_unconfirmed);
        assert!(!marker.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn suspension_waits_for_the_original_provider_lifetime_quorum() {
        let (candidates, original_lifetime_fence) = reserve_provider_lifetime_fence();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(25));
            drop(original_lifetime_fence);
        });

        let confirmed = await_provider_lifetime_fence(candidates)
            .expect("suspension must wait until the original lifetime loses quorum");
        assert_eq!(confirmed.len(), 2);
        releaser.join().unwrap();
    }

    #[test]
    fn unconfirmed_suspension_state_becomes_recoverable_only_after_cleanup_and_suspend() {
        let directory = temporary_directory("suspension-fence-pending");
        let (provider_lifetime_fence_candidates, original_lifetime_fence) =
            reserve_provider_lifetime_fence();
        let sidecar = directory.join("sidecar");
        write_artifact(&sidecar, b"qualified sidecar", true);
        let launch_profile = AcpxLaunchProfile {
            authority_digest: format!("sha256:{}", "d".repeat(64)),
            command: sidecar.clone(),
            args: Vec::new(),
            artifacts: vec![artifact(&sidecar)],
        };
        let provider_descriptor: AcpxProviderDescriptor =
            serde_json::from_value(descriptor("codex")).unwrap();
        let operations = Vec::new();
        let tool_set = AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        };
        let launch_profile_digest = launch_profile.canonical_digest().unwrap();
        let mut state = AcpxDurableState::new(
            provider_descriptor.clone(),
            tool_set,
            launch_profile_digest.clone(),
        );
        state.lifecycle = "prepared".to_owned();
        state.identity = Some(AcpxProviderSessionIdentity {
            kind: "acpx".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            acpx_record_id: "record-1".to_owned(),
            backend_session_id: "backend-1".to_owned(),
            agent_session_id: "agent-1".to_owned(),
            profile_digest: provider_descriptor.command_digest.clone(),
            workspace_digest: format!("sha256:{}", "a".repeat(64)),
            requested_model: provider_descriptor.model.clone(),
            effective_model: provider_descriptor.model.clone(),
            permission_mode: Some(provider_descriptor.permission_mode),
            cursor_mode: provider_descriptor.cursor_mode,
            provider_lifetime_fence_candidates,
        });
        state.provider_exit_unconfirmed = true;
        state.validate(&context(), &launch_profile_digest).unwrap();

        let config = test_config(&directory, Some(launch_profile));
        let mut executor = AcpxCommandExecutor::with_runner_config(&directory, &config);
        executor.state = Some(state);
        let open_error = executor.open_session().unwrap_err();
        assert!(open_error
            .to_string()
            .contains("provider lifetime cleanup is not yet proven"));
        let attach_error = executor
            .attach_run(&json!({"provider": descriptor("codex")}))
            .unwrap_err();
        assert!(attach_error
            .to_string()
            .contains("requires the same settled ACPX provider profile and session"));
        drop(original_lifetime_fence);
        executor.shutdown().unwrap();
        let recovered = executor.state.as_ref().unwrap();
        assert_eq!(recovered.lifecycle, "prepared");
        assert!(!recovered.provider_exit_unconfirmed);

        executor.suspend().unwrap();
        let suspended: AcpxDurableState = serde_json::from_slice(
            &fs::read(executor.state_path()).expect("read suspended ACPX state"),
        )
        .expect("parse suspended ACPX state");
        assert_eq!(suspended.lifecycle, "suspended");
        assert!(!suspended.provider_exit_unconfirmed);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn lifetime_fence_fixtures_do_not_reuse_a_retired_provider_quorum() {
        let (original_candidates, original_lifetime_fence) = reserve_provider_lifetime_fence();
        drop(original_lifetime_fence);
        let (other_candidates, _other_lifetime_fence) = reserve_provider_lifetime_fence();

        assert!(
            original_candidates
                .iter()
                .all(|candidate| !other_candidates.contains(candidate)),
            "another fixture must not impersonate a retired provider lifetime"
        );
        assert_eq!(
            acquire_provider_lifetime_fence(original_candidates)
                .expect("unrelated live fixture must not block the original cleanup proof")
                .len(),
            2
        );
    }

    fn reserve_provider_lifetime_fence() -> ([u16; 3], Vec<TcpListener>) {
        use std::sync::atomic::{AtomicU32, Ordering};

        // A fixture releases its original listeners before proving cleanup.
        // Never give those candidate ports to another parallel fixture in that
        // gap: its listeners would impersonate the original provider lifetime.
        static NEXT_CANDIDATE_PORT: AtomicU32 = AtomicU32::new(49_152);
        let mut listeners = Vec::new();
        loop {
            let Ok(port) = u16::try_from(NEXT_CANDIDATE_PORT.fetch_add(1, Ordering::Relaxed))
            else {
                break;
            };
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
                listeners.push(listener);
                if listeners.len() == 3 {
                    break;
                }
            }
        }
        assert_eq!(listeners.len(), 3, "reserve provider lifetime ports");
        let candidates = [
            listeners[0].local_addr().unwrap().port(),
            listeners[1].local_addr().unwrap().port(),
            listeners[2].local_addr().unwrap().port(),
        ];
        drop(listeners.pop());
        (candidates, listeners)
    }
}
