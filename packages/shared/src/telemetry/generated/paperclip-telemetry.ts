// GENERATED — DO NOT EDIT.

export interface PaperclipAgentCreatedDimensions {
agent_id: string
agent_role: ("ceo" | "cto" | "cmo" | "cfo" | "security" | "engineer" | "designer" | "pm" | "qa" | "devops" | "researcher" | "general" | "other")
}

export interface PaperclipAgentFirstHeartbeatDimensions {
agent_id: string
agent_role: ("ceo" | "cto" | "cmo" | "cfo" | "security" | "engineer" | "designer" | "pm" | "qa" | "devops" | "researcher" | "general" | "other")
}

export interface PaperclipAgentTaskCompletedDimensions {
adapter_type: ("process" | "http" | "acpx_local" | "claude_local" | "codex_local" | "cursor_cloud" | "gemini_local" | "hermes_gateway" | "hermes_local" | "opencode_local" | "pi_local" | "cursor" | "openclaw_gateway" | "grok_local" | "kimi_local" | "antigravity_runtime" | "copilot_runtime" | "aws_agentcore" | "claude_managed" | "grok_bot" | "muse" | "openai_dot" | "other")
agent_id: string
agent_role: ("ceo" | "cto" | "cmo" | "cfo" | "security" | "engineer" | "designer" | "pm" | "qa" | "devops" | "researcher" | "general" | "other")
model?: string
task_id?: string
}

export interface PaperclipAgentTaskRunDimensions {
adapter_type?: ("process" | "http" | "acpx_local" | "claude_local" | "codex_local" | "cursor_cloud" | "gemini_local" | "hermes_gateway" | "hermes_local" | "opencode_local" | "pi_local" | "cursor" | "openclaw_gateway" | "grok_local" | "kimi_local" | "antigravity_runtime" | "copilot_runtime" | "aws_agentcore" | "claude_managed" | "grok_bot" | "muse" | "openai_dot" | "other")
agent_id: string
agent_role?: ("ceo" | "cto" | "cmo" | "cfo" | "security" | "engineer" | "designer" | "pm" | "qa" | "devops" | "researcher" | "general" | "other")
model?: string
state: ("succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out")
duration_seconds?: number
input_tokens?: number
output_tokens?: number
cached_tokens?: number
task_id?: string
failure_cause?: ("missing_access" | "provider_limit" | "provider_error" | "waiting_for_person" | "task_changed" | "platform_error" | "agent_error" | "unknown")
}

export interface PaperclipArtifactCreatedDimensions {
artifact_type: ("preview_url" | "runtime_service" | "pull_request" | "branch" | "commit" | "artifact" | "document" | "other")
provider: ("paperclip" | "github" | "vercel" | "s3" | "custom" | "other")
creation_flow: ("direct" | "promotion" | "run_deliverable" | "other")
}

export interface PaperclipCompanyImportedDimensions {
source_type: ("local_path" | "github" | "url" | "catalog" | "skills_sh" | "unknown")
source_ref?: string
source_ref_hashed?: boolean
}

export interface PaperclipConnectionAppLinkedDimensions {
app: string
provider: ("composio" | "arcade" | "executor")
}

export interface PaperclipConnectionAppRequestedDimensions {
app: string
origin: ("user" | "agent")
outcome: ("succeeded" | "failed" | "needs_auth")
provider: ("composio" | "arcade" | "executor")
}

export interface PaperclipConnectionCreatedDimensions {
auth_kind: ("oauth" | "api_key" | "none")
connector_key: string
enabled: boolean
server_domain?: string
setup_flow: ("gallery" | "api" | "example")
status: ("draft" | "active" | "disabled" | "archived")
transport: ("mcp_remote" | "rest_api" | "local_stdio")
}

export interface PaperclipConnectionInvokedDimensions {
connector_key: string
duration_seconds?: number
origin: ("setup_test" | "agent" | "user" | "system" | "plugin")
server_domain?: string
status: ("succeeded" | "failed" | "denied" | "cancelled" | "timed_out" | "rate_limited")
transport: ("mcp_remote" | "rest_api" | "local_stdio")
}

export interface PaperclipConnectionUpdatedDimensions {
auth_kind: ("oauth" | "api_key" | "none")
change_source: ("api" | "gallery" | "oauth_callback" | "credential_refresh" | "archive" | "example")
connector_key: string
enabled: boolean
previous_enabled: boolean
previous_status: ("draft" | "active" | "disabled" | "archived")
server_domain?: string
status: ("draft" | "active" | "disabled" | "archived")
transport: ("mcp_remote" | "rest_api" | "local_stdio")
}

export interface PaperclipErrorHandlerCrashDimensions {
error_code: string
}

export interface PaperclipGoalCreatedDimensions {
goal_level: ("company" | "team" | "agent" | "task" | "other")
}

export interface PaperclipInstallCompletedDimensions {
adapter_type: ("process" | "http" | "acpx_local" | "claude_local" | "codex_local" | "cursor_cloud" | "gemini_local" | "hermes_gateway" | "hermes_local" | "opencode_local" | "pi_local" | "cursor" | "openclaw_gateway" | "grok_local" | "kimi_local" | "other")
}

export interface PaperclipInstallStartedDimensions {

}

export interface PaperclipInteractionCreatedDimensions {
interaction_kind: ("suggest_tasks" | "ask_user_questions" | "request_confirmation" | "request_checkbox_confirmation" | "request_item_verdicts" | "other")
used_deprecated_resolver_policy_alias: boolean
}

export interface PaperclipInteractionResolvedDimensions {
interaction_kind: ("suggest_tasks" | "ask_user_questions" | "request_confirmation" | "request_checkbox_confirmation" | "request_item_verdicts" | "other")
status: ("accepted" | "rejected" | "answered" | "cancelled" | "expired" | "failed" | "other")
resolution_reason?: ("accepted" | "rejected" | "stale_target" | "superseded_by_comment" | "superseded_by_newer_request" | "expired" | "cancelled" | "skipped" | "other")
resolved_by_kind: ("user" | "agent" | "system" | "other")
created_by_kind?: ("agent" | "user" | "other")
creator_agent_role?: ("ceo" | "cto" | "cmo" | "cfo" | "security" | "engineer" | "designer" | "pm" | "qa" | "devops" | "researcher" | "general" | "other")
continuation_policy?: ("none" | "wake_assignee" | "wake_assignee_on_accept" | "other")
target_type?: ("issue_document" | "custom" | "none" | "other")
option_count?: number
selected_option_count?: number
question_count?: number
answered_question_count?: number
created_task_count?: number
skipped_task_count?: number
has_reason?: boolean
resolution_latency_seconds?: number
interaction_id?: string
created_by_agent_id?: string
source_run_id?: string
legacy_inherited_restriction: boolean
}

export interface PaperclipModelConnectedDimensions {
provider: ("anthropic" | "openai" | "openrouter" | "xai" | "github" | "google" | "other")
connection_method: ("subscription" | "api_key" | "other")
ownership: ("personal" | "shared" | "other")
routing_kind?: ("openrouter" | "bedrock" | "gateway" | "local" | "other")
first_for_company: boolean
}

export interface PaperclipPlanApprovedDimensions {
approved_by_kind: ("user" | "agent" | "system" | "other")
starts_execution: boolean
}

export interface PaperclipPlanCreatedDimensions {
created_by_kind: ("user" | "agent" | "system" | "other")
at_task_creation: boolean
}

export interface PaperclipProjectCreatedDimensions {

}

export interface PaperclipRoutineCreatedDimensions {

}

export interface PaperclipRoutineRunDimensions {
source: ("schedule" | "manual" | "api" | "webhook" | "other")
status: ("received" | "coalesced" | "skipped" | "issue_created" | "completed" | "failed" | "other")
}

export interface PaperclipServerStartedDimensions {
os_platform: ("aix" | "android" | "darwin" | "freebsd" | "haiku" | "linux" | "openbsd" | "sunos" | "win32" | "cygwin" | "netbsd" | "other")
}

export interface PaperclipSkillImportedDimensions {
source_type: ("local_path" | "github" | "url" | "catalog" | "skills_sh" | "unknown")
skill_ref?: string
}

export interface PaperclipTaskBlockedDimensions {
blocked_reason: ("waiting_on_task" | "waiting_for_person" | "waiting_for_agent" | "needs_recovery" | "unspecified" | "other")
blocked_by_kind: ("user" | "agent" | "system" | "other")
}

export interface PaperclipTaskCompletedDimensions {
completed_by_kind: ("user" | "agent" | "system" | "other")
is_subtask: boolean
}

export interface PaperclipTaskCreatedDimensions {
created_by_kind: ("user" | "agent" | "routine" | "onboarding" | "system" | "other")
is_subtask: boolean
}

export type PaperclipEventName =
  | "agent.created"
  | "agent.first_heartbeat"
  | "agent.task_completed"
  | "agent.task_run"
  | "artifact.created"
  | "company.imported"
  | "connection.app_linked"
  | "connection.app_requested"
  | "connection.created"
  | "connection.invoked"
  | "connection.updated"
  | "error.handler_crash"
  | "goal.created"
  | "install.completed"
  | "install.started"
  | "interaction.created"
  | "interaction.resolved"
  | "model.connected"
  | "plan.approved"
  | "plan.created"
  | "project.created"
  | "routine.created"
  | "routine.run"
  | "server.started"
  | "skill.imported"
  | "task.blocked"
  | "task.completed"
  | "task.created";

export interface EventDimensionsMap {
  "agent.created": PaperclipAgentCreatedDimensions;
  "agent.first_heartbeat": PaperclipAgentFirstHeartbeatDimensions;
  "agent.task_completed": PaperclipAgentTaskCompletedDimensions;
  "agent.task_run": PaperclipAgentTaskRunDimensions;
  "artifact.created": PaperclipArtifactCreatedDimensions;
  "company.imported": PaperclipCompanyImportedDimensions;
  "connection.app_linked": PaperclipConnectionAppLinkedDimensions;
  "connection.app_requested": PaperclipConnectionAppRequestedDimensions;
  "connection.created": PaperclipConnectionCreatedDimensions;
  "connection.invoked": PaperclipConnectionInvokedDimensions;
  "connection.updated": PaperclipConnectionUpdatedDimensions;
  "error.handler_crash": PaperclipErrorHandlerCrashDimensions;
  "goal.created": PaperclipGoalCreatedDimensions;
  "install.completed": PaperclipInstallCompletedDimensions;
  "install.started": PaperclipInstallStartedDimensions;
  "interaction.created": PaperclipInteractionCreatedDimensions;
  "interaction.resolved": PaperclipInteractionResolvedDimensions;
  "model.connected": PaperclipModelConnectedDimensions;
  "plan.approved": PaperclipPlanApprovedDimensions;
  "plan.created": PaperclipPlanCreatedDimensions;
  "project.created": PaperclipProjectCreatedDimensions;
  "routine.created": PaperclipRoutineCreatedDimensions;
  "routine.run": PaperclipRoutineRunDimensions;
  "server.started": PaperclipServerStartedDimensions;
  "skill.imported": PaperclipSkillImportedDimensions;
  "task.blocked": PaperclipTaskBlockedDimensions;
  "task.completed": PaperclipTaskCompletedDimensions;
  "task.created": PaperclipTaskCreatedDimensions;
}

export const PAPERCLIP_EVENTS = {
  "agent.created": "agent.created",
  "agent.first_heartbeat": "agent.first_heartbeat",
  "agent.task_completed": "agent.task_completed",
  "agent.task_run": "agent.task_run",
  "artifact.created": "artifact.created",
  "company.imported": "company.imported",
  "connection.app_linked": "connection.app_linked",
  "connection.app_requested": "connection.app_requested",
  "connection.created": "connection.created",
  "connection.invoked": "connection.invoked",
  "connection.updated": "connection.updated",
  "error.handler_crash": "error.handler_crash",
  "goal.created": "goal.created",
  "install.completed": "install.completed",
  "install.started": "install.started",
  "interaction.created": "interaction.created",
  "interaction.resolved": "interaction.resolved",
  "model.connected": "model.connected",
  "plan.approved": "plan.approved",
  "plan.created": "plan.created",
  "project.created": "project.created",
  "routine.created": "routine.created",
  "routine.run": "routine.run",
  "server.started": "server.started",
  "skill.imported": "skill.imported",
  "task.blocked": "task.blocked",
  "task.completed": "task.completed",
  "task.created": "task.created",
} as const;

export const PAPERCLIP_ENUM_DESCRIPTIONS = {
  "agent.created": {
    "agent_role": {
      "ceo": "Agent configured for company leadership and board coordination work.",
      "cto": "Agent configured for technical leadership, architecture, and engineering coordination.",
      "cmo": "Agent configured for marketing leadership work.",
      "cfo": "Agent configured for finance leadership work.",
      "security": "Agent configured for security review, risk, or policy work.",
      "engineer": "Agent configured for general software engineering work.",
      "designer": "Agent configured for product, visual, or experience design work.",
      "pm": "Agent configured for product management or planning work.",
      "qa": "Agent configured for quality assurance, testing, or validation work.",
      "devops": "Agent configured for infrastructure, deployment, or operations work.",
      "researcher": "Agent configured for research and information-gathering work.",
      "general": "Agent configured as a general-purpose worker without a more specific role.",
      "other": "Fallback when the agent role is unknown or not represented by the tracked enum."
    }
  },
  "agent.first_heartbeat": {
    "agent_role": {
      "ceo": "Agent configured for company leadership and board coordination work.",
      "cto": "Agent configured for technical leadership, architecture, and engineering coordination.",
      "cmo": "Agent configured for marketing leadership work.",
      "cfo": "Agent configured for finance leadership work.",
      "security": "Agent configured for security review, risk, or policy work.",
      "engineer": "Agent configured for general software engineering work.",
      "designer": "Agent configured for product, visual, or experience design work.",
      "pm": "Agent configured for product management or planning work.",
      "qa": "Agent configured for quality assurance, testing, or validation work.",
      "devops": "Agent configured for infrastructure, deployment, or operations work.",
      "researcher": "Agent configured for research and information-gathering work.",
      "general": "Agent configured as a general-purpose worker without a more specific role.",
      "other": "Fallback when the agent role is unknown or not represented by the tracked enum."
    }
  },
  "agent.task_completed": {
    "adapter_type": {
      "process": "Agent runtime uses a local process adapter.",
      "http": "Agent runtime uses a generic HTTP adapter.",
      "acpx_local": "Agent runtime uses the local ACPX adapter.",
      "claude_local": "Agent runtime uses the local Claude adapter.",
      "codex_local": "Agent runtime uses the local Codex adapter.",
      "cursor_cloud": "Agent runtime uses the Cursor cloud adapter.",
      "gemini_local": "Agent runtime uses the local Gemini adapter.",
      "hermes_gateway": "Agent runtime uses the Hermes gateway adapter.",
      "hermes_local": "Agent runtime uses the local Hermes adapter.",
      "opencode_local": "Agent runtime uses the local OpenCode adapter.",
      "pi_local": "Agent runtime uses the local Pi adapter.",
      "cursor": "Agent runtime uses the Cursor adapter.",
      "openclaw_gateway": "Agent runtime uses the OpenClaw gateway adapter.",
      "grok_local": "Agent runtime uses the local Grok adapter.",
      "kimi_local": "Agent runtime uses the local Kimi adapter.",
      "antigravity_runtime": "Agent runs Google Antigravity through the Paperclip runner.",
      "copilot_runtime": "Agent runs GitHub Copilot through the Paperclip runner.",
      "aws_agentcore": "Agent runs on AWS Bedrock AgentCore through the Paperclip runner.",
      "claude_managed": "Agent runs on Claude Managed Agents through the Paperclip runner.",
      "grok_bot": "Agent runs as Grok Bot through the Paperclip runner.",
      "muse": "Agent runs Muse through the Paperclip runner.",
      "openai_dot": "Agent runs OpenAI Dot through the Paperclip runner.",
      "other": "Fallback when the adapter type is unknown or not represented by the tracked enum."
    },
    "agent_role": {
      "ceo": "Agent configured for company leadership and board coordination work.",
      "cto": "Agent configured for technical leadership, architecture, and engineering coordination.",
      "cmo": "Agent configured for marketing leadership work.",
      "cfo": "Agent configured for finance leadership work.",
      "security": "Agent configured for security review, risk, or policy work.",
      "engineer": "Agent configured for general software engineering work.",
      "designer": "Agent configured for product, visual, or experience design work.",
      "pm": "Agent configured for product management or planning work.",
      "qa": "Agent configured for quality assurance, testing, or validation work.",
      "devops": "Agent configured for infrastructure, deployment, or operations work.",
      "researcher": "Agent configured for research and information-gathering work.",
      "general": "Agent configured as a general-purpose worker without a more specific role.",
      "other": "Fallback when the agent role is unknown or not represented by the tracked enum."
    }
  },
  "agent.task_run": {
    "adapter_type": {
      "process": "Agent runtime uses a local process adapter.",
      "http": "Agent runtime uses a generic HTTP adapter.",
      "acpx_local": "Agent runtime uses the local ACPX adapter.",
      "claude_local": "Agent runtime uses the local Claude adapter.",
      "codex_local": "Agent runtime uses the local Codex adapter.",
      "cursor_cloud": "Agent runtime uses the Cursor cloud adapter.",
      "gemini_local": "Agent runtime uses the local Gemini adapter.",
      "hermes_gateway": "Agent runtime uses the Hermes gateway adapter.",
      "hermes_local": "Agent runtime uses the local Hermes adapter.",
      "opencode_local": "Agent runtime uses the local OpenCode adapter.",
      "pi_local": "Agent runtime uses the local Pi adapter.",
      "cursor": "Agent runtime uses the Cursor adapter.",
      "openclaw_gateway": "Agent runtime uses the OpenClaw gateway adapter.",
      "grok_local": "Agent runtime uses the local Grok adapter.",
      "kimi_local": "Agent runtime uses the local Kimi adapter.",
      "antigravity_runtime": "Agent runs Google Antigravity through the Paperclip runner.",
      "copilot_runtime": "Agent runs GitHub Copilot through the Paperclip runner.",
      "aws_agentcore": "Agent runs on AWS Bedrock AgentCore through the Paperclip runner.",
      "claude_managed": "Agent runs on Claude Managed Agents through the Paperclip runner.",
      "grok_bot": "Agent runs as Grok Bot through the Paperclip runner.",
      "muse": "Agent runs Muse through the Paperclip runner.",
      "openai_dot": "Agent runs OpenAI Dot through the Paperclip runner.",
      "other": "Fallback when the adapter type is unknown or not represented by the tracked enum."
    },
    "agent_role": {
      "ceo": "Agent configured for company leadership and board coordination work.",
      "cto": "Agent configured for technical leadership, architecture, and engineering coordination.",
      "cmo": "Agent configured for marketing leadership work.",
      "cfo": "Agent configured for finance leadership work.",
      "security": "Agent configured for security review, risk, or policy work.",
      "engineer": "Agent configured for general software engineering work.",
      "designer": "Agent configured for product, visual, or experience design work.",
      "pm": "Agent configured for product management or planning work.",
      "qa": "Agent configured for quality assurance, testing, or validation work.",
      "devops": "Agent configured for infrastructure, deployment, or operations work.",
      "researcher": "Agent configured for research and information-gathering work.",
      "general": "Agent configured as a general-purpose worker without a more specific role.",
      "other": "Fallback when the agent role is unknown or not represented by the tracked enum."
    },
    "state": {
      "succeeded": "The agent run finished its task and reached a successful terminal state.",
      "interrupted": "A user or the board interrupted the agent run before it finished.",
      "failed": "The agent run reached a terminal state because of an unrecoverable error.",
      "cancelled": "The agent run was cancelled before it reached a successful terminal state.",
      "timed_out": "The agent run reached its time limit before it finished."
    },
    "failure_cause": {
      "missing_access": "The run lacked a sign-in, permission, secret, or repository access.",
      "provider_limit": "The model provider reported a rate limit, quota, or capacity limit.",
      "provider_error": "The model provider rejected the request or failed for another reason.",
      "waiting_for_person": "The run stopped because a person must review or reconcile its result.",
      "task_changed": "The task was reassigned, paused, closed, blocked, or stopped by a person while the run was active.",
      "platform_error": "Paperclip infrastructure, the workspace, or the sandbox failed or restarted.",
      "agent_error": "The agent's own output, tool use, or time limit ended the run.",
      "unknown": "The stored failure did not match a tracked code."
    }
  },
  "artifact.created": {
    "artifact_type": {
      "preview_url": "A preview deployment link.",
      "runtime_service": "A running workspace service.",
      "pull_request": "A pull request.",
      "branch": "A source branch.",
      "commit": "A source commit.",
      "artifact": "A file or other deliverable stored with the task.",
      "document": "A document work product.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    },
    "provider": {
      "paperclip": "Paperclip stores the artifact.",
      "github": "GitHub hosts the artifact.",
      "vercel": "Vercel hosts the artifact.",
      "s3": "An S3-compatible store hosts the artifact.",
      "custom": "Another system hosts the artifact.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    },
    "creation_flow": {
      "direct": "A person, agent, or integration recorded the artifact on the task.",
      "promotion": "A reviewer promoted an untrusted task file or document to an approved artifact.",
      "run_deliverable": "An agent run uploaded a file deliverable to the task.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    }
  },
  "company.imported": {
    "source_type": {
      "local_path": "Import source came from a filesystem path on the operator's machine.",
      "github": "Import source came from a GitHub repository or GitHub-backed reference.",
      "url": "Import source came from a direct URL.",
      "catalog": "Import source came from a Paperclip catalog entry.",
      "skills_sh": "Import source came from a Skills.sh-compatible source.",
      "unknown": "Source type could not be classified."
    }
  },
  "connection.app_linked": {
    "provider": {
      "composio": "The app is reached through a Composio gateway.",
      "arcade": "The app is reached through an Arcade gateway.",
      "executor": "The app is reached through an Executor gateway."
    }
  },
  "connection.app_requested": {
    "origin": {
      "user": "A person asked from the app setup screens.",
      "agent": "An agent asked through the gateway's connection-management tool."
    },
    "outcome": {
      "succeeded": "The app is connected without a further sign-in.",
      "failed": "The aggregator rejected the request or did not confirm it.",
      "needs_auth": "The aggregator returned a sign-in step the person must finish."
    },
    "provider": {
      "composio": "The app is reached through a Composio gateway.",
      "arcade": "The app is reached through an Arcade gateway.",
      "executor": "The app is reached through an Executor gateway."
    }
  },
  "connection.created": {
    "auth_kind": {
      "oauth": "Connection authenticates with an OAuth flow.",
      "api_key": "Connection authenticates with a stored API key.",
      "none": "Connection requires no authentication."
    },
    "setup_flow": {
      "gallery": "Connection was created through the app-gallery setup flow.",
      "api": "Connection was created through the connections API.",
      "example": "Connection was created or upserted as a bundled example connection."
    },
    "status": {
      "draft": "Connection row exists but setup has not produced a usable configuration yet.",
      "active": "Connection is fully configured and available for use.",
      "disabled": "Connection is disabled and excluded from tool use.",
      "archived": "Connection is archived and excluded from tool use."
    },
    "transport": {
      "mcp_remote": "Connection talks to a remote MCP server over HTTP.",
      "rest_api": "Connection calls the provider's REST API directly.",
      "local_stdio": "Connection runs a local MCP server over stdio."
    }
  },
  "connection.invoked": {
    "origin": {
      "setup_test": "A human ran the connection's setup test, identified by durable invocation columns: user actor with no run, issue, or gateway reference and a connection id.",
      "agent": "An agent run invoked the tool.",
      "user": "A human invoked the tool outside the setup-test shape.",
      "system": "A system-initiated process invoked the tool.",
      "plugin": "A plugin invoked the tool."
    },
    "status": {
      "succeeded": "The tool invocation completed successfully.",
      "failed": "The tool invocation reached a terminal failure.",
      "denied": "The tool invocation was denied by policy or by a human approval decision.",
      "cancelled": "The tool invocation was cancelled before completion. Declared in the application status enum; no current application code path writes this value.",
      "timed_out": "The tool invocation exceeded its time limit.",
      "rate_limited": "The tool invocation was rejected by rate limiting."
    },
    "transport": {
      "mcp_remote": "Connection talks to a remote MCP server over HTTP.",
      "rest_api": "Connection calls the provider's REST API directly.",
      "local_stdio": "Connection runs a local MCP server over stdio."
    }
  },
  "connection.updated": {
    "auth_kind": {
      "oauth": "Connection authenticates with an OAuth flow.",
      "api_key": "Connection authenticates with a stored API key.",
      "none": "Connection requires no authentication."
    },
    "change_source": {
      "api": "A connections API update changed the persisted lifecycle state.",
      "gallery": "An app-gallery setup step (finish, OAuth access finalization, or reconnect; Apps gallery and inline task cards) changed the persisted lifecycle state.",
      "oauth_callback": "An OAuth callback completion (provider OAuth, Paperclip Cloud connector, or Vercel Connect) changed the persisted lifecycle state.",
      "credential_refresh": "A credential refresh changed the persisted lifecycle state.",
      "archive": "An archive operation changed the persisted lifecycle state.",
      "example": "An example-connection upsert changed the persisted lifecycle state."
    },
    "previous_status": {
      "draft": "Connection row exists but setup has not produced a usable configuration yet.",
      "active": "Connection is fully configured and available for use.",
      "disabled": "Connection is disabled and excluded from tool use.",
      "archived": "Connection is archived and excluded from tool use."
    },
    "status": {
      "draft": "Connection row exists but setup has not produced a usable configuration yet.",
      "active": "Connection is fully configured and available for use.",
      "disabled": "Connection is disabled and excluded from tool use.",
      "archived": "Connection is archived and excluded from tool use."
    },
    "transport": {
      "mcp_remote": "Connection talks to a remote MCP server over HTTP.",
      "rest_api": "Connection calls the provider's REST API directly.",
      "local_stdio": "Connection runs a local MCP server over stdio."
    }
  },
  "goal.created": {
    "goal_level": {
      "company": "Goal applies at company scope.",
      "team": "Goal applies at team or group scope.",
      "agent": "Goal applies to a specific agent.",
      "task": "Goal applies to task-level work.",
      "other": "Fallback when the goal level is unknown or not represented by the tracked enum."
    }
  },
  "install.completed": {
    "adapter_type": {
      "process": "Agent runtime uses a local process adapter.",
      "http": "Agent runtime uses a generic HTTP adapter.",
      "acpx_local": "Agent runtime uses the local ACPX adapter.",
      "claude_local": "Agent runtime uses the local Claude adapter.",
      "codex_local": "Agent runtime uses the local Codex adapter.",
      "cursor_cloud": "Agent runtime uses the Cursor cloud adapter.",
      "gemini_local": "Agent runtime uses the local Gemini adapter.",
      "hermes_gateway": "Agent runtime uses the Hermes gateway adapter.",
      "hermes_local": "Agent runtime uses the local Hermes adapter.",
      "opencode_local": "Agent runtime uses the local OpenCode adapter.",
      "pi_local": "Agent runtime uses the local Pi adapter.",
      "cursor": "Agent runtime uses the Cursor adapter.",
      "openclaw_gateway": "Agent runtime uses the OpenClaw gateway adapter.",
      "grok_local": "Agent runtime uses the local Grok adapter.",
      "kimi_local": "Agent runtime uses the local Kimi adapter.",
      "other": "Fallback when the adapter type is unknown or not represented by the tracked enum."
    }
  },
  "interaction.created": {
    "interaction_kind": {
      "suggest_tasks": "Board-facing interaction that proposes concrete subtasks for acceptance.",
      "ask_user_questions": "Board-facing interaction that asks structured questions and stores answers.",
      "request_confirmation": "Board-facing interaction that asks for a single accept or reject decision.",
      "request_checkbox_confirmation": "Board-facing interaction that asks the board to select options and confirm.",
      "request_item_verdicts": "Board-facing interaction that collects a verdict for each known item.",
      "other": "Fallback when the interaction kind is unknown or not represented by the tracked enum."
    }
  },
  "interaction.resolved": {
    "interaction_kind": {
      "suggest_tasks": "Board-facing interaction that proposes concrete subtasks for acceptance.",
      "ask_user_questions": "Board-facing interaction that asks structured questions and stores answers.",
      "request_confirmation": "Board-facing interaction that asks for a single accept or reject decision.",
      "request_checkbox_confirmation": "Board-facing interaction that asks the board to select options and confirm.",
      "request_item_verdicts": "Board-facing interaction that collects a verdict for each known item.",
      "other": "Fallback when the interaction kind is unknown or not represented by the tracked enum."
    },
    "status": {
      "accepted": "Interaction was accepted.",
      "rejected": "Interaction was rejected.",
      "answered": "Ask-user-questions interaction was answered.",
      "cancelled": "Interaction was cancelled before acceptance or answer.",
      "expired": "Interaction expired because the bound target became stale or was superseded.",
      "failed": "Interaction resolution attempted but failed.",
      "other": "Fallback when the terminal status is unknown or not represented by the tracked enum."
    },
    "resolution_reason": {
      "accepted": "Stored result outcome says the interaction was accepted.",
      "rejected": "Stored result outcome says the interaction was rejected.",
      "stale_target": "Bound target, such as an issue document revision, was no longer current.",
      "superseded_by_comment": "A later user or board comment superseded the pending confirmation.",
      "superseded_by_newer_request": "A newer confirmation from the same agent superseded the pending confirmation.",
      "expired": "Interaction expired for a generic expiration reason.",
      "cancelled": "Interaction was explicitly cancelled.",
      "skipped": "The board skipped the interaction and returned to ordinary task input.",
      "other": "Fallback when the resolution reason is unknown or not represented by the tracked enum."
    },
    "resolved_by_kind": {
      "user": "A board or human user resolved the interaction.",
      "agent": "An agent resolved the interaction.",
      "system": "Paperclip resolved the interaction automatically.",
      "other": "Fallback when the resolver kind is unknown or not represented by the tracked enum."
    },
    "created_by_kind": {
      "agent": "Interaction was created by an agent.",
      "user": "Interaction was created by a board or human user.",
      "other": "Fallback when the creator kind is unknown or not represented by the tracked enum."
    },
    "creator_agent_role": {
      "ceo": "Agent configured for company leadership and board coordination work.",
      "cto": "Agent configured for technical leadership, architecture, and engineering coordination.",
      "cmo": "Agent configured for marketing leadership work.",
      "cfo": "Agent configured for finance leadership work.",
      "security": "Agent configured for security review, risk, or policy work.",
      "engineer": "Agent configured for general software engineering work.",
      "designer": "Agent configured for product, visual, or experience design work.",
      "pm": "Agent configured for product management or planning work.",
      "qa": "Agent configured for quality assurance, testing, or validation work.",
      "devops": "Agent configured for infrastructure, deployment, or operations work.",
      "researcher": "Agent configured for research and information-gathering work.",
      "general": "Agent configured as a general-purpose worker without a more specific role.",
      "other": "Fallback when the agent role is unknown or not represented by the tracked enum."
    },
    "continuation_policy": {
      "none": "Resolving the interaction does not automatically wake the issue assignee.",
      "wake_assignee": "Resolving the interaction wakes or returns the issue to the assignee.",
      "wake_assignee_on_accept": "Accepting the interaction wakes or returns the issue to the assignee.",
      "other": "Fallback when the continuation policy is unknown or not represented by the tracked enum."
    },
    "target_type": {
      "issue_document": "Interaction is bound to a specific issue document revision.",
      "custom": "Interaction is bound to a custom target.",
      "none": "Interaction has no bound target.",
      "other": "Fallback when the target type is unknown or not represented by the tracked enum."
    }
  },
  "model.connected": {
    "provider": {
      "anthropic": "The connection signs in to Anthropic.",
      "openai": "The connection signs in to OpenAI.",
      "openrouter": "The connection signs in to OpenRouter.",
      "xai": "The connection signs in to xAI.",
      "github": "The connection signs in to GitHub Copilot.",
      "google": "The connection signs in to Google.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    },
    "connection_method": {
      "subscription": "The connection uses a provider subscription sign-in.",
      "api_key": "The connection uses a provider API key.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    },
    "ownership": {
      "personal": "The connection belongs to the person who connected it.",
      "shared": "The connection is shared with the company.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    },
    "routing_kind": {
      "openrouter": "The connection routes through OpenRouter.",
      "bedrock": "The connection routes through Amazon Bedrock.",
      "gateway": "The connection routes through a custom model gateway.",
      "local": "The connection routes to a model server on the same machine.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    }
  },
  "plan.approved": {
    "approved_by_kind": {
      "user": "A board member or other person accepted the plan confirmation.",
      "agent": "An agent accepted the plan confirmation.",
      "system": "Paperclip accepted the plan confirmation automatically, with no acting person or agent.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    }
  },
  "plan.created": {
    "created_by_kind": {
      "user": "A board member or other person wrote the first plan revision.",
      "agent": "An agent wrote the first plan revision.",
      "system": "Paperclip wrote the first plan revision automatically, with no acting person or agent.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    }
  },
  "routine.run": {
    "source": {
      "schedule": "Routine was triggered by a scheduled trigger.",
      "manual": "Routine was triggered manually by a user or agent action.",
      "api": "Routine was triggered through an API request.",
      "webhook": "Routine was triggered by a webhook.",
      "other": "Fallback when the source is unknown or not represented by the tracked enum."
    },
    "status": {
      "received": "Routine run was accepted for processing.",
      "coalesced": "A live execution already existed and the run was coalesced into it.",
      "skipped": "A live execution already existed and concurrency policy skipped the run.",
      "issue_created": "Routine dispatch created a new issue and queued the agent wakeup.",
      "completed": "Routine run completed without needing a new issue.",
      "failed": "Routine dispatch failed and the run was finalized as failed.",
      "other": "Fallback when the status is unknown or not represented by the tracked enum."
    }
  },
  "server.started": {
    "os_platform": {
      "aix": "Server host runs IBM AIX.",
      "android": "Server host runs Android.",
      "darwin": "Server host runs macOS.",
      "freebsd": "Server host runs FreeBSD.",
      "haiku": "Server host runs Haiku.",
      "linux": "Server host runs Linux, including WSL and container hosts.",
      "openbsd": "Server host runs OpenBSD.",
      "sunos": "Server host runs SunOS, Solaris, or illumos.",
      "win32": "Server host runs Windows, both 32-bit and 64-bit.",
      "cygwin": "Server host runs under Cygwin on Windows.",
      "netbsd": "Server host runs NetBSD.",
      "other": "Fallback when the platform is unknown or not represented by the tracked enum."
    }
  },
  "skill.imported": {
    "source_type": {
      "local_path": "Import source came from a filesystem path on the operator's machine.",
      "github": "Import source came from a GitHub repository or GitHub-backed reference.",
      "url": "Import source came from a direct URL.",
      "catalog": "Import source came from a Paperclip catalog entry.",
      "skills_sh": "Import source came from a Skills.sh-compatible source.",
      "unknown": "Source type could not be classified."
    }
  },
  "task.blocked": {
    "blocked_reason": {
      "waiting_on_task": "The task waits on one or more unfinished blocking tasks.",
      "waiting_for_person": "The task names a person or the board as the owner of the next action.",
      "waiting_for_agent": "The task names an agent as the owner of the next action.",
      "needs_recovery": "Paperclip blocked the task automatically for recovery, with no blocking task or unblock owner.",
      "unspecified": "A person or agent blocked the task without a blocking task or unblock owner.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    },
    "blocked_by_kind": {
      "user": "A board member or other person moved the task to blocked.",
      "agent": "An agent moved the task to blocked.",
      "system": "Paperclip moved the task to blocked automatically, with no acting person or agent.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    }
  },
  "task.completed": {
    "completed_by_kind": {
      "user": "A board member or other person moved the task to done.",
      "agent": "An agent moved the task to done.",
      "system": "Paperclip moved the task to done automatically, with no acting person or agent.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    }
  },
  "task.created": {
    "created_by_kind": {
      "user": "A board member or other person created the task.",
      "agent": "An agent created the task.",
      "routine": "A routine run created the task.",
      "onboarding": "The onboarding wizard created the workspace's first task when a person launched it.",
      "system": "Paperclip created the task automatically, with no acting person or agent.",
      "other": "Fallback when the value is unknown or not represented by the tracked enum."
    }
  }
} as const;

export const SCHEMA_VERSION = "1" as const;

export interface PaperclipTelemetryEvent<K extends PaperclipEventName = PaperclipEventName> {
name: K
occurredAt: string
dimensions: EventDimensionsMap[K]
}

export type AnyPaperclipTelemetryEvent = {
  [K in PaperclipEventName]: PaperclipTelemetryEvent<K>
}[PaperclipEventName];

export interface PaperclipTelemetryBatch {
app: "paperclip"
schemaVersion: typeof SCHEMA_VERSION
installId: string
/**
 * Optional client application build version. Paperclip clients report PEP 440
 * local versions such as <nearest-tag>+<commits-since-tag>.git.<abbrev-sha>;
 * nearest tags are usually CalVer, but legacy SemVer tags such as 0.3.1 can
 * appear. Ingest documents this shape but does not strictly enforce PEP 440.
 */
version?: string
events: AnyPaperclipTelemetryEvent[]
}

export function makeEvent<K extends PaperclipEventName>(
  name: K,
  dimensions: EventDimensionsMap[K],
  occurredAt: string
): PaperclipTelemetryEvent<K> {
  return { name, occurredAt, dimensions };
}

export function makeBatch(
  installId: string,
  events: readonly AnyPaperclipTelemetryEvent[],
  /**
   * Optional client application build version. Paperclip clients report PEP 440
   * local versions such as <nearest-tag>+<commits-since-tag>.git.<abbrev-sha>;
   * nearest tags are usually CalVer, but legacy SemVer tags such as 0.3.1 can
   * appear. Ingest documents this shape but does not strictly enforce PEP 440.
   */
  version?: string
): PaperclipTelemetryBatch {
  return {
    app: "paperclip",
    schemaVersion: SCHEMA_VERSION,
    installId,
    ...(version === undefined ? {} : { version }),
    events: [...events]
  };
}
