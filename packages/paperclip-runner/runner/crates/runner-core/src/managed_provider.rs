use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::{AuthorizedTool, ToolResult};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    ClaudeManaged,
    AwsAgentcore,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeManagedSkillRef {
    pub skill_id: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeManagedProviderConfig {
    pub model: String,
    pub profile_id: String,
    pub anthropic_agent_id: String,
    pub agent_version: String,
    pub environment_id: String,
    pub beta_version: String,
    pub max_session_list_cost_usd: f64,
    pub instructions: String,
    #[serde(default)]
    pub runtime_context: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AwsAgentCoreProviderConfig {
    pub model: String,
    pub profile_id: String,
    pub region: String,
    pub account_id: String,
    pub harness_arn: String,
    pub harness_version: String,
    pub endpoint_arn: String,
    pub endpoint_qualifier: String,
    pub agent_runtime_arn: String,
    pub memory_arn: String,
    pub memory_id: String,
    pub invocation_role_arn: String,
    pub context_bucket: String,
    pub context_prefix: String,
    pub context_kms_key_arn: String,
    pub qualification_revision: String,
    pub event_expiry_days: u16,
    pub max_estimated_session_cost_usd: f64,
    pub max_iterations: u32,
    pub max_output_tokens: u32,
    pub timeout_seconds: u32,
    pub instructions: String,
    #[serde(default)]
    pub runtime_context: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "executionKind")]
pub enum ProviderRuntimeIdentity {
    #[serde(rename = "remote_service")]
    RemoteService {
        service: String,
        provider_session_id: String,
        process_id: Option<u32>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderEvent {
    ToolCall {
        call_id: String,
        operation_id: String,
        input: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    SemanticResult {
        result: Value,
        item_id: Option<String>,
    },
    RuntimeRequest {
        request_id: String,
        request_kind: String,
        title: String,
        details: Value,
    },
    Exited,
}

pub trait Provider {
    fn kind(&self) -> ProviderKind;
    fn runtime_identity(&self) -> ProviderRuntimeIdentity;
    fn session_identity(&self) -> &str;
    fn provider_session_id(&self) -> Option<&str>;
    fn durable_event_cursor(&self) -> Option<&str> {
        None
    }
    fn model_request_count(&self) -> Option<u64> {
        None
    }
    fn usage_snapshot(&self) -> Option<Value> {
        None
    }
    fn claude_managed_skills(&self) -> Option<&[ClaudeManagedSkillRef]> {
        None
    }
    fn restore_active_turn(&mut self, _turn_id: &str) -> Result<(), LocalRunnerError> {
        Err(LocalRunnerError::invalid(
            "provider does not support active-turn recovery",
        ))
    }
    fn restore_pending_tool_call(
        &mut self,
        _call_id: &str,
        _operation_id: &str,
        _input: &Value,
    ) -> Result<(), LocalRunnerError> {
        Err(LocalRunnerError::invalid(
            "provider does not support pending tool-call recovery",
        ))
    }
    fn configure_tools(&mut self, _tools: Vec<AuthorizedTool>) -> Result<(), LocalRunnerError> {
        Ok(())
    }
    fn increase_budget(&mut self, _maximum_cost_usd: f64) -> Result<Value, LocalRunnerError> {
        Err(LocalRunnerError::invalid(
            "provider does not support a remote session budget",
        ))
    }
    fn destroy_session(&mut self) -> Result<(), LocalRunnerError> {
        Err(LocalRunnerError::invalid(
            "provider does not support remote session deletion",
        ))
    }
    fn preflight_turn(&mut self) -> Result<(), LocalRunnerError> {
        Ok(())
    }
    fn start_turn(
        &mut self,
        message: &str,
        cwd: &str,
        turn_id: &str,
    ) -> Result<Value, LocalRunnerError>;
    fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value, LocalRunnerError>;
    fn read(&mut self) -> Result<Value, LocalRunnerError>;
    fn poll(&mut self) -> Result<Option<ProviderEvent>, LocalRunnerError>;
    fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError>;
    fn shutdown(&mut self) -> Result<(), LocalRunnerError>;
}
