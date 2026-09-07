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
adapter_type: ("process" | "http" | "acpx_local" | "claude_local" | "codex_local" | "cursor_cloud" | "gemini_local" | "hermes_gateway" | "hermes_local" | "opencode_local" | "pi_local" | "cursor" | "openclaw_gateway" | "grok_local" | "kimi_local" | "other")
agent_id: string
agent_role: ("ceo" | "cto" | "cmo" | "cfo" | "security" | "engineer" | "designer" | "pm" | "qa" | "devops" | "researcher" | "general" | "other")
model?: string
task_id?: string
}

export interface PaperclipAgentTaskRunDimensions {
adapter_type?: ("process" | "http" | "acpx_local" | "claude_local" | "codex_local" | "cursor_cloud" | "gemini_local" | "hermes_gateway" | "hermes_local" | "opencode_local" | "pi_local" | "cursor" | "openclaw_gateway" | "grok_local" | "kimi_local" | "other")
agent_id: string
agent_role?: ("ceo" | "cto" | "cmo" | "cfo" | "security" | "engineer" | "designer" | "pm" | "qa" | "devops" | "researcher" | "general" | "other")
model?: string
state: ("succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out")
duration_seconds?: number
input_tokens?: number
output_tokens?: number
cached_tokens?: number
task_id?: string
}

export interface PaperclipCompanyImportedDimensions {
source_type: ("local_path" | "github" | "url" | "catalog" | "skills_sh" | "unknown")
source_ref?: string
source_ref_hashed?: boolean
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

export interface PaperclipProjectCreatedDimensions {

}

export interface PaperclipRoutineCreatedDimensions {

}

export interface PaperclipRoutineRunDimensions {
source: ("schedule" | "manual" | "api" | "webhook" | "other")
status: ("received" | "coalesced" | "skipped" | "issue_created" | "completed" | "failed" | "other")
}

export interface PaperclipSkillImportedDimensions {
source_type: ("local_path" | "github" | "url" | "catalog" | "skills_sh" | "unknown")
skill_ref?: string
}

export type PaperclipEventName =
  | "agent.created"
  | "agent.first_heartbeat"
  | "agent.task_completed"
  | "agent.task_run"
  | "company.imported"
  | "error.handler_crash"
  | "goal.created"
  | "install.completed"
  | "install.started"
  | "interaction.created"
  | "interaction.resolved"
  | "project.created"
  | "routine.created"
  | "routine.run"
  | "skill.imported";

export interface EventDimensionsMap {
  "agent.created": PaperclipAgentCreatedDimensions;
  "agent.first_heartbeat": PaperclipAgentFirstHeartbeatDimensions;
  "agent.task_completed": PaperclipAgentTaskCompletedDimensions;
  "agent.task_run": PaperclipAgentTaskRunDimensions;
  "company.imported": PaperclipCompanyImportedDimensions;
  "error.handler_crash": PaperclipErrorHandlerCrashDimensions;
  "goal.created": PaperclipGoalCreatedDimensions;
  "install.completed": PaperclipInstallCompletedDimensions;
  "install.started": PaperclipInstallStartedDimensions;
  "interaction.created": PaperclipInteractionCreatedDimensions;
  "interaction.resolved": PaperclipInteractionResolvedDimensions;
  "project.created": PaperclipProjectCreatedDimensions;
  "routine.created": PaperclipRoutineCreatedDimensions;
  "routine.run": PaperclipRoutineRunDimensions;
  "skill.imported": PaperclipSkillImportedDimensions;
}

export const PAPERCLIP_EVENTS = {
  "agent.created": "agent.created",
  "agent.first_heartbeat": "agent.first_heartbeat",
  "agent.task_completed": "agent.task_completed",
  "agent.task_run": "agent.task_run",
  "company.imported": "company.imported",
  "error.handler_crash": "error.handler_crash",
  "goal.created": "goal.created",
  "install.completed": "install.completed",
  "install.started": "install.started",
  "interaction.created": "interaction.created",
  "interaction.resolved": "interaction.resolved",
  "project.created": "project.created",
  "routine.created": "routine.created",
  "routine.run": "routine.run",
  "skill.imported": "skill.imported",
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
  "skill.imported": {
    "source_type": {
      "local_path": "Import source came from a filesystem path on the operator's machine.",
      "github": "Import source came from a GitHub repository or GitHub-backed reference.",
      "url": "Import source came from a direct URL.",
      "catalog": "Import source came from a Paperclip catalog entry.",
      "skills_sh": "Import source came from a Skills.sh-compatible source.",
      "unknown": "Source type could not be classified."
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
