use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs::{self, DirBuilder};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::aws_agentcore_provider::{
    AwsAgentCoreHarnessProvider, AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD,
    AGENTCORE_PENDING_CEILING_FIELD, AGENTCORE_PENDING_INVOCATION_FIELD,
    AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE, AGENTCORE_USAGE_RECONCILIATION_FIELD,
    AGENTCORE_USAGE_RECONCILIATION_OBSERVED, AGENTCORE_USAGE_RECONCILIATION_PENDING,
};
use crate::claude_managed_provider::ClaudeManagedProvider;
use crate::durable::{
    create_private_temporary_file, open_private_regular_file, sanitize_value,
    verify_private_directory, Command, CommandExecution, CommandExecutor, DurableRunnerConfig,
    DurableRunnerError, EventPriority, PolledEvent,
};
use crate::managed_provider::{
    AwsAgentCoreProviderConfig, ClaudeManagedProviderConfig, ClaudeManagedSkillRef, Provider,
    ProviderEvent, ProviderRuntimeIdentity,
};
use crate::provider_bridge::{
    authorized_tool_catalog_digest, semantic_value_digest, AuthorizedTool, AuthorizedToolSet,
    PendingToolCall, ToolResult, MAX_PENDING_CALLS, TOOL_SET_SCHEMA,
};
use crate::provider_events::{normalize_codex_notification, NormalizedProviderEvent};

pub const MANAGED_PROVIDER_STATE_FILE: &str = "managed-provider-state.json";
const MANAGED_PROVIDER_STATE_SCHEMA: &str = "paperclip.runner.managed-provider-state.v1";
const MAX_PROVIDER_STATE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PENDING_EVENTS: usize = 8_320;
const MAX_EVENTS_PER_POLL: usize = 128;
const MAX_INSTRUCTIONS_BYTES: usize = 1024 * 1024;
const QUALIFIED_CLAUDE_MODEL: &str = "claude-sonnet-5";
const QUALIFIED_CLAUDE_BETA: &str = "managed-agents-2026-04-01";
const QUALIFIED_AGENTCORE_MODEL: &str = "global.anthropic.claude-sonnet-4-6";
const QUALIFIED_AGENTCORE_REVISION: &str = "aws-agentcore-harness-v1";

fn initial_event_sequence() -> u64 {
    1
}

fn event_id(sequence: u64) -> String {
    format!("managed_provider_{sequence:016}")
}

fn event_sequence(value: &str) -> Option<u64> {
    let sequence = value.strip_prefix("managed_provider_")?.parse().ok()?;
    (event_id(sequence) == value).then_some(sequence)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletionContractBinding {
    revision: String,
    criterion_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ManagedProviderKind {
    ClaudeManaged,
    AwsAgentcore,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", content = "config", rename_all = "snake_case")]
enum ManagedProviderDescriptor {
    ClaudeManaged(ClaudeManagedProviderConfig),
    AwsAgentcore(AwsAgentCoreProviderConfig),
}

impl ManagedProviderDescriptor {
    fn parse(value: Value) -> Result<Self, DurableRunnerError> {
        let mut object = value.as_object().cloned().ok_or_else(|| {
            DurableRunnerError::invalid("managed run.prepare provider must be an object")
        })?;
        let kind = object
            .remove("kind")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| DurableRunnerError::invalid("managed provider kind is required"))?;
        let value = Value::Object(object);
        match kind.as_str() {
            "claude_managed" => serde_json::from_value(value)
                .map(Self::ClaudeManaged)
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "Claude Managed provider descriptor is invalid: {error}"
                    ))
                }),
            "aws_agentcore" => serde_json::from_value(value)
                .map(Self::AwsAgentcore)
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "AWS AgentCore provider descriptor is invalid: {error}"
                    ))
                }),
            _ => Err(DurableRunnerError::invalid(
                "managed provider kind must be claude_managed or aws_agentcore",
            )),
        }
    }

    fn kind(&self) -> ManagedProviderKind {
        match self {
            Self::ClaudeManaged(_) => ManagedProviderKind::ClaudeManaged,
            Self::AwsAgentcore(_) => ManagedProviderKind::AwsAgentcore,
        }
    }

    fn provider_label(&self) -> &'static str {
        match self {
            Self::ClaudeManaged(_) => "claude_managed",
            Self::AwsAgentcore(_) => "aws_agentcore",
        }
    }

    fn display_name(&self) -> &'static str {
        match self {
            Self::ClaudeManaged(_) => "Claude Managed Agent",
            Self::AwsAgentcore(_) => "AWS AgentCore Harness",
        }
    }

    fn driver(&self) -> &'static str {
        match self {
            Self::ClaudeManaged(_) => "claude_managed_agents_api",
            Self::AwsAgentcore(_) => "aws_agentcore_harness_api",
        }
    }

    fn version(&self) -> &str {
        match self {
            Self::ClaudeManaged(config) => &config.beta_version,
            Self::AwsAgentcore(config) => &config.qualification_revision,
        }
    }

    fn model(&self) -> &str {
        match self {
            Self::ClaudeManaged(config) => &config.model,
            Self::AwsAgentcore(config) => &config.model,
        }
    }

    fn validate(&self) -> Result<(), DurableRunnerError> {
        let valid_text = |value: &str, limit: usize| {
            !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
        };
        match self {
            Self::ClaudeManaged(config) => {
                if config.model != QUALIFIED_CLAUDE_MODEL
                    || config.beta_version != QUALIFIED_CLAUDE_BETA
                    || ![
                        config.profile_id.as_str(),
                        config.anthropic_agent_id.as_str(),
                        config.agent_version.as_str(),
                        config.environment_id.as_str(),
                    ]
                    .iter()
                    .all(|value| valid_text(value, 512))
                    || config.instructions.is_empty()
                    || config.instructions.len() > MAX_INSTRUCTIONS_BYTES
                    || config.instructions.contains('\0')
                    || !config.max_session_list_cost_usd.is_finite()
                    || config.max_session_list_cost_usd < 0.01
                    || ((config.max_session_list_cost_usd * 100.0).round()
                        - config.max_session_list_cost_usd * 100.0)
                        .abs()
                        > 0.000_001
                    || config
                        .runtime_context
                        .as_ref()
                        .is_some_and(|value| !value.is_object())
                {
                    return Err(DurableRunnerError::invalid(
                        "Claude Managed provider does not match the qualified immutable profile",
                    ));
                }
            }
            Self::AwsAgentcore(config) => {
                let arn_prefix = format!(
                    "arn:aws:bedrock-agentcore:{}:{}:",
                    config.region, config.account_id
                );
                let role_prefix = format!("arn:aws:iam::{}:role/", config.account_id);
                if config.model != QUALIFIED_AGENTCORE_MODEL
                    || config.qualification_revision != QUALIFIED_AGENTCORE_REVISION
                    || ![
                        config.profile_id.as_str(),
                        config.region.as_str(),
                        config.account_id.as_str(),
                        config.harness_version.as_str(),
                        config.endpoint_qualifier.as_str(),
                        config.memory_id.as_str(),
                        config.context_bucket.as_str(),
                    ]
                    .iter()
                    .all(|value| valid_text(value, 512))
                    || !config.harness_arn.starts_with(&arn_prefix)
                    || !config.endpoint_arn.starts_with(&arn_prefix)
                    || !config.agent_runtime_arn.starts_with(&arn_prefix)
                    || !config.memory_arn.starts_with(&arn_prefix)
                    || !config.invocation_role_arn.starts_with(&role_prefix)
                    || !config.context_kms_key_arn.starts_with(&format!(
                        "arn:aws:kms:{}:{}:key/",
                        config.region, config.account_id
                    ))
                    || config.context_prefix.starts_with('/')
                    || config
                        .context_prefix
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..")
                    || config.event_expiry_days != 90
                    || config.max_iterations == 0
                    || config.max_iterations > 8
                    || config.max_output_tokens == 0
                    || config.max_output_tokens > 4096
                    || config.timeout_seconds == 0
                    || config.timeout_seconds > 300
                    || !config.max_estimated_session_cost_usd.is_finite()
                    || config.max_estimated_session_cost_usd <= 0.0
                    || config.instructions.is_empty()
                    || config.instructions.len() > MAX_INSTRUCTIONS_BYTES
                    || config.instructions.contains('\0')
                    || config
                        .runtime_context
                        .as_ref()
                        .is_some_and(|value| !value.is_object())
                {
                    return Err(DurableRunnerError::invalid(
                        "AWS AgentCore provider does not match the qualified immutable profile",
                    ));
                }
            }
        }
        Ok(())
    }

    fn set_budget(&mut self, value: f64) {
        match self {
            Self::ClaudeManaged(config) => config.max_session_list_cost_usd = value,
            Self::AwsAgentcore(config) => config.max_estimated_session_cost_usd = value,
        }
    }
}

#[derive(Debug)]
struct ManagedProviderStartError {
    error: DurableRunnerError,
    claude_skill_cleanup: Option<Vec<ClaudeManagedSkillRef>>,
    claude_durable_skills: Option<Vec<ClaudeManagedSkillRef>>,
    recovery_session_id: Option<String>,
}

impl ManagedProviderStartError {
    fn plain(error: DurableRunnerError) -> Self {
        Self {
            error,
            claude_skill_cleanup: None,
            claude_durable_skills: None,
            recovery_session_id: None,
        }
    }
}

trait ManagedProviderFactory {
    fn start(
        &self,
        descriptor: &ManagedProviderDescriptor,
        tools: Vec<AuthorizedTool>,
        ownership_scope: &str,
        resume_session_id: Option<&str>,
        resume_event_cursor: Option<&str>,
        resume_model_request_count: u64,
        resume_usage: Option<&Value>,
        resume_claude_managed_skills: Option<&[ClaudeManagedSkillRef]>,
        pending_claude_skill_cleanup: Option<&[ClaudeManagedSkillRef]>,
    ) -> Result<Box<dyn Provider>, ManagedProviderStartError>;
}

struct DefaultManagedProviderFactory;

impl ManagedProviderFactory for DefaultManagedProviderFactory {
    fn start(
        &self,
        descriptor: &ManagedProviderDescriptor,
        tools: Vec<AuthorizedTool>,
        ownership_scope: &str,
        resume_session_id: Option<&str>,
        resume_event_cursor: Option<&str>,
        resume_model_request_count: u64,
        resume_usage: Option<&Value>,
        resume_claude_managed_skills: Option<&[ClaudeManagedSkillRef]>,
        pending_claude_skill_cleanup: Option<&[ClaudeManagedSkillRef]>,
    ) -> Result<Box<dyn Provider>, ManagedProviderStartError> {
        match descriptor {
            ManagedProviderDescriptor::ClaudeManaged(config) => ClaudeManagedProvider::start(
                config,
                tools,
                ownership_scope,
                resume_session_id,
                resume_event_cursor,
                resume_model_request_count,
                resume_claude_managed_skills,
                pending_claude_skill_cleanup,
            )
            .map(|provider| Box::new(provider) as Box<dyn Provider>)
            .map_err(|error| {
                let claude_skill_cleanup = error.cleanup_inventory().map(<[_]>::to_vec);
                let claude_durable_skills = error.durable_skills().map(<[_]>::to_vec);
                let recovery_session_id = error.recovery_session_id().map(str::to_owned);
                ManagedProviderStartError {
                    error: DurableRunnerError::invalid(format!(
                        "failed to start Claude Managed provider: {error}"
                    )),
                    claude_skill_cleanup,
                    claude_durable_skills,
                    recovery_session_id,
                }
            }),
            ManagedProviderDescriptor::AwsAgentcore(config) => AwsAgentCoreHarnessProvider::start(
                config,
                tools,
                resume_session_id,
                resume_event_cursor,
                resume_usage,
            )
            .map(|provider| Box::new(provider) as Box<dyn Provider>)
            .map_err(|error| {
                ManagedProviderStartError::plain(DurableRunnerError::invalid(format!(
                    "failed to start AWS AgentCore provider: {error}"
                )))
            }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedDurableState {
    schema: String,
    run_id: String,
    normalized_session_id: String,
    lifecycle: String,
    descriptor: ManagedProviderDescriptor,
    tool_set: AuthorizedToolSet,
    #[serde(default)]
    completion_contract: Option<CompletionContractBinding>,
    #[serde(default)]
    provider_session_id: Option<String>,
    #[serde(default)]
    durable_event_cursor: Option<String>,
    #[serde(default)]
    model_request_count: u64,
    #[serde(default)]
    provider_usage: Option<Value>,
    #[serde(default)]
    claude_managed_skills: Option<Vec<ClaudeManagedSkillRef>>,
    #[serde(default)]
    claude_managed_skill_cleanup: Option<Vec<ClaudeManagedSkillRef>>,
    #[serde(default)]
    active_turn_id: Option<String>,
    #[serde(default)]
    last_agent_message: Option<String>,
    #[serde(default)]
    pending_tool_calls: BTreeMap<String, PendingToolCall>,
    #[serde(default)]
    ambiguous_tool_deliveries: BTreeMap<String, ToolResult>,
    #[serde(default)]
    pending_events: VecDeque<PolledEvent>,
    #[serde(default = "initial_event_sequence")]
    next_event_sequence: u64,
}

fn valid_agentcore_usage_snapshot(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let pending_ceiling = match object.get(AGENTCORE_PENDING_CEILING_FIELD) {
        None => None,
        Some(value) => match value
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
        {
            Some(value) => Some(value),
            None => return false,
        },
    };
    let conservative_floor = match object.get(AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD) {
        None => None,
        Some(value) => match value
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
        {
            Some(value) => Some(value),
            None => return false,
        },
    };
    let reconciliation_valid = match (
        object.get(AGENTCORE_USAGE_RECONCILIATION_FIELD),
        object.get(AGENTCORE_PENDING_INVOCATION_FIELD),
        pending_ceiling,
    ) {
        (None, None, None) => conservative_floor.is_none(),
        (Some(reconciliation), None, None) => {
            reconciliation.as_str() == Some(AGENTCORE_USAGE_RECONCILIATION_OBSERVED)
                || (reconciliation.as_str() == Some(AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE)
                    && conservative_floor.is_some())
        }
        (Some(reconciliation), Some(invocation_id), _) => {
            reconciliation.as_str() == Some(AGENTCORE_USAGE_RECONCILIATION_PENDING)
                && invocation_id.as_str().is_some_and(|invocation_id| {
                    !invocation_id.is_empty()
                        && invocation_id.len() <= 512
                        && !invocation_id.chars().any(char::is_control)
                })
        }
        _ => false,
    };
    let estimated_cost = object
        .get("estimatedCostUsd")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0);
    reconciliation_valid
        && [
            "inputTokens",
            "outputTokens",
            "cacheReadInputTokens",
            "cacheWriteInputTokens",
            "requestCount",
        ]
        .iter()
        .all(|field| object.get(*field).and_then(Value::as_u64).is_some())
        && estimated_cost.is_some()
        && conservative_floor
            .zip(estimated_cost)
            .is_none_or(|(floor, estimated)| estimated >= floor)
        && object.get("costSource").and_then(Value::as_str) == Some("paperclip_estimate")
}

fn valid_claude_managed_skill_ref(value: &ClaudeManagedSkillRef) -> bool {
    let valid_id = |text: &str, limit: usize| {
        !text.is_empty()
            && text.len() <= limit
            && text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    };
    valid_id(&value.skill_id, 512) && valid_id(&value.version, 512)
}

fn expected_claude_managed_skill_count(config: &ClaudeManagedProviderConfig) -> Option<usize> {
    match config.runtime_context.as_ref() {
        None => Some(0),
        Some(context) => context
            .get("skills")
            .and_then(Value::as_array)
            .and_then(|skills| skills.len().checked_add(1)),
    }
}

impl ManagedDurableState {
    fn new(
        run_id: String,
        normalized_session_id: String,
        descriptor: ManagedProviderDescriptor,
        tool_set: AuthorizedToolSet,
        completion_contract: Option<CompletionContractBinding>,
    ) -> Self {
        Self {
            schema: MANAGED_PROVIDER_STATE_SCHEMA.to_owned(),
            run_id,
            normalized_session_id,
            lifecycle: "prepared".to_owned(),
            descriptor,
            tool_set,
            completion_contract,
            provider_session_id: None,
            durable_event_cursor: None,
            model_request_count: 0,
            provider_usage: None,
            claude_managed_skills: None,
            claude_managed_skill_cleanup: None,
            active_turn_id: None,
            last_agent_message: None,
            pending_tool_calls: BTreeMap::new(),
            ambiguous_tool_deliveries: BTreeMap::new(),
            pending_events: VecDeque::new(),
            next_event_sequence: initial_event_sequence(),
        }
    }

    fn validate(&self, config: &DurableRunnerConfig) -> Result<(), DurableRunnerError> {
        self.descriptor.validate()?;
        let mut event_ids = HashSet::new();
        let valid_skill_inventory = |skills: &[ClaudeManagedSkillRef], maximum: usize| {
            let mut ids = HashSet::new();
            !skills.is_empty()
                && skills.len() <= maximum
                && skills.iter().all(|skill| {
                    valid_claude_managed_skill_ref(skill) && ids.insert(skill.skill_id.as_str())
                })
        };
        let valid_claude_managed_skills = match &self.descriptor {
            ManagedProviderDescriptor::AwsAgentcore(_) => {
                self.claude_managed_skills.is_none() && self.claude_managed_skill_cleanup.is_none()
            }
            ManagedProviderDescriptor::ClaudeManaged(descriptor) => {
                let persisted_resources_required = self.provider_session_id.is_some();
                let expected = expected_claude_managed_skill_count(descriptor);
                let owned_valid = match self.claude_managed_skills.as_ref() {
                    None => !persisted_resources_required,
                    Some(skills) => {
                        let mut ids = HashSet::new();
                        expected == Some(skills.len())
                            && skills.iter().all(|skill| {
                                valid_claude_managed_skill_ref(skill)
                                    && ids.insert(skill.skill_id.as_str())
                            })
                    }
                };
                let cleanup_valid = match self.claude_managed_skill_cleanup.as_ref() {
                    None => true,
                    Some(skills) => {
                        expected.is_some_and(|expected| valid_skill_inventory(skills, expected))
                    }
                };
                owned_valid
                    && cleanup_valid
                    && !(self.claude_managed_skills.is_some()
                        && self.claude_managed_skill_cleanup.is_some())
                    && !(self.provider_session_id.is_some()
                        && self.claude_managed_skill_cleanup.is_some())
            }
        };
        if self.schema != MANAGED_PROVIDER_STATE_SCHEMA
            || self.run_id != config.run_id
            || self.normalized_session_id != config.normalized_session_id
            || !matches!(
                self.lifecycle.as_str(),
                "prepared"
                    | "session_opening"
                    | "session_open"
                    | "turn_starting"
                    | "turn_active"
                    | "suspended"
                    | "failed"
                    | "closed"
            )
            || self.provider_session_id.as_ref().is_some_and(|value| {
                value.is_empty() || value.len() > 512 || value.chars().any(char::is_control)
            })
            || self.active_turn_id.as_ref().is_some_and(|value| {
                value.is_empty() || value.len() > 512 || value.chars().any(char::is_control)
            })
            || (matches!(self.lifecycle.as_str(), "turn_starting" | "turn_active")
                != self.active_turn_id.is_some())
            || (matches!(self.lifecycle.as_str(), "session_open" | "suspended")
                && self.provider_session_id.is_none())
            || !valid_claude_managed_skills
            || match self.descriptor.kind() {
                ManagedProviderKind::ClaudeManaged => self.provider_usage.is_some(),
                ManagedProviderKind::AwsAgentcore => {
                    if matches!(self.lifecycle.as_str(), "prepared" | "session_opening") {
                        self.provider_usage
                            .as_ref()
                            .is_some_and(|value| !valid_agentcore_usage_snapshot(value))
                    } else {
                        self.provider_usage
                            .as_ref()
                            .is_none_or(|value| !valid_agentcore_usage_snapshot(value))
                    }
                }
            }
            || self
                .last_agent_message
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 1_000_000)
            || self.pending_tool_calls.len() > MAX_PENDING_CALLS
            || self.ambiguous_tool_deliveries.len() > MAX_PENDING_CALLS
            || self.next_event_sequence == 0
            || self.pending_events.len() > MAX_PENDING_EVENTS
            || self.pending_events.iter().any(|event| {
                event_sequence(&event.executor_event_id)
                    .is_none_or(|sequence| sequence >= self.next_event_sequence)
                    || !event_ids.insert(event.executor_event_id.as_str())
                    || event.event_type.is_empty()
                    || event.event_type.len() > 160
                    || !event.payload.is_object()
            })
        {
            return Err(DurableRunnerError::invalid(
                "managed provider state is malformed or conflicts with runner identity",
            ));
        }
        if let Some(contract) = self.completion_contract.as_ref() {
            if contract.revision.is_empty()
                || contract.revision.len() > 120
                || contract.criterion_ids.is_empty()
                || contract.criterion_ids.len() > 256
                || contract.criterion_ids.iter().any(|criterion| {
                    criterion.is_empty()
                        || criterion.len() > 240
                        || criterion.chars().any(char::is_control)
                })
            {
                return Err(DurableRunnerError::invalid(
                    "managed completion contract is malformed",
                ));
            }
        }
        for (call_id, call) in &self.pending_tool_calls {
            if call_id != &call.call_id
                || call_id.is_empty()
                || call_id.len() > 512
                || call.operation_id.is_empty()
                || call.operation_id.len() > 512
                || !call.input.is_object()
            {
                return Err(DurableRunnerError::invalid(
                    "managed pending tool call is malformed",
                ));
            }
        }
        for (call_id, result) in &self.ambiguous_tool_deliveries {
            if call_id != &result.call_id || !self.pending_tool_calls.contains_key(call_id) {
                return Err(DurableRunnerError::invalid(
                    "managed ambiguous tool delivery is inconsistent",
                ));
            }
        }
        Ok(())
    }

    fn push(&mut self, event: NormalizedProviderEvent) -> Result<(), DurableRunnerError> {
        if self.pending_events.len() >= MAX_PENDING_EVENTS {
            return Err(DurableRunnerError::invalid(
                "managed provider event backlog exceeds its durable limit",
            ));
        }
        let sequence = self.next_event_sequence;
        self.next_event_sequence = sequence.checked_add(1).ok_or_else(|| {
            DurableRunnerError::invalid("managed provider event sequence exhausted")
        })?;
        self.pending_events.push_back(PolledEvent {
            executor_event_id: event_id(sequence),
            event_type: event.event_type,
            priority: event.priority,
            payload: event.payload,
        });
        Ok(())
    }
}

pub struct ManagedProviderCommandExecutor {
    state_dir: PathBuf,
    config: DurableRunnerConfig,
    state: Option<ManagedDurableState>,
    provider: Option<Box<dyn Provider>>,
    restore_checked: bool,
    factory: Box<dyn ManagedProviderFactory>,
}

impl ManagedProviderCommandExecutor {
    pub fn with_runner_config(state_dir: impl Into<PathBuf>, config: &DurableRunnerConfig) -> Self {
        Self {
            state_dir: state_dir.into(),
            config: config.clone(),
            state: None,
            provider: None,
            restore_checked: false,
            factory: Box::new(DefaultManagedProviderFactory),
        }
    }

    #[cfg(test)]
    fn with_factory(
        state_dir: impl Into<PathBuf>,
        config: &DurableRunnerConfig,
        factory: Box<dyn ManagedProviderFactory>,
    ) -> Self {
        Self {
            factory,
            ..Self::with_runner_config(state_dir, config)
        }
    }

    pub fn state_path(&self) -> PathBuf {
        self.state_dir.join(MANAGED_PROVIDER_STATE_FILE)
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
                    "failed to open private managed provider state: {error}"
                )))
            }
        };
        let length = file
            .metadata()
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to inspect managed provider state: {error}"
                ))
            })?
            .len();
        if length > MAX_PROVIDER_STATE_BYTES {
            return Err(DurableRunnerError::invalid(
                "managed provider state exceeds the 16 MiB limit",
            ));
        }
        let mut bytes = Vec::with_capacity(length as usize);
        file.read_to_end(&mut bytes).map_err(|error| {
            DurableRunnerError::invalid(format!("failed to read managed provider state: {error}"))
        })?;
        let state: ManagedDurableState = serde_json::from_slice(&bytes).map_err(|error| {
            DurableRunnerError::invalid(format!("managed provider state is malformed: {error}"))
        })?;
        state.validate(&self.config)?;
        self.state = Some(state);
        self.restore_provider_if_needed()
    }

    fn restore_provider_if_needed(&mut self) -> Result<(), DurableRunnerError> {
        if self.provider.is_some() {
            return Ok(());
        }
        let Some(state) = self.state.as_ref() else {
            return Ok(());
        };
        if !matches!(
            state.lifecycle.as_str(),
            "session_opening" | "session_open" | "turn_starting" | "turn_active" | "suspended"
        ) {
            return Ok(());
        }
        if !state.ambiguous_tool_deliveries.is_empty() {
            return Err(DurableRunnerError::invalid(
                "managed tool-result delivery is ambiguous; recovery refuses to redeliver it",
            ));
        }
        let active = state.active_turn_id.clone();
        if active.is_some() && state.descriptor.kind() == ManagedProviderKind::AwsAgentcore {
            let state = self
                .state
                .as_mut()
                .expect("managed state remains present during recovery");
            let prior_turn = state.active_turn_id.take();
            state.lifecycle = "failed".to_owned();
            state.push(NormalizedProviderEvent {
                event_type: "turn.failed".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": "aws_agentcore",
                    "providerTurnId": prior_turn,
                    "status": "failed",
                    "providerTerminalObserved": false,
                    "code": "agentcore_active_turn_recovery_requires_review",
                }),
            })?;
            let terminal = terminal_events(state, "turn.failed");
            for event in terminal {
                state.push(event)?;
            }
            self.save_state()?;
            return Ok(());
        }
        let recovering_remote = self
            .state
            .as_ref()
            .and_then(|state| state.provider_session_id.as_ref())
            .is_some();
        let mut provider = match self.start_provider(recovering_remote) {
            Ok(provider) => provider,
            Err(start_error) => {
                if let Some(skills) = start_error.claude_durable_skills {
                    let state = self
                        .state
                        .as_mut()
                        .expect("managed state remains present during recovery");
                    state.claude_managed_skills = Some(skills);
                    state.claude_managed_skill_cleanup = None;
                    state.provider_session_id = start_error.recovery_session_id;
                    self.save_state()?;
                } else if let Some(inventory) = start_error.claude_skill_cleanup {
                    let state = self
                        .state
                        .as_mut()
                        .expect("managed state remains present during recovery");
                    state.claude_managed_skills = None;
                    state.claude_managed_skill_cleanup =
                        (!inventory.is_empty()).then_some(inventory);
                    self.save_state()?;
                }
                return Err(start_error.error);
            }
        };
        if let Some(state) = self.state.as_mut() {
            state.claude_managed_skill_cleanup = None;
        }
        if let Some(turn_id) = active.as_deref() {
            provider.restore_active_turn(turn_id).map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to restore managed active turn: {error}"
                ))
            })?;
        }
        let session_id = provider.session_identity().to_owned();
        let runtime = provider.runtime_identity();
        let state = self
            .state
            .as_mut()
            .expect("managed state remains present during recovery");
        state.provider_session_id = Some(session_id);
        state.lifecycle = if active.is_some() {
            "turn_active".to_owned()
        } else {
            "session_open".to_owned()
        };
        state.push(NormalizedProviderEvent {
            event_type: "session.resumed".to_owned(),
            priority: EventPriority::P0,
            payload: session_event_payload(&state.descriptor, &runtime),
        })?;
        self.provider = Some(provider);
        self.refresh_provider_checkpoint();
        self.save_state()
    }

    fn start_provider(
        &self,
        recovering: bool,
    ) -> Result<Box<dyn Provider>, ManagedProviderStartError> {
        let state = self.state.as_ref().ok_or_else(|| {
            ManagedProviderStartError::plain(DurableRunnerError::invalid(
                "managed provider has not been prepared",
            ))
        })?;
        let ownership_scope = format!("{}:{}", state.run_id, state.normalized_session_id);
        let mut provider = self.factory.start(
            &state.descriptor,
            state.tool_set.operations.clone(),
            &ownership_scope,
            recovering
                .then(|| state.provider_session_id.as_deref())
                .flatten(),
            recovering
                .then(|| state.durable_event_cursor.as_deref())
                .flatten(),
            state.model_request_count,
            state.provider_usage.as_ref(),
            state.claude_managed_skills.as_deref(),
            state.claude_managed_skill_cleanup.as_deref(),
        )?;
        if recovering {
            if let Some(expected) = state.provider_session_id.as_deref() {
                if provider.session_identity() != expected {
                    let _ = provider.shutdown();
                    return Err(ManagedProviderStartError::plain(
                        DurableRunnerError::invalid(
                            "managed provider resumed a different remote session",
                        ),
                    ));
                }
            }
            for call in state.pending_tool_calls.values() {
                provider
                    .restore_pending_tool_call(&call.call_id, &call.operation_id, &call.input)
                    .map_err(|error| {
                        ManagedProviderStartError::plain(DurableRunnerError::invalid(format!(
                            "failed to restore managed tool call: {error}"
                        )))
                    })?;
            }
        }
        Ok(provider)
    }

    fn refresh_provider_checkpoint(&mut self) {
        let Some(provider) = self.provider.as_ref() else {
            return;
        };
        let Some(state) = self.state.as_mut() else {
            return;
        };
        state.provider_session_id = provider.provider_session_id().map(str::to_owned);
        state.durable_event_cursor = provider.durable_event_cursor().map(str::to_owned);
        if let Some(count) = provider.model_request_count() {
            state.model_request_count = count;
        }
        if let Some(usage) = provider.usage_snapshot() {
            state.provider_usage = Some(usage);
        }
        if let Some(skills) = provider.claude_managed_skills() {
            state.claude_managed_skills = Some(skills.to_vec());
        }
    }

    fn save_state(&self) -> Result<(), DurableRunnerError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("managed provider state is unavailable"))?;
        state.validate(&self.config)?;
        secure_directory(&self.state_dir, "managed provider state")?;
        let path = self.state_path();
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to serialize managed provider state: {error}"
            ))
        })?;
        if bytes.len() as u64 > MAX_PROVIDER_STATE_BYTES {
            return Err(DurableRunnerError::invalid(
                "managed provider state exceeds the 16 MiB limit",
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
                "failed to atomically replace managed provider state: {error}"
            )));
        }
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to protect managed provider state: {error}"
            ))
        })?;
        Ok(())
    }

    fn prepare(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let descriptor = ManagedProviderDescriptor::parse(
            payload
                .get("provider")
                .cloned()
                .ok_or_else(|| DurableRunnerError::invalid("run.prepare requires provider"))?,
        )?;
        descriptor.validate()?;
        let tool_set = authorized_tool_set(payload)?;
        let completion_contract = completion_contract(payload)?;
        if let Some(state) = self.state.as_ref() {
            if state.descriptor != descriptor
                || state.tool_set != tool_set
                || state.completion_contract != completion_contract
            {
                return Err(DurableRunnerError::invalid(
                    "managed provider profile, tools, or completion contract changed across the durable run",
                ));
            }
            if state.lifecycle == "closed" {
                return Err(DurableRunnerError::invalid(
                    "managed provider session is already closed",
                ));
            }
        } else {
            self.state = Some(ManagedDurableState::new(
                self.config.run_id.clone(),
                self.config.normalized_session_id.clone(),
                descriptor,
                tool_set,
                completion_contract,
            ));
            self.save_state()?;
        }
        let state = self
            .state
            .as_ref()
            .expect("managed state exists after prepare");
        Ok(CommandExecution::result(json!({
            "status": "prepared",
            "provider": state.descriptor.provider_label(),
            "driver": state.descriptor.driver(),
        })))
    }

    fn open_session(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        if self.provider.is_none() {
            let kind = self
                .state
                .as_ref()
                .ok_or_else(|| {
                    DurableRunnerError::invalid("managed provider has not been prepared")
                })?
                .descriptor
                .kind();
            let lifecycle = self
                .state
                .as_ref()
                .expect("managed state exists")
                .lifecycle
                .clone();
            if lifecycle == "prepared" {
                let state = self.state.as_mut().expect("managed state exists");
                state.lifecycle = "session_opening".to_owned();
                if kind == ManagedProviderKind::AwsAgentcore {
                    state.provider_session_id =
                        Some(format!("paperclip-{}-{}", Uuid::new_v4(), Uuid::new_v4()));
                }
                self.save_state()?;
            } else if !matches!(
                lifecycle.as_str(),
                "session_opening" | "session_open" | "suspended"
            ) {
                return Err(DurableRunnerError::invalid(
                    "managed provider session cannot be opened from its current lifecycle",
                ));
            }
            let recovering = self
                .state
                .as_ref()
                .and_then(|state| state.provider_session_id.as_ref())
                .is_some();
            match self.start_provider(recovering) {
                Ok(provider) => {
                    if let Some(state) = self.state.as_mut() {
                        state.claude_managed_skill_cleanup = None;
                    }
                    self.provider = Some(provider);
                }
                Err(start_error) => {
                    if let Some(skills) = start_error.claude_durable_skills {
                        let state = self.state.as_mut().expect("managed state exists");
                        state.claude_managed_skills = Some(skills);
                        state.claude_managed_skill_cleanup = None;
                        state.provider_session_id = start_error.recovery_session_id;
                        self.save_state()?;
                    } else if let Some(inventory) = start_error.claude_skill_cleanup {
                        let state = self.state.as_mut().expect("managed state exists");
                        state.claude_managed_skills = None;
                        state.claude_managed_skill_cleanup =
                            (!inventory.is_empty()).then_some(inventory);
                        self.save_state()?;
                    }
                    return Err(start_error.error);
                }
            }
        }
        let provider = self
            .provider
            .as_ref()
            .expect("managed provider exists after open");
        let session_id = provider.session_identity().to_owned();
        let runtime = provider.runtime_identity();
        let resumed = self
            .state
            .as_ref()
            .and_then(|state| state.provider_session_id.as_deref())
            .is_some_and(|expected| expected == session_id);
        let state = self
            .state
            .as_mut()
            .expect("managed state exists after open");
        state.provider_session_id = Some(session_id.clone());
        state.active_turn_id = None;
        state.lifecycle = "session_open".to_owned();
        let payload = session_event_payload(&state.descriptor, &runtime);
        let provider_label = state.descriptor.provider_label();
        let driver = state.descriptor.driver();
        let version = state.descriptor.version().to_owned();
        self.refresh_provider_checkpoint();
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({
                "status": if resumed { "resumed" } else { "started" },
                "provider": provider_label,
                "driver": driver,
                "providerVersion": version,
                "providerSessionId": session_id,
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
            .filter(|value| !value.is_empty() && value.len() <= MAX_INSTRUCTIONS_BYTES)
            .ok_or_else(|| {
                DurableRunnerError::invalid("turn.start payload.text is required and bounded")
            })?;
        if self.provider.is_none() {
            self.open_session()?;
        }
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("managed provider is not prepared"))?;
        if state.lifecycle != "session_open"
            || !state.pending_tool_calls.is_empty()
            || !state.ambiguous_tool_deliveries.is_empty()
        {
            return Err(DurableRunnerError::invalid(
                "managed provider cannot start a turn while prior work is unsettled",
            ));
        }
        let preflight = self
            .provider
            .as_mut()
            .expect("managed provider exists before turn preflight")
            .preflight_turn();
        // A conservative AgentCore reconciliation must become durable even
        // when the resulting ceiling gate rejects this turn. It emits no
        // event after the prior terminal and is idempotent across restart.
        self.refresh_provider_checkpoint();
        self.save_state()?;
        preflight.map_err(|error| {
            DurableRunnerError::invalid(format!("managed turn preflight failed: {error}"))
        })?;
        let state = self
            .state
            .as_mut()
            .expect("managed state exists after turn preflight");
        let turn_id = self.config.turn_id.clone();
        state.lifecycle = "turn_starting".to_owned();
        state.active_turn_id = Some(turn_id.clone());
        state.last_agent_message = None;
        self.save_state()?;
        let response = self
            .provider
            .as_mut()
            .expect("managed provider exists before turn start")
            .start_turn(text, "", &turn_id)
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "managed turn start is ambiguous and recovery must reconcile it: {error}"
                ))
            })?;
        let state = self
            .state
            .as_mut()
            .expect("managed state exists after start");
        state.lifecycle = "turn_active".to_owned();
        self.refresh_provider_checkpoint();
        self.save_state()?;
        Ok(CommandExecution::result(json!({
            "status": "started",
            "providerTurnId": turn_id,
            "providerResponse": sanitize_value(&response),
        })))
    }

    fn interrupt_turn(&mut self, reason: &str) -> Result<CommandExecution, DurableRunnerError> {
        self.restore_provider_if_needed()?;
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
        self.provider
            .as_mut()
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "managed active turn has no recoverable provider connection",
                )
            })?
            .interrupt_turn(&turn_id)
            .map_err(|error| {
                DurableRunnerError::invalid(format!("managed turn interrupt is ambiguous: {error}"))
            })?;
        self.refresh_provider_checkpoint();
        self.save_state()?;
        Ok(CommandExecution::result(json!({
            "status": "interrupt_requested",
            "reason": reason,
            "providerTurnId": turn_id,
        })))
    }

    fn deliver_tool_result(
        &mut self,
        payload: &Value,
    ) -> Result<CommandExecution, DurableRunnerError> {
        let result: ToolResult = serde_json::from_value(payload.clone()).map_err(|error| {
            DurableRunnerError::invalid(format!("semantic tool result is invalid: {error}"))
        })?;
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("managed provider is not prepared"))?;
        let pending = state
            .pending_tool_calls
            .get(&result.call_id)
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "managed tool result does not match a pending tool call",
                )
            })?;
        if pending.operation_id != result.operation_id {
            return Err(DurableRunnerError::invalid(
                "managed tool result operation conflicts with the pending tool call",
            ));
        }
        if state
            .ambiguous_tool_deliveries
            .contains_key(&result.call_id)
        {
            return Err(DurableRunnerError::invalid(
                "managed tool-result delivery is ambiguous; refusing duplicate delivery",
            ));
        }
        self.state
            .as_mut()
            .expect("managed state exists")
            .ambiguous_tool_deliveries
            .insert(result.call_id.clone(), result.clone());
        self.save_state()?;
        self.provider
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("managed provider is unavailable"))?
            .deliver_tool_result(&result)
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "managed tool-result delivery is ambiguous: {error}"
                ))
            })?;
        let state = self.state.as_mut().expect("managed state exists");
        state.pending_tool_calls.remove(&result.call_id);
        state.ambiguous_tool_deliveries.remove(&result.call_id);
        self.refresh_provider_checkpoint();
        self.save_state()?;
        Ok(CommandExecution::result(json!({
            "status": "delivered",
            "callId": result.call_id,
        })))
    }

    fn change_budget(&mut self, payload: &Value) -> Result<CommandExecution, DurableRunnerError> {
        let value = payload
            .get("maximumCostUsd")
            .or_else(|| payload.get("maxSessionListCostUsd"))
            .or_else(|| payload.get("maxEstimatedSessionCostUsd"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or_else(|| {
                DurableRunnerError::invalid("managed budget raise requires maximumCostUsd")
            })?;
        self.restore_provider_if_needed()?;
        let response = self
            .provider
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("managed provider is unavailable"))?
            .increase_budget(value)
            .map_err(|error| {
                DurableRunnerError::invalid(format!("managed budget raise failed: {error}"))
            })?;
        self.state
            .as_mut()
            .expect("managed state exists")
            .descriptor
            .set_budget(value);
        self.save_state()?;
        Ok(CommandExecution::result(sanitize_value(&response)))
    }

    fn snapshot(&self) -> Result<CommandExecution, DurableRunnerError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| DurableRunnerError::invalid("managed provider is not prepared"))?;
        Ok(CommandExecution::result(json!({
            "status": state.lifecycle,
            "provider": state.descriptor.provider_label(),
            "driver": state.descriptor.driver(),
            "providerSessionId": state.provider_session_id,
            "activeProviderTurnId": state.active_turn_id,
            "durableEventCursor": state.durable_event_cursor,
        })))
    }

    fn suspend(&mut self) -> Result<CommandExecution, DurableRunnerError> {
        if let Some(provider) = self.provider.as_mut() {
            provider.shutdown().map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to suspend managed provider connection: {error}"
                ))
            })?;
        }
        self.refresh_provider_checkpoint();
        self.provider = None;
        if let Some(state) = self.state.as_mut() {
            if state.active_turn_id.is_none() {
                state.lifecycle = "suspended".to_owned();
            }
            self.save_state()?;
        }
        Ok(CommandExecution::result(json!({"status": "completed"})))
    }

    fn close_session(&mut self, destroy: bool) -> Result<CommandExecution, DurableRunnerError> {
        if destroy {
            self.restore_provider_if_needed()?;
            self.provider
                .as_mut()
                .ok_or_else(|| DurableRunnerError::invalid("managed provider is unavailable"))?
                .destroy_session()
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "managed remote session deletion failed: {error}"
                    ))
                })?;
        } else if let Some(provider) = self.provider.as_mut() {
            provider.shutdown().map_err(|error| {
                DurableRunnerError::invalid(format!("managed session close failed: {error}"))
            })?;
        }
        self.provider = None;
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("managed provider is not prepared"))?;
        state.lifecycle = "closed".to_owned();
        state.active_turn_id = None;
        let session_id = state.provider_session_id.clone();
        let provider_label = state.descriptor.provider_label();
        self.save_state()?;
        Ok(CommandExecution {
            result: json!({
                "status": "closed",
                "destroyed": destroy,
                "providerSessionId": session_id,
            }),
            events: vec![(
                "session.closed".to_owned(),
                EventPriority::P0,
                json!({
                    "provider": provider_label,
                    "providerSessionId": session_id,
                    "remoteStateDestroyed": destroy,
                }),
            )],
        })
    }

    fn poll_provider(&mut self) -> Result<(), DurableRunnerError> {
        self.restore()?;
        if self
            .state
            .as_ref()
            .is_some_and(|state| !state.pending_events.is_empty())
            || self.provider.is_none()
        {
            return Ok(());
        }
        for _ in 0..MAX_EVENTS_PER_POLL {
            let event = match self
                .provider
                .as_mut()
                .expect("managed provider remains present while polling")
                .poll()
            {
                Ok(event) => event,
                Err(error) => {
                    self.fail_provider(format!("managed provider failed: {error}"))?;
                    break;
                }
            };
            let Some(event) = event else {
                break;
            };
            self.project_event(event)?;
            self.refresh_provider_checkpoint();
            self.save_state()?;
        }
        Ok(())
    }

    fn project_event(&mut self, event: ProviderEvent) -> Result<(), DurableRunnerError> {
        let state = self
            .state
            .as_mut()
            .expect("managed state exists while projecting provider events");
        match event {
            ProviderEvent::ToolCall {
                call_id,
                operation_id,
                input,
            } => {
                let pending = PendingToolCall {
                    call_id: call_id.clone(),
                    operation_id: operation_id.clone(),
                    input: input.clone(),
                };
                if let Some(existing) = state.pending_tool_calls.get(&call_id) {
                    if existing != &pending {
                        return Err(DurableRunnerError::invalid(
                            "managed provider reused a tool-call ID with conflicting content",
                        ));
                    }
                    return Ok(());
                }
                if state.pending_tool_calls.len() >= MAX_PENDING_CALLS {
                    return Err(DurableRunnerError::invalid(
                        "managed provider pending tool-call limit reached",
                    ));
                }
                state.pending_tool_calls.insert(call_id.clone(), pending);
                state.push(semantic_input_event(
                    &self.config,
                    &call_id,
                    &operation_id,
                    &input,
                ))?;
            }
            ProviderEvent::Notification { method, params } => {
                if method == "item/completed" {
                    let item = params.get("item").unwrap_or(&params);
                    if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                        state.last_agent_message = item
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                            .map(|value| value.chars().take(1_000_000).collect());
                    }
                }
                if method == "thread/tokenUsage/updated" {
                    state.push(managed_usage_event(&state.descriptor, &params))?;
                    state.model_request_count =
                        usage_request_count(&params).unwrap_or(state.model_request_count);
                    return Ok(());
                }
                if method == "provider/budgetReached" {
                    state.push(NormalizedProviderEvent {
                        event_type: "provider.notice.recorded".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({
                            "schema": "paperclip.provider.notice.v1",
                            "noticeId": format!("{}-budget-limit", state.descriptor.provider_label()),
                            "severity": "error",
                            "category": "provider_limit",
                            "scope": "turn",
                            "recoverable": true,
                            "userActionable": true,
                            "summary": format!("{} reached its configured provider limit.", state.descriptor.display_name()),
                            "details": sanitize_value(&params),
                        }),
                    })?;
                    let prior_turn = state.active_turn_id.take();
                    state.lifecycle = "session_open".to_owned();
                    state.push(NormalizedProviderEvent {
                        event_type: "turn.failed".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({
                            "provider": state.descriptor.provider_label(),
                            "providerTurnId": prior_turn,
                            "status": "failed",
                            "stopReason": params.get("stopReason"),
                            "code": "provider_limit_reached",
                        }),
                    })?;
                    for event in terminal_events(state, "turn.failed") {
                        state.push(event)?;
                    }
                    return Ok(());
                }
                if method == "provider/reconnecting" {
                    state.push(NormalizedProviderEvent {
                        event_type: "provider.notice.recorded".to_owned(),
                        priority: EventPriority::P1,
                        payload: json!({
                            "schema": "paperclip.provider.notice.v1",
                            "noticeId": format!("{}-reconnecting", state.descriptor.provider_label()),
                            "severity": "warning",
                            "category": "reconnecting",
                            "scope": "session",
                            "recoverable": true,
                            "userActionable": false,
                            "summary": format!("{} is reconnecting.", state.descriptor.display_name()),
                        }),
                    })?;
                    return Ok(());
                }
                let mut normalized = normalize_codex_notification(&method, &params);
                let terminal = normalized.iter().find_map(|event| {
                    matches!(
                        event.event_type.as_str(),
                        "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.interrupted"
                    )
                    .then(|| event.event_type.clone())
                });
                for event in &mut normalized {
                    if let Some(object) = event.payload.as_object_mut() {
                        object.insert(
                            "provider".to_owned(),
                            Value::String(state.descriptor.provider_label().to_owned()),
                        );
                    }
                }
                for event in normalized {
                    state.push(event)?;
                }
                if let Some(event_type) = terminal {
                    state.active_turn_id = None;
                    state.lifecycle = "session_open".to_owned();
                    for event in terminal_events(state, &event_type) {
                        state.push(event)?;
                    }
                }
            }
            ProviderEvent::SemanticResult { result, .. } => {
                state.push(NormalizedProviderEvent {
                    event_type: "run.result.proposed".to_owned(),
                    priority: EventPriority::P0,
                    payload: sanitize_value(&result),
                })?;
            }
            ProviderEvent::RuntimeRequest {
                request_id,
                request_kind,
                title,
                details,
            } => {
                state.push(NormalizedProviderEvent {
                    event_type: "runtime_request.created".to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({
                        "request": {
                            "schema": "paperclip.runtime_request.v2",
                            "requestKind": request_kind,
                            "requestId": request_id,
                            "turnId": self.config.turn_id,
                            "itemId": self.config.item_id,
                            "type": "input",
                            "status": "pending",
                            "prompt": title,
                            "input": sanitize_value(&details),
                            "origin": {
                                "adapter": state.descriptor.driver(),
                                "provider": state.descriptor.provider_label(),
                                "method": "remote_runtime_request",
                            },
                        },
                    }),
                })?;
            }
            ProviderEvent::Exited => {
                self.fail_provider("managed provider exited unexpectedly".to_owned())?;
            }
        }
        Ok(())
    }

    fn fail_provider(&mut self, message: String) -> Result<(), DurableRunnerError> {
        self.provider = None;
        let state = self
            .state
            .as_mut()
            .expect("managed state exists while failing provider");
        let active = state.active_turn_id.take();
        state.lifecycle = "failed".to_owned();
        state.push(NormalizedProviderEvent {
            event_type: "session.failed".to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "provider": state.descriptor.provider_label(),
                "code": "managed_provider_failed",
                "message": message,
            }),
        })?;
        if active.is_some() {
            state.push(NormalizedProviderEvent {
                event_type: "turn.failed".to_owned(),
                priority: EventPriority::P0,
                payload: json!({
                    "provider": state.descriptor.provider_label(),
                    "providerTurnId": active,
                    "status": "failed",
                    "code": "managed_provider_failed",
                }),
            })?;
            for event in terminal_events(state, "turn.failed") {
                state.push(event)?;
            }
        }
        self.save_state()
    }
}

impl CommandExecutor for ManagedProviderCommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        self.restore()?;
        match command.command_type.as_str() {
            "run.prepare" => self.prepare(&command.payload),
            "run.attach" => {
                if self.state.is_none() && command.payload.get("provider").is_some() {
                    self.prepare(&command.payload)?;
                }
                let mut execution = self.open_session()?;
                let provider = self
                    .state
                    .as_ref()
                    .expect("managed state exists after attach")
                    .descriptor
                    .provider_label();
                execution.events.push((
                    "run.attached".to_owned(),
                    EventPriority::P0,
                    json!({"provider": provider}),
                ));
                Ok(execution)
            }
            "session.open" => self.open_session(),
            "turn.start" => self.start_turn(&command.payload),
            "turn.steer" => Ok(CommandExecution::result(json!({
                "status": "rejected",
                "code": "provider_command_unavailable",
                "message": "managed providers do not support active-turn steering",
            }))),
            "turn.interrupt" | "turn.stop" | "run.cancel" => {
                self.interrupt_turn(&command.command_type)
            }
            "semantic_tool.result" => self.deliver_tool_result(&command.payload),
            "provider.budget.raise" => self.change_budget(&command.payload),
            "session.snapshot" => self.snapshot(),
            "session.close" => self.close_session(false),
            "session.destroy" => self.close_session(true),
            "runner.suspend" | "runner.shutdown" => self.suspend(),
            "runner.drain" => Ok(CommandExecution::result(json!({"status": "completed"}))),
            _ => Ok(CommandExecution::result(json!({
                "status": "rejected",
                "code": "provider_command_unavailable",
                "message": "the managed provider does not implement this command",
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
            .ok_or_else(|| DurableRunnerError::invalid("managed provider state is unavailable"))?;
        if count > state.pending_events.len() {
            return Err(DurableRunnerError::invalid(
                "managed event acknowledgement exceeded the pending prefix",
            ));
        }
        state.pending_events.drain(..count);
        self.save_state()
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        // A replacement runner has no live provider object until durable state
        // is restored. Require that restoration before accepting terminal
        // cleanup so a persisted remote session cannot be abandoned silently.
        self.restore()?;
        if let Some(provider) = self.provider.as_mut() {
            provider.shutdown().map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to stop managed provider connection: {error}"
                ))
            })?;
        }
        self.provider = None;
        Ok(())
    }
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

fn authorized_tool_set(payload: &Value) -> Result<AuthorizedToolSet, DurableRunnerError> {
    if let Some(value) = payload.get("authorizedTools") {
        let tool_set: AuthorizedToolSet =
            serde_json::from_value(value.clone()).map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "run.prepare authorizedTools is invalid: {error}"
                ))
            })?;
        if tool_set.schema != TOOL_SET_SCHEMA
            || tool_set.schema_version != 1
            || tool_set.operations.len() > MAX_PENDING_CALLS
            || authorized_tool_catalog_digest(&tool_set.operations)
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?
                != tool_set.catalog_digest
        {
            return Err(DurableRunnerError::invalid(
                "run.prepare authorizedTools failed its closed catalog contract",
            ));
        }
        return Ok(tool_set);
    }
    let operations = Vec::new();
    let catalog_digest = authorized_tool_catalog_digest(&operations)
        .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
    Ok(AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest,
        operations,
    })
}

fn semantic_input_event(
    config: &DurableRunnerConfig,
    call_id: &str,
    operation_id: &str,
    input: &Value,
) -> NormalizedProviderEvent {
    let safe_input = sanitize_value(input);
    NormalizedProviderEvent {
        event_type: "semantic_tool.input".to_owned(),
        priority: EventPriority::P0,
        payload: json!({
            "semantic_tool": {
                "schema": "paperclip.prp.semantic_tool.v1",
                "schemaVersion": 1,
                "phase": "input",
                "operationId": operation_id,
                "callId": call_id,
                "correlation": {
                    "runId": config.run_id,
                    "normalizedSessionId": config.normalized_session_id,
                    "turnId": config.turn_id,
                    "itemId": config.item_id,
                },
                "idempotencyKey": Value::Null,
                "content": {
                    "digest": semantic_value_digest(&safe_input),
                    "redactionDisposition": "digest_only",
                    "references": [],
                },
                "input": safe_input,
            },
        }),
    }
}

fn terminal_events(state: &ManagedDurableState, event_type: &str) -> Vec<NormalizedProviderEvent> {
    let Some(contract) = state.completion_contract.as_ref() else {
        return Vec::new();
    };
    let succeeded = event_type == "turn.completed";
    let cancelled = matches!(event_type, "turn.cancelled" | "turn.interrupted");
    let disposition = if succeeded { "done" } else { "needs_review" };
    let provider = state.descriptor.provider_label();
    let display_name = state.descriptor.display_name();
    let summary = state.last_agent_message.clone().unwrap_or_else(|| {
        if succeeded {
            format!("{display_name} completed the requested work.")
        } else if cancelled {
            format!("The {display_name} run stopped before it completed.")
        } else {
            format!("The {display_name} run failed before it completed.")
        }
    });
    let evidence_ref = format!("provider:{provider}:agent-message");
    let criteria = contract
        .criterion_ids
        .iter()
        .map(|criterion_id| {
            json!({
                "criterionId": criterion_id,
                "status": if succeeded { "satisfied" } else { "unknown" },
                "evidenceRefs": if succeeded { vec![evidence_ref.as_str()] } else { Vec::<&str>::new() },
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
                "description": format!("Review the stopped {display_name} run and continue the task."),
                "blocksCompletion": true,
            })] },
        },
        "evidence": if succeeded { vec![json!({ "ref": evidence_ref })] } else { Vec::<Value>::new() },
        "verification": [],
        "attentionRequests": if succeeded { Vec::<Value>::new() } else { vec![json!({
            "kind": "review",
            "summary": format!("Review the stopped {display_name} run before continuing."),
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
    vec![
        NormalizedProviderEvent {
            event_type: "run.result.proposed".to_owned(),
            priority: EventPriority::P0,
            payload: result,
        },
        NormalizedProviderEvent {
            event_type: "run.terminal".to_owned(),
            priority: EventPriority::P0,
            payload: json!({
                "schema": "paperclip.prp.terminal.v1",
                "provider": provider,
                "turnTerminalState": turn_terminal_state,
                "runTerminalState": if succeeded { "succeeded" } else if cancelled { "cancelled" } else { "failed" },
                "reportedWorkDisposition": disposition,
            }),
        },
    ]
}

fn usage_request_count(params: &Value) -> Option<u64> {
    params
        .pointer("/usage/requestCount")
        .or_else(|| params.get("requestCount"))
        .and_then(Value::as_u64)
}

fn managed_usage_event(
    descriptor: &ManagedProviderDescriptor,
    params: &Value,
) -> NormalizedProviderEvent {
    let usage = params.get("usage").unwrap_or(params);
    let nonnegative_integer =
        |value: Option<&Value>| value.and_then(Value::as_i64).unwrap_or(0).max(0);
    let integer = |camel: &str, snake: &str| {
        nonnegative_integer(usage.get(camel).or_else(|| usage.get(snake)))
    };
    let cache_write_tokens = usage
        .get("cache_creation")
        .and_then(Value::as_object)
        .map(|cache_creation| {
            nonnegative_integer(cache_creation.get("ephemeral_1h_input_tokens")).saturating_add(
                nonnegative_integer(cache_creation.get("ephemeral_5m_input_tokens")),
            )
        })
        .unwrap_or_else(|| integer("cacheWriteInputTokens", "cache_write_input_tokens"));
    let provider_cost_usd = usage
        .get("estimatedCostUsd")
        .and_then(Value::as_f64)
        .or_else(|| {
            usage
                .pointer("/list_cost/amount")
                .or_else(|| usage.pointer("/listCost/amount"))
                .and_then(|value| value.as_str().and_then(|value| value.parse::<f64>().ok()))
                .map(|cents| cents / 100.0)
        })
        .unwrap_or(0.0)
        .max(0.0);
    let measurement = json!({
        "inputTokens": integer("inputTokens", "input_tokens"),
        "outputTokens": integer("outputTokens", "output_tokens"),
        "cacheReadTokens": integer("cacheReadInputTokens", "cache_read_input_tokens"),
        "cacheWriteTokens": cache_write_tokens,
        "activeSeconds": usage.get("activeSeconds").or_else(|| usage.get("active_seconds")).and_then(Value::as_f64).unwrap_or(0.0).max(0.0),
        "requests": usage_request_count(params).unwrap_or(0),
        "providerCostUsd": provider_cost_usd,
    });
    NormalizedProviderEvent {
        event_type: "usage.reported".to_owned(),
        priority: EventPriority::P0,
        payload: json!({
            "provider": descriptor.provider_label(),
            "model": descriptor.model(),
            "providerSessionId": Value::Null,
            "providerRequestId": descriptor.kind().eq(&ManagedProviderKind::AwsAgentcore).then(|| params.get("invocationId")).flatten(),
            "cumulative": measurement,
            "runDeltaAvailable": false,
            "runDelta": Value::Null,
            "costSource": if descriptor.kind() == ManagedProviderKind::AwsAgentcore { "paperclip_estimate" } else { "provider_reported" },
        }),
    }
}

fn session_event_payload(
    descriptor: &ManagedProviderDescriptor,
    runtime: &ProviderRuntimeIdentity,
) -> Value {
    let session_id = match runtime {
        ProviderRuntimeIdentity::RemoteService {
            provider_session_id,
            ..
        } => provider_session_id,
    };
    json!({
        "provider": descriptor.provider_label(),
        "driver": descriptor.driver(),
        "providerDescriptor": {
            "provider": descriptor.provider_label(),
            "driver": descriptor.driver(),
            "providerVersion": descriptor.version(),
            "model": descriptor.model(),
            "executionKind": "remote_service",
            "providerSessionId": session_id,
        },
        "runtimeIdentity": runtime,
        "threadId": session_id,
        "providerSessionId": session_id,
        "sessionId": session_id,
        "providerAccountSessionId": session_id,
        "processId": Value::Null,
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    struct FakeProvider {
        session_id: String,
        usage: Value,
        max_estimated_cost_usd: f64,
    }

    impl Provider for FakeProvider {
        fn kind(&self) -> crate::managed_provider::ProviderKind {
            crate::managed_provider::ProviderKind::AwsAgentcore
        }

        fn runtime_identity(&self) -> ProviderRuntimeIdentity {
            ProviderRuntimeIdentity::RemoteService {
                service: "aws_bedrock_agentcore_harness".to_owned(),
                provider_session_id: self.session_id.clone(),
                process_id: None,
            }
        }

        fn session_identity(&self) -> &str {
            &self.session_id
        }

        fn provider_session_id(&self) -> Option<&str> {
            Some(&self.session_id)
        }

        fn model_request_count(&self) -> Option<u64> {
            self.usage.get("requestCount").and_then(Value::as_u64)
        }

        fn usage_snapshot(&self) -> Option<Value> {
            Some(self.usage.clone())
        }

        fn increase_budget(
            &mut self,
            maximum_cost_usd: f64,
        ) -> Result<Value, crate::local_runner::LocalRunnerError> {
            if maximum_cost_usd <= self.max_estimated_cost_usd {
                return Err(crate::local_runner::LocalRunnerError::invalid(
                    "fake AgentCore budget must increase",
                ));
            }
            self.max_estimated_cost_usd = maximum_cost_usd;
            Ok(json!({ "maxEstimatedSessionCostUsd": maximum_cost_usd }))
        }

        fn preflight_turn(&mut self) -> Result<(), crate::local_runner::LocalRunnerError> {
            if self
                .usage
                .get(AGENTCORE_USAGE_RECONCILIATION_FIELD)
                .and_then(Value::as_str)
                == Some(AGENTCORE_USAGE_RECONCILIATION_PENDING)
            {
                let floor = self
                    .usage
                    .get(AGENTCORE_PENDING_CEILING_FIELD)
                    .and_then(Value::as_f64)
                    .unwrap_or(self.max_estimated_cost_usd)
                    .max(
                        self.usage
                            .get("estimatedCostUsd")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                    );
                let requests = self
                    .usage
                    .get("requestCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .saturating_add(1);
                self.usage["requestCount"] = json!(requests);
                self.usage["estimatedCostUsd"] = json!(floor);
                self.usage[AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD] = json!(floor);
                self.usage[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
                    json!(AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE);
                if let Some(usage) = self.usage.as_object_mut() {
                    usage.remove(AGENTCORE_PENDING_INVOCATION_FIELD);
                    usage.remove(AGENTCORE_PENDING_CEILING_FIELD);
                }
            }
            if self
                .usage
                .get("estimatedCostUsd")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                >= self.max_estimated_cost_usd
            {
                return Err(crate::local_runner::LocalRunnerError::invalid(
                    "AgentCore estimated session spend ceiling reached; raise it explicitly before continuing",
                ));
            }
            Ok(())
        }

        fn start_turn(
            &mut self,
            _message: &str,
            _cwd: &str,
            _turn_id: &str,
        ) -> Result<Value, crate::local_runner::LocalRunnerError> {
            Ok(json!({"started": true}))
        }

        fn interrupt_turn(
            &mut self,
            _turn_id: &str,
        ) -> Result<Value, crate::local_runner::LocalRunnerError> {
            Ok(json!({"interrupted": true}))
        }

        fn read(&mut self) -> Result<Value, crate::local_runner::LocalRunnerError> {
            Ok(json!({}))
        }

        fn poll(&mut self) -> Result<Option<ProviderEvent>, crate::local_runner::LocalRunnerError> {
            Ok(None)
        }

        fn deliver_tool_result(
            &mut self,
            _result: &ToolResult,
        ) -> Result<(), crate::local_runner::LocalRunnerError> {
            Ok(())
        }

        fn shutdown(&mut self) -> Result<(), crate::local_runner::LocalRunnerError> {
            Ok(())
        }
    }

    struct FakeFactory {
        observed_resume_usage: Arc<Mutex<Vec<Option<Value>>>>,
        usage: Value,
    }

    impl ManagedProviderFactory for FakeFactory {
        fn start(
            &self,
            descriptor: &ManagedProviderDescriptor,
            _tools: Vec<AuthorizedTool>,
            _ownership_scope: &str,
            resume_session_id: Option<&str>,
            _resume_event_cursor: Option<&str>,
            _resume_model_request_count: u64,
            resume_usage: Option<&Value>,
            _resume_claude_managed_skills: Option<&[ClaudeManagedSkillRef]>,
            _pending_claude_skill_cleanup: Option<&[ClaudeManagedSkillRef]>,
        ) -> Result<Box<dyn Provider>, ManagedProviderStartError> {
            self.observed_resume_usage
                .lock()
                .unwrap()
                .push(resume_usage.cloned());
            Ok(Box::new(FakeProvider {
                session_id: resume_session_id
                    .unwrap_or("managed-test-session")
                    .to_owned(),
                usage: resume_usage.cloned().unwrap_or_else(|| self.usage.clone()),
                max_estimated_cost_usd: match descriptor {
                    ManagedProviderDescriptor::AwsAgentcore(config) => {
                        config.max_estimated_session_cost_usd
                    }
                    ManagedProviderDescriptor::ClaudeManaged(_) => 1.0,
                },
            }))
        }
    }

    struct FakeClaudeProvider {
        session_id: String,
        skills: Vec<ClaudeManagedSkillRef>,
        destroy_failures: Arc<AtomicUsize>,
    }

    impl Provider for FakeClaudeProvider {
        fn kind(&self) -> crate::managed_provider::ProviderKind {
            crate::managed_provider::ProviderKind::ClaudeManaged
        }

        fn runtime_identity(&self) -> ProviderRuntimeIdentity {
            ProviderRuntimeIdentity::RemoteService {
                service: "anthropic_managed_agents".to_owned(),
                provider_session_id: self.session_id.clone(),
                process_id: None,
            }
        }

        fn session_identity(&self) -> &str {
            &self.session_id
        }

        fn provider_session_id(&self) -> Option<&str> {
            Some(&self.session_id)
        }

        fn claude_managed_skills(&self) -> Option<&[ClaudeManagedSkillRef]> {
            Some(&self.skills)
        }

        fn destroy_session(&mut self) -> Result<(), crate::local_runner::LocalRunnerError> {
            if self
                .destroy_failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Err(crate::local_runner::LocalRunnerError::invalid(
                    "injected owned-resource deletion failure",
                ));
            }
            Ok(())
        }

        fn start_turn(
            &mut self,
            _message: &str,
            _cwd: &str,
            _turn_id: &str,
        ) -> Result<Value, crate::local_runner::LocalRunnerError> {
            Ok(json!({"started": true}))
        }

        fn interrupt_turn(
            &mut self,
            _turn_id: &str,
        ) -> Result<Value, crate::local_runner::LocalRunnerError> {
            Ok(json!({"interrupted": true}))
        }

        fn read(&mut self) -> Result<Value, crate::local_runner::LocalRunnerError> {
            Ok(json!({}))
        }

        fn poll(&mut self) -> Result<Option<ProviderEvent>, crate::local_runner::LocalRunnerError> {
            Ok(None)
        }

        fn deliver_tool_result(
            &mut self,
            _result: &ToolResult,
        ) -> Result<(), crate::local_runner::LocalRunnerError> {
            Ok(())
        }

        fn shutdown(&mut self) -> Result<(), crate::local_runner::LocalRunnerError> {
            Ok(())
        }
    }

    struct FakeClaudeFactory {
        observed_resume_skills: Arc<Mutex<Vec<Option<Vec<ClaudeManagedSkillRef>>>>>,
        created_skills: Vec<ClaudeManagedSkillRef>,
        destroy_failures: Arc<AtomicUsize>,
    }

    impl ManagedProviderFactory for FakeClaudeFactory {
        fn start(
            &self,
            _descriptor: &ManagedProviderDescriptor,
            _tools: Vec<AuthorizedTool>,
            _ownership_scope: &str,
            resume_session_id: Option<&str>,
            _resume_event_cursor: Option<&str>,
            _resume_model_request_count: u64,
            _resume_usage: Option<&Value>,
            resume_claude_managed_skills: Option<&[ClaudeManagedSkillRef]>,
            _pending_claude_skill_cleanup: Option<&[ClaudeManagedSkillRef]>,
        ) -> Result<Box<dyn Provider>, ManagedProviderStartError> {
            self.observed_resume_skills
                .lock()
                .unwrap()
                .push(resume_claude_managed_skills.map(<[_]>::to_vec));
            Ok(Box::new(FakeClaudeProvider {
                session_id: resume_session_id.unwrap_or("claude-session-1").to_owned(),
                skills: resume_claude_managed_skills
                    .map(<[_]>::to_vec)
                    .unwrap_or_else(|| self.created_skills.clone()),
                destroy_failures: Arc::clone(&self.destroy_failures),
            }))
        }
    }

    struct FailThenRecoverClaudeFactory {
        calls: AtomicUsize,
        skills: Vec<ClaudeManagedSkillRef>,
        recovery_session_id: Option<String>,
        observed_resume: Arc<Mutex<Vec<(Option<String>, Option<Vec<ClaudeManagedSkillRef>>)>>>,
    }

    impl ManagedProviderFactory for FailThenRecoverClaudeFactory {
        fn start(
            &self,
            _descriptor: &ManagedProviderDescriptor,
            _tools: Vec<AuthorizedTool>,
            _ownership_scope: &str,
            resume_session_id: Option<&str>,
            _resume_event_cursor: Option<&str>,
            _resume_model_request_count: u64,
            _resume_usage: Option<&Value>,
            resume_claude_managed_skills: Option<&[ClaudeManagedSkillRef]>,
            _pending_claude_skill_cleanup: Option<&[ClaudeManagedSkillRef]>,
        ) -> Result<Box<dyn Provider>, ManagedProviderStartError> {
            self.observed_resume.lock().unwrap().push((
                resume_session_id.map(str::to_owned),
                resume_claude_managed_skills.map(<[_]>::to_vec),
            ));
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(ManagedProviderStartError {
                    error: DurableRunnerError::invalid("injected stream bootstrap failure"),
                    claude_skill_cleanup: None,
                    claude_durable_skills: Some(self.skills.clone()),
                    recovery_session_id: self.recovery_session_id.clone(),
                });
            }
            Ok(Box::new(FakeClaudeProvider {
                session_id: resume_session_id
                    .unwrap_or("claude-checkpointed-session")
                    .to_owned(),
                skills: resume_claude_managed_skills
                    .map(<[_]>::to_vec)
                    .unwrap_or_else(|| self.skills.clone()),
                destroy_failures: Arc::new(AtomicUsize::new(0)),
            }))
        }
    }

    fn test_config(state_dir: &Path) -> DurableRunnerConfig {
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
            acpx_launch_profile: None,
            opencode_launch_profile: None,
            max_outbox_bytes: 1024 * 1024,
            p0_reserve_bytes: 64 * 1024,
            max_frame_bytes: 1024 * 1024,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::from_secs(60),
        }
    }

    fn test_command(sequence: u64, command_type: &str, payload: Value) -> Command {
        Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: format!("command-{sequence}"),
            controller_seq: sequence,
            command_type: command_type.to_owned(),
            issued_at: "2026-09-01T00:00:00.000Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload,
        }
    }

    fn agentcore_prepare_payload() -> Value {
        let operations = Vec::new();
        json!({
            "authorizedTools": {
                "schema": TOOL_SET_SCHEMA,
                "schemaVersion": 1,
                "catalogDigest": authorized_tool_catalog_digest(&operations).unwrap(),
                "operations": operations,
            },
            "provider": {
                "kind": "aws_agentcore",
                "model": QUALIFIED_AGENTCORE_MODEL,
                "profileId": "profile-1",
                "region": "us-east-1",
                "accountId": "123456789012",
                "harnessArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/test",
                "harnessVersion": "1",
                "endpointArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/test",
                "endpointQualifier": "1",
                "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
                "memoryArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test",
                "memoryId": "memory-1",
                "invocationRoleArn": "arn:aws:iam::123456789012:role/runner",
                "contextBucket": "context-bucket",
                "contextPrefix": "companies/company/profiles/profile",
                "contextKmsKeyArn": "arn:aws:kms:us-east-1:123456789012:key/test",
                "qualificationRevision": QUALIFIED_AGENTCORE_REVISION,
                "eventExpiryDays": 90,
                "maxEstimatedSessionCostUsd": 1.0,
                "maxIterations": 8,
                "maxOutputTokens": 4096,
                "timeoutSeconds": 300,
                "instructions": "Complete the supplied task.",
                "runtimeContext": null,
            },
        })
    }

    fn claude_prepare_payload() -> Value {
        let operations = Vec::new();
        json!({
            "authorizedTools": {
                "schema": TOOL_SET_SCHEMA,
                "schemaVersion": 1,
                "catalogDigest": authorized_tool_catalog_digest(&operations).unwrap(),
                "operations": operations,
            },
            "provider": {
                "kind": "claude_managed",
                "model": QUALIFIED_CLAUDE_MODEL,
                "profileId": "profile-1",
                "anthropicAgentId": "agent-1",
                "agentVersion": "1",
                "environmentId": "environment-1",
                "betaVersion": QUALIFIED_CLAUDE_BETA,
                "maxSessionListCostUsd": 1.0,
                "instructions": "Complete the supplied task.",
                "runtimeContext": {
                    "instructions": {},
                    "skills": [{}]
                },
            },
        })
    }

    #[test]
    fn claude_usage_maps_nested_cache_creation_token_buckets() {
        let descriptor = ManagedProviderDescriptor::ClaudeManaged(ClaudeManagedProviderConfig {
            model: QUALIFIED_CLAUDE_MODEL.to_owned(),
            profile_id: "profile-1".to_owned(),
            anthropic_agent_id: "agent-1".to_owned(),
            agent_version: "version-1".to_owned(),
            environment_id: "environment-1".to_owned(),
            beta_version: QUALIFIED_CLAUDE_BETA.to_owned(),
            max_session_list_cost_usd: 1.0,
            instructions: "Complete the supplied task.".to_owned(),
            runtime_context: None,
        });
        let event = managed_usage_event(
            &descriptor,
            &json!({
                "usage": {
                    "input_tokens": 21,
                    "output_tokens": 8,
                    "cache_read_input_tokens": 13,
                    "cache_creation": {
                        "ephemeral_1h_input_tokens": 34,
                        "ephemeral_5m_input_tokens": 55
                    }
                },
                "requestCount": 2
            }),
        );

        assert_eq!(
            event.payload.pointer("/cumulative/cacheWriteTokens"),
            Some(&json!(89))
        );
    }

    #[test]
    fn agentcore_usage_snapshot_accepts_only_bounded_reconciliation_states() {
        let usage = json!({
            "inputTokens": 12,
            "outputTokens": 3,
            "cacheReadInputTokens": 4,
            "cacheWriteInputTokens": 5,
            "requestCount": 2,
            "estimatedCostUsd": 0.75,
            "costSource": "paperclip_estimate"
        });
        assert!(valid_agentcore_usage_snapshot(&usage));

        let mut observed = usage.clone();
        observed[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
            json!(AGENTCORE_USAGE_RECONCILIATION_OBSERVED);
        assert!(valid_agentcore_usage_snapshot(&observed));

        let mut pending = usage.clone();
        pending[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
            json!(AGENTCORE_USAGE_RECONCILIATION_PENDING);
        pending[AGENTCORE_PENDING_INVOCATION_FIELD] = json!("invocation-1");
        pending[AGENTCORE_PENDING_CEILING_FIELD] = json!(1.0);
        assert!(valid_agentcore_usage_snapshot(&pending));

        let mut conservative = usage.clone();
        conservative[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
            json!(AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE);
        conservative[AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD] = json!(0.75);
        assert!(valid_agentcore_usage_snapshot(&conservative));

        let mut orphan_pending_ceiling = usage.clone();
        orphan_pending_ceiling[AGENTCORE_PENDING_CEILING_FIELD] = json!(1.0);
        assert!(!valid_agentcore_usage_snapshot(&orphan_pending_ceiling));

        let mut orphan_floor = usage.clone();
        orphan_floor[AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD] = json!(0.75);
        assert!(!valid_agentcore_usage_snapshot(&orphan_floor));

        conservative["estimatedCostUsd"] = json!(0.74);
        assert!(!valid_agentcore_usage_snapshot(&conservative));
        conservative["estimatedCostUsd"] = json!(0.75);
        conservative
            .as_object_mut()
            .unwrap()
            .remove(AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD);
        assert!(!valid_agentcore_usage_snapshot(&conservative));

        pending[AGENTCORE_USAGE_RECONCILIATION_FIELD] = json!("unknown");
        assert!(!valid_agentcore_usage_snapshot(&pending));
        pending[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
            json!(AGENTCORE_USAGE_RECONCILIATION_PENDING);
        pending
            .as_object_mut()
            .unwrap()
            .remove(AGENTCORE_PENDING_INVOCATION_FIELD);
        assert!(!valid_agentcore_usage_snapshot(&pending));
    }

    #[test]
    fn durable_pending_agentcore_usage_is_charged_once_before_turn_admission() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-managed-provider-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let config = test_config(&directory);
        let usage = json!({
            "inputTokens": 12,
            "outputTokens": 3,
            "cacheReadInputTokens": 4,
            "cacheWriteInputTokens": 5,
            "requestCount": 2,
            "estimatedCostUsd": 0.75,
            "costSource": "paperclip_estimate",
            "usageReconciliation": AGENTCORE_USAGE_RECONCILIATION_PENDING,
            "pendingInvocationId": "invocation-before-restart",
            "pendingEstimatedCeilingUsd": 1.0
        });
        let first_observed = Arc::new(Mutex::new(Vec::new()));
        let mut first = ManagedProviderCommandExecutor::with_factory(
            &directory,
            &config,
            Box::new(FakeFactory {
                observed_resume_usage: Arc::clone(&first_observed),
                usage: usage.clone(),
            }),
        );
        first
            .execute(&test_command(1, "run.prepare", agentcore_prepare_payload()))
            .unwrap();
        first
            .execute(&test_command(2, "session.open", json!({})))
            .unwrap();
        first
            .execute(&test_command(3, "runner.suspend", json!({})))
            .unwrap();
        drop(first);

        let recovered_observed = Arc::new(Mutex::new(Vec::new()));
        let mut recovered = ManagedProviderCommandExecutor::with_factory(
            &directory,
            &config,
            Box::new(FakeFactory {
                observed_resume_usage: Arc::clone(&recovered_observed),
                usage: json!({}),
            }),
        );
        recovered
            .execute(&test_command(4, "session.open", json!({})))
            .unwrap();
        assert_eq!(
            recovered_observed.lock().unwrap().as_slice(),
            &[Some(usage)]
        );
        let before_preflight: Value =
            serde_json::from_slice(&fs::read(recovered.state_path()).unwrap()).unwrap();
        let error = recovered
            .execute(&test_command(
                5,
                "turn.start",
                json!({ "text": "blocked until an explicit budget raise" }),
            ))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("estimated session spend ceiling reached"));
        let persisted: Value =
            serde_json::from_slice(&fs::read(recovered.state_path()).unwrap()).unwrap();
        assert_eq!(persisted["lifecycle"], "session_open");
        assert_eq!(persisted["activeTurnId"], Value::Null);
        assert_eq!(
            persisted["nextEventSequence"],
            before_preflight["nextEventSequence"]
        );
        assert_eq!(
            persisted["pendingEvents"],
            before_preflight["pendingEvents"]
        );
        assert_eq!(persisted["modelRequestCount"], 3);
        assert_eq!(persisted["providerUsage"]["requestCount"], 3);
        assert_eq!(persisted["providerUsage"]["estimatedCostUsd"], 1.0);
        assert_eq!(
            persisted["providerUsage"][AGENTCORE_USAGE_RECONCILIATION_FIELD],
            AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE
        );
        assert_eq!(
            persisted["providerUsage"][AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD],
            1.0
        );
        assert_eq!(
            persisted["providerUsage"][AGENTCORE_PENDING_INVOCATION_FIELD],
            Value::Null
        );

        recovered
            .execute(&test_command(
                6,
                "turn.start",
                json!({ "text": "the same old cap still blocks" }),
            ))
            .unwrap_err();
        let persisted_again: Value =
            serde_json::from_slice(&fs::read(recovered.state_path()).unwrap()).unwrap();
        assert_eq!(persisted_again["providerUsage"]["requestCount"], 3);
        assert_eq!(persisted_again["modelRequestCount"], 3);
        assert_eq!(persisted_again["providerUsage"], persisted["providerUsage"]);
        drop(recovered);

        let raised_observed = Arc::new(Mutex::new(Vec::new()));
        let mut raised = ManagedProviderCommandExecutor::with_factory(
            &directory,
            &config,
            Box::new(FakeFactory {
                observed_resume_usage: Arc::clone(&raised_observed),
                usage: json!({}),
            }),
        );
        raised
            .execute(&test_command(
                7,
                "provider.budget.raise",
                json!({ "maximumCostUsd": 2.0 }),
            ))
            .unwrap();
        assert_eq!(
            raised_observed.lock().unwrap().as_slice(),
            &[Some(persisted["providerUsage"].clone())]
        );
        raised
            .execute(&test_command(
                8,
                "turn.start",
                json!({ "text": "explicitly raised budget permits this turn" }),
            ))
            .unwrap();
        let admitted: Value =
            serde_json::from_slice(&fs::read(raised.state_path()).unwrap()).unwrap();
        assert_eq!(admitted["lifecycle"], "turn_active");
        assert_eq!(admitted["activeTurnId"], "turn-1");
        assert_eq!(admitted["modelRequestCount"], 3);
        assert_eq!(admitted["providerUsage"]["requestCount"], 3);
        assert_eq!(admitted["providerUsage"]["estimatedCostUsd"], 1.0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn durable_claude_skill_ownership_is_reused_on_cold_recovery() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-managed-provider-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let config = test_config(&directory);
        let skills = vec![
            ClaudeManagedSkillRef {
                skill_id: "skill_instructions".to_owned(),
                version: "skver_instructions".to_owned(),
            },
            ClaudeManagedSkillRef {
                skill_id: "skill_reviewer".to_owned(),
                version: "skver_reviewer".to_owned(),
            },
        ];
        let first_observed = Arc::new(Mutex::new(Vec::new()));
        let mut first = ManagedProviderCommandExecutor::with_factory(
            &directory,
            &config,
            Box::new(FakeClaudeFactory {
                observed_resume_skills: Arc::clone(&first_observed),
                created_skills: skills.clone(),
                destroy_failures: Arc::new(AtomicUsize::new(0)),
            }),
        );
        first
            .execute(&test_command(1, "run.prepare", claude_prepare_payload()))
            .unwrap();
        first
            .execute(&test_command(2, "session.open", json!({})))
            .unwrap();
        first
            .execute(&test_command(3, "runner.suspend", json!({})))
            .unwrap();
        assert_eq!(first_observed.lock().unwrap().as_slice(), &[None]);
        let persisted: Value =
            serde_json::from_slice(&fs::read(first.state_path()).unwrap()).unwrap();
        assert_eq!(
            persisted.get("claudeManagedSkills"),
            Some(&serde_json::to_value(&skills).unwrap())
        );
        drop(first);

        let recovered_observed = Arc::new(Mutex::new(Vec::new()));
        let mut recovered = ManagedProviderCommandExecutor::with_factory(
            &directory,
            &config,
            Box::new(FakeClaudeFactory {
                observed_resume_skills: Arc::clone(&recovered_observed),
                created_skills: Vec::new(),
                destroy_failures: Arc::new(AtomicUsize::new(0)),
            }),
        );
        recovered
            .execute(&test_command(4, "session.destroy", json!({})))
            .unwrap();
        assert_eq!(
            recovered_observed.lock().unwrap().as_slice(),
            &[Some(skills)]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_fresh_bootstrap_checkpoints_session_and_skills_before_recovery() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-managed-provider-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let config = test_config(&directory);
        let skills = vec![
            ClaudeManagedSkillRef {
                skill_id: "skill_instructions".to_owned(),
                version: "skver_instructions".to_owned(),
            },
            ClaudeManagedSkillRef {
                skill_id: "skill_reviewer".to_owned(),
                version: "skver_reviewer".to_owned(),
            },
        ];
        let observed = Arc::new(Mutex::new(Vec::new()));
        let mut executor = ManagedProviderCommandExecutor::with_factory(
            &directory,
            &config,
            Box::new(FailThenRecoverClaudeFactory {
                calls: AtomicUsize::new(0),
                skills: skills.clone(),
                recovery_session_id: Some("claude-checkpointed-session".to_owned()),
                observed_resume: Arc::clone(&observed),
            }),
        );
        executor
            .execute(&test_command(1, "run.prepare", claude_prepare_payload()))
            .unwrap();

        let error = executor
            .execute(&test_command(2, "session.open", json!({})))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("injected stream bootstrap failure"));
        let checkpoint: Value =
            serde_json::from_slice(&fs::read(executor.state_path()).unwrap()).unwrap();
        assert_eq!(
            checkpoint.get("providerSessionId"),
            Some(&json!("claude-checkpointed-session"))
        );
        assert_eq!(
            checkpoint.get("claudeManagedSkills"),
            Some(&serde_json::to_value(&skills).unwrap())
        );

        executor
            .execute(&test_command(3, "session.open", json!({})))
            .unwrap();
        assert_eq!(
            observed.lock().unwrap().as_slice(),
            &[
                (None, None),
                (Some("claude-checkpointed-session".to_owned()), Some(skills))
            ]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn ambiguous_fresh_create_checkpoints_skills_before_metadata_reconciliation() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-managed-provider-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let config = test_config(&directory);
        let skills = vec![
            ClaudeManagedSkillRef {
                skill_id: "skill_instructions".to_owned(),
                version: "skver_instructions".to_owned(),
            },
            ClaudeManagedSkillRef {
                skill_id: "skill_reviewer".to_owned(),
                version: "skver_reviewer".to_owned(),
            },
        ];
        let observed = Arc::new(Mutex::new(Vec::new()));
        let mut executor = ManagedProviderCommandExecutor::with_factory(
            &directory,
            &config,
            Box::new(FailThenRecoverClaudeFactory {
                calls: AtomicUsize::new(0),
                skills: skills.clone(),
                recovery_session_id: None,
                observed_resume: Arc::clone(&observed),
            }),
        );
        executor
            .execute(&test_command(1, "run.prepare", claude_prepare_payload()))
            .unwrap();
        executor
            .execute(&test_command(2, "session.open", json!({})))
            .unwrap_err();

        let checkpoint: Value =
            serde_json::from_slice(&fs::read(executor.state_path()).unwrap()).unwrap();
        assert_eq!(checkpoint.get("providerSessionId"), Some(&Value::Null));
        assert_eq!(
            checkpoint.get("claudeManagedSkills"),
            Some(&serde_json::to_value(&skills).unwrap())
        );
        executor
            .execute(&test_command(3, "session.open", json!({})))
            .unwrap();
        assert_eq!(
            observed.lock().unwrap().as_slice(),
            &[(None, None), (None, Some(skills))]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn claude_skill_ids_cannot_be_supplied_by_the_prepare_caller() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-managed-provider-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let config = test_config(&directory);
        let observed = Arc::new(Mutex::new(Vec::new()));
        let mut executor = ManagedProviderCommandExecutor::with_factory(
            &directory,
            &config,
            Box::new(FakeClaudeFactory {
                observed_resume_skills: observed,
                created_skills: Vec::new(),
                destroy_failures: Arc::new(AtomicUsize::new(0)),
            }),
        );
        let mut payload = claude_prepare_payload();
        payload["provider"]["claudeManagedSkills"] = json!([{
            "skillId": "skill_not_owned_by_paperclip",
            "version": "skver_not_owned_by_paperclip"
        }]);
        let error = executor
            .execute(&test_command(1, "run.prepare", payload))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("Claude Managed provider descriptor is invalid"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn claude_destroy_reports_closed_only_after_all_owned_resources_are_deleted() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-managed-provider-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let config = test_config(&directory);
        let failures = Arc::new(AtomicUsize::new(1));
        let mut executor = ManagedProviderCommandExecutor::with_factory(
            &directory,
            &config,
            Box::new(FakeClaudeFactory {
                observed_resume_skills: Arc::new(Mutex::new(Vec::new())),
                created_skills: vec![
                    ClaudeManagedSkillRef {
                        skill_id: "skill_instructions".to_owned(),
                        version: "skver_instructions".to_owned(),
                    },
                    ClaudeManagedSkillRef {
                        skill_id: "skill_reviewer".to_owned(),
                        version: "skver_reviewer".to_owned(),
                    },
                ],
                destroy_failures: Arc::clone(&failures),
            }),
        );
        executor
            .execute(&test_command(1, "run.prepare", claude_prepare_payload()))
            .unwrap();
        executor
            .execute(&test_command(2, "session.open", json!({})))
            .unwrap();

        let error = executor
            .execute(&test_command(3, "session.destroy", json!({})))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("managed remote session deletion failed"));
        let persisted_after_failure: Value =
            serde_json::from_slice(&fs::read(executor.state_path()).unwrap()).unwrap();
        assert_eq!(
            persisted_after_failure.get("lifecycle"),
            Some(&json!("session_open"))
        );

        let closed = executor
            .execute(&test_command(4, "session.destroy", json!({})))
            .unwrap();
        assert_eq!(closed.events.len(), 1);
        assert_eq!(
            closed.events[0].2.get("remoteStateDestroyed"),
            Some(&json!(true))
        );
        let persisted_after_success: Value =
            serde_json::from_slice(&fs::read(executor.state_path()).unwrap()).unwrap();
        assert_eq!(
            persisted_after_success.get("lifecycle"),
            Some(&json!("closed"))
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
