use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::acpx_provider_state::AcpxProviderState;
use crate::acpx_sidecar_transport::{AcpxSidecarTransport, AcpxSidecarTransportConfig};
use crate::generated_acpx_sidecar_contract::{
    GeneratedAcpxSidecarCommand, GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
};
use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::{AuthorizedToolSet, ProviderToolBridge};

const MAX_ID_CHARS: usize = 240;
const MAX_MODEL_CHARS: usize = 240;
const MAX_SYSTEM_INSTRUCTIONS_BYTES: usize = 1024 * 1024;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AcpxPermissionMode {
    ApproveAll,
    ApproveReads,
    DenyAll,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpxProviderSessionIdentity {
    pub kind: String,
    pub normalized_session_id: String,
    pub acpx_record_id: String,
    pub backend_session_id: String,
    pub agent_session_id: String,
    pub profile_digest: String,
    pub workspace_digest: String,
    pub requested_model: String,
    pub effective_model: String,
    #[serde(default)]
    pub permission_mode: Option<AcpxPermissionMode>,
}

#[derive(Clone, Debug)]
pub struct AcpxProviderSessionConfig {
    pub transport: AcpxSidecarTransportConfig,
    pub agent: String,
    pub model: String,
    pub run_id: String,
    pub catalog_revision: u64,
    pub runtime_directory: PathBuf,
    pub normalized_session_id: String,
    pub working_directory: PathBuf,
    pub permission_mode: AcpxPermissionMode,
    pub permission_mode_pinned: bool,
    pub system_instructions: String,
    pub tool_set: AuthorizedToolSet,
    pub expected_identity: Option<AcpxProviderSessionIdentity>,
}

impl AcpxProviderSessionConfig {
    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        self.transport.validate()?;
        if self.agent != "codex" {
            return Err(LocalRunnerError::invalid(
                "the initial ACPX provider session supports Codex only",
            ));
        }
        validate_text(&self.model, MAX_MODEL_CHARS, "ACPX model")?;
        validate_text(&self.run_id, 160, "ACPX run id")?;
        validate_text(
            &self.normalized_session_id,
            160,
            "ACPX normalized session id",
        )?;
        if self.catalog_revision == 0 || self.catalog_revision > MAX_JSON_SAFE_INTEGER {
            return Err(LocalRunnerError::invalid(
                "ACPX catalog revision must be a positive JSON-safe integer",
            ));
        }
        for (path, label) in [
            (&self.runtime_directory, "runtime directory"),
            (&self.working_directory, "working directory"),
        ] {
            if !path.is_absolute() {
                return Err(LocalRunnerError::invalid(format!(
                    "ACPX {label} must be an existing absolute directory"
                )));
            }
            if path.to_str().is_none() {
                return Err(LocalRunnerError::invalid(format!(
                    "ACPX {label} must be valid UTF-8"
                )));
            }
            if !path.is_dir() {
                return Err(LocalRunnerError::invalid(format!(
                    "ACPX {label} must be an existing absolute directory"
                )));
            }
        }
        if !self.permission_mode_pinned {
            return Err(LocalRunnerError::invalid(
                "ACPX permission mode must be pinned by the runner policy",
            ));
        }
        if self.system_instructions.len() > MAX_SYSTEM_INSTRUCTIONS_BYTES
            || self.system_instructions.contains('\0')
        {
            return Err(LocalRunnerError::invalid(
                "ACPX system instructions exceed their bounded contract",
            ));
        }
        let mut bridge = ProviderToolBridge::default();
        bridge.prepare(self.tool_set.clone()).map_err(|error| {
            LocalRunnerError::invalid(format!("ACPX authorized tools are invalid: {error}"))
        })?;
        if let Some(expected_identity) = self.expected_identity.as_ref() {
            expected_identity.validate()?;
            if expected_identity.normalized_session_id != self.normalized_session_id
                || expected_identity.requested_model != self.model
                || expected_identity.effective_model != self.model
                || expected_identity.permission_mode != Some(self.permission_mode)
            {
                return Err(LocalRunnerError::invalid(
                    "ACPX expected identity conflicts with the requested session",
                ));
            }
        }
        Ok(())
    }
}

impl AcpxProviderSessionIdentity {
    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        if self.kind != "acpx" {
            return Err(LocalRunnerError::invalid(
                "ACPX session identity kind is invalid",
            ));
        }
        for (value, label) in [
            (&self.normalized_session_id, "normalized session"),
            (&self.acpx_record_id, "record"),
            (&self.backend_session_id, "backend session"),
            (&self.agent_session_id, "agent session"),
            (&self.requested_model, "requested model"),
            (&self.effective_model, "effective model"),
        ] {
            validate_text(value, MAX_ID_CHARS, &format!("ACPX {label} identity"))?;
        }
        for (value, label) in [
            (&self.profile_digest, "profile"),
            (&self.workspace_digest, "workspace"),
        ] {
            if !is_sha256_digest(value) {
                return Err(LocalRunnerError::invalid(format!(
                    "ACPX {label} digest is invalid"
                )));
            }
        }
        Ok(())
    }
}

pub struct AcpxProviderSession {
    transport: AcpxSidecarTransport,
    state: AcpxProviderState,
    identity: AcpxProviderSessionIdentity,
    catalog_revision: u64,
    closed: bool,
}

impl AcpxProviderSession {
    pub fn start(config: &AcpxProviderSessionConfig) -> Result<Self, LocalRunnerError> {
        config.validate()?;
        let mut transport = AcpxSidecarTransport::start(&config.transport)?;
        let bootstrap = bootstrap(&mut transport, config);
        let (identity, state) = match bootstrap {
            Ok(value) => value,
            Err(error) => {
                let cleanup = transport.shutdown();
                return Err(with_cleanup_error(error, cleanup));
            }
        };
        Ok(Self {
            transport,
            state,
            identity,
            catalog_revision: config.catalog_revision,
            closed: false,
        })
    }

    pub fn process_id(&self) -> u32 {
        self.transport.process_id()
    }

    pub fn identity(&self) -> &AcpxProviderSessionIdentity {
        &self.identity
    }

    pub fn state(&self) -> &AcpxProviderState {
        &self.state
    }

    pub fn catalog_revision(&self) -> u64 {
        self.catalog_revision
    }

    pub fn shutdown(&mut self, reason: &str) -> Result<(), LocalRunnerError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let close = self.transport.request(
            GeneratedAcpxSidecarCommand::SessionClose,
            json!({
                "reason": bounded_reason(reason),
                "discardPersistentState": false,
            }),
        );
        let terminate = self.transport.shutdown();
        match (close, terminate) {
            (Ok(_), Ok(())) => Ok(()),
            (Err(error), cleanup) => Err(with_cleanup_error(error, cleanup)),
            (Ok(_), Err(error)) => Err(error),
        }
    }
}

impl Drop for AcpxProviderSession {
    fn drop(&mut self) {
        if !self.closed {
            self.closed = true;
            let _ = self.transport.shutdown();
        }
    }
}

fn bootstrap(
    transport: &mut AcpxSidecarTransport,
    config: &AcpxProviderSessionConfig,
) -> Result<(AcpxProviderSessionIdentity, AcpxProviderState), LocalRunnerError> {
    let initialized = transport.request(
        GeneratedAcpxSidecarCommand::Initialize,
        json!({"agent": config.agent, "model": config.model}),
    )?;
    verify_initialize_response(&initialized, transport.process_id())?;

    let opened = transport.request(
        GeneratedAcpxSidecarCommand::SessionOpen,
        json!({
            "runtimeDirectory": config.runtime_directory,
            "normalizedSessionId": config.normalized_session_id,
            "workingDirectory": config.working_directory,
            "agent": config.agent,
            "model": config.model,
            "permissionMode": config.permission_mode,
            "permissionModePinned": config.permission_mode_pinned,
            "systemInstructions": config.system_instructions,
            "runtimeContext": Value::Null,
            "tools": config.tool_set.operations,
            "expectedIdentity": config.expected_identity,
        }),
    )?;
    let identity = verify_open_response(&opened, transport.process_id(), config)?;

    let attached = transport.request(
        GeneratedAcpxSidecarCommand::RunAttach,
        json!({
            "runId": config.run_id,
            "catalogRevision": config.catalog_revision,
            "tools": config.tool_set.operations,
        }),
    )?;
    if attached.get("runId").and_then(Value::as_str) != Some(config.run_id.as_str())
        || attached.get("catalogRevision").and_then(Value::as_u64) != Some(config.catalog_revision)
    {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar did not confirm the requested run attachment",
        ));
    }
    Ok((identity, AcpxProviderState::new(&config.run_id)?))
}

fn verify_initialize_response(value: &Value, process_id: u32) -> Result<(), LocalRunnerError> {
    if value.get("protocolVersion").and_then(Value::as_u64)
        != Some(GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION)
        || value.get("sidecarPid").and_then(Value::as_u64) != Some(u64::from(process_id))
        || !value.get("profile").is_some_and(Value::is_object)
        || value
            .pointer("/capabilities/persistentSessions")
            .and_then(Value::as_bool)
            != Some(true)
        || value
            .pointer("/capabilities/exactModelVerification")
            .and_then(Value::as_bool)
            != Some(true)
        || value
            .pointer("/capabilities/permissions")
            .and_then(Value::as_str)
            != Some("runner_policy")
        || value
            .pointer("/capabilities/semanticTools")
            .and_then(Value::as_str)
            != Some("runner_bridge")
        || value
            .pointer("/capabilities/structuredInput")
            .and_then(Value::as_str)
            != Some("paperclip.question_set.v1")
    {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar initialization capabilities are invalid",
        ));
    }
    Ok(())
}

fn verify_open_response(
    value: &Value,
    process_id: u32,
    config: &AcpxProviderSessionConfig,
) -> Result<AcpxProviderSessionIdentity, LocalRunnerError> {
    if value.get("sidecarPid").and_then(Value::as_u64) != Some(u64::from(process_id))
        || !value.get("status").is_some_and(Value::is_object)
    {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar session-open response is invalid",
        ));
    }
    let identity: AcpxProviderSessionIdentity = serde_json::from_value(
        value
            .get("identity")
            .cloned()
            .ok_or_else(|| LocalRunnerError::invalid("ACPX sidecar omitted its identity"))?,
    )
    .map_err(|error| {
        LocalRunnerError::invalid(format!("ACPX sidecar identity is invalid: {error}"))
    })?;
    identity.validate()?;
    if identity.normalized_session_id != config.normalized_session_id
        || identity.requested_model != config.model
        || identity.effective_model != config.model
        || identity.permission_mode != Some(config.permission_mode)
        || config
            .expected_identity
            .as_ref()
            .is_some_and(|expected| expected != &identity)
    {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar identity does not match the requested session",
        ));
    }
    Ok(identity)
}

fn validate_text(value: &str, max_chars: usize, label: &str) -> Result<(), LocalRunnerError> {
    if value.trim().is_empty()
        || value.chars().count() > max_chars
        || value.chars().any(char::is_control)
    {
        return Err(LocalRunnerError::invalid(format!("{label} is invalid")));
    }
    Ok(())
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn bounded_reason(value: &str) -> String {
    value.chars().take(4_000).collect()
}

fn with_cleanup_error(
    error: LocalRunnerError,
    cleanup: Result<(), LocalRunnerError>,
) -> LocalRunnerError {
    match cleanup {
        Ok(()) => error,
        Err(cleanup) => LocalRunnerError::invalid(format!(
            "{error}; ACPX sidecar cleanup also failed: {cleanup}"
        )),
    }
}
