/**
 * IBM Bob Shell adapter for Paperclip.
 *
 * Runs IBM Bob Shell (`bob run`) in non-interactive mode as a managed
 * AI agent employee inside a Paperclip company. Bob Shell is IBM's
 * agentic AI assistant with MCP support, file-reference syntax (@file),
 * and session persistence via task IDs.
 *
 * @see https://bob.ibm.com/docs/shell/getting-started/start-bobshell-non-interactive
 * @packageDocumentation
 */

import type { AdapterSessionManagement } from "@paperclipai/adapter-utils";
import { ADAPTER_TYPE, ADAPTER_LABEL } from "./shared/constants.js";
import { execute, testEnvironment, sessionCodec } from "./server/index.js";
import { resolveBobCommand } from "./server/execute.js";
import type { AdapterRuntimeCommandSpec, ServerAdapterModule } from "@paperclipai/adapter-utils";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * Models are resolved by Bob Shell at runtime based on the user's IBM account.
 * No hardcoded model list is needed.
 */
export const models: { id: string; label: string }[] = [];

const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: false,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};

function getRuntimeCommandSpec(
  config: Record<string, unknown>,
): AdapterRuntimeCommandSpec {
  const command = resolveBobCommand(config);
  return {
    command,
    detectCommand: command,
    installCommand: null,
  };
}

/**
 * Documentation shown in the Paperclip UI when configuring a Bob Shell agent.
 *
 * Written as routing logic for LLM agents — "use when / don't use when".
 */
export const agentConfigurationDoc = `# IBM Bob Shell Configuration

Adapter: bob_shell

Bob Shell (\`bob run\`) is IBM's AI coding assistant with MCP support, file
references (\`@file\`), session persistence, and a structured stream-json output
format for machine consumption.

## Use when

- The task requires IBM Bob Shell's native tools (file editing, code generation, shell commands)
- You need session continuity across Paperclip heartbeat runs (Bob supports \`--resume <task-id>\`)
- The agent must operate in a CI/CD or batch automation context
- The workspace is an IBM project or uses IBM internal services

## Don't use when

- You need a simple one-shot script execution without LLM involvement (use the "process" adapter)
- Bob Shell CLI is not installed or the user lacks an IBM Bob account
- The task requires a different AI provider's toolset (use claude_local, codex_local, hermes_local, etc.)

## Prerequisites

- IBM Bob Shell CLI installed: \`bob\` must be on PATH
- IBM account with Bob Shell access
- License accepted: \`bob --accept-license\`
- For CI/CD: API key of type "general" requires \`--team-id\`

## Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| cwd | string | process cwd | Working directory for the bob run subprocess |
| bobCommand | string | bob | Path to the bob CLI binary |
| timeoutSec | number | 1800 | Wall-clock kill timeout (seconds) |
| graceSec | number | 15 | Grace period after SIGTERM before SIGKILL |
| maxTurns | number | 0 | Max agentic turns (0 = no limit) — maps to \`--max-turns\` |
| maxCost | number | 0 | Max Bobcoins per run (0 = no limit) — maps to \`--max-cost\` |

## Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| workspace | string | (auto) | Override workspace root directory — maps to \`--workspace\` |
| teamId | string | (none) | Team context — required when using a general-scope API key |

## Output Control

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| mode | string | agent | Starting mode: agent, plan, ask — maps to \`--mode\` |
| disableMcp | boolean | false | Disable all MCP servers for the run |
| disableSubagents | boolean | false | Disable subagent spawning |

## Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| extraArgs | string[] | [] | Additional CLI arguments passed to \`bob run\` |
| env | object | {} | Extra environment variables |
| promptTemplate | string | (default) | Custom prompt template with {{variable}} placeholders |

## Session Management

Bob Shell assigns a \`task_id\` to each run. The adapter stores this task ID
as the session ID. On the next heartbeat, the adapter resumes with
\`bob run --resume <task-id>\` so Bob can continue from where it left off.

Sessions are cwd-scoped: if the cwd changes between runs, the adapter
discards the old session and starts fresh to prevent cross-project contamination.

## Available Template Variables

- \`{{agentId}}\` — Paperclip agent ID
- \`{{agentName}}\` — Agent display name
- \`{{companyId}}\` — Paperclip company ID
- \`{{companyName}}\` — Company display name
- \`{{runId}}\` — Current heartbeat run ID
- \`{{taskId}}\` — Current task/issue ID (if assigned)
- \`{{taskTitle}}\` — Task title (if assigned)
- \`{{taskBody}}\` — Task description (if assigned)
- \`{{paperclipApiUrl}}\` — Paperclip API URL for curl calls

## Bob Shell --format stream-json Events

Bob Shell emits NDJSON when \`--format stream-json\` is passed:

- \`message\`: \`{ role, content, isReasoning? }\` — user/assistant messages
- \`tool_use\`: \`{ tool_name, tool_id, parameters }\` — tool call by Bob
- \`tool_result\`: \`{ tool_id, status, output?, error? }\` — tool result
- \`error\`: \`{ severity, message }\` — cost/turn limit or runtime error
- \`result\`: \`{ status, stats, last_message }\` — terminal event with token/cost stats
`;

/**
 * External adapter plugin entrypoint expected by Paperclip's adapter manager.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: false,
    requiresMaterializedRuntimeSkills: false,
    getRuntimeCommandSpec,
    agentConfigurationDoc,
  };
}
