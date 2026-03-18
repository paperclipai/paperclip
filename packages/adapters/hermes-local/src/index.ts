/**
 * Hermes Agent adapter for Paperclip.
 *
 * Runs Hermes Agent (https://github.com/NousResearch/hermes-agent)
 * as a managed employee in a Paperclip company. Hermes Agent is a
 * full-featured AI agent with 30+ native tools, persistent memory,
 * skills, session persistence, and MCP support.
 *
 * @packageDocumentation
 */

export const type = "hermes_local";
export const label = "Hermes Agent";

/**
 * Models available through Hermes Agent.
 *
 * Hermes supports any model via OpenRouter, Anthropic, OpenAI, or custom endpoints.
 * This list contains commonly used defaults — the actual available models
 * depend on the user's configured API keys and provider.
 *
 * The "auto" model ID signals the server adapter to detect the current
 * Hermes default from ~/.hermes/config.yaml.
 */
export const models = [
  { id: "auto", label: "Auto-detect from Hermes Agent" },
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (Anthropic)" },
  { id: "anthropic/claude-opus-4", label: "Claude Opus 4 (Anthropic)" },
  { id: "openai/gpt-4.1", label: "GPT-4.1 (OpenAI)" },
  { id: "openai/o3", label: "o3 (OpenAI)" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (Google)" },
  { id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
  { id: "anthropic/claude-haiku-3.5", label: "Claude Haiku 3.5 (Anthropic)" },
];

/**
 * Documentation shown in the Paperclip UI when configuring a Hermes agent.
 */
export const agentConfigurationDoc = `# Hermes Agent Configuration

Hermes Agent is a full-featured AI agent by Nous Research with 30+ native
tools, persistent memory, session persistence, skills, and MCP support.

## Prerequisites

- Python 3.10+ installed
- Hermes Agent installed: \`pip install hermes-agent\`
- At least one LLM API key configured in ~/.hermes/.env or ~/.hermes/config.yaml

## Model & Provider Auto-Detection

When model is set to "auto" or left empty, the adapter reads from \`~/.hermes/config.yaml\`:
\`\`\`yaml
model:
  default: glm-5
  provider: custom
  base_url: https://your-api-endpoint/v1
\`\`\`

This allows you to change your Hermes config once and have all Paperclip agents
automatically pick up the new settings.

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | auto | Model to use (provider/model format). Set to "auto" to use the current Hermes default |
| provider | string | (auto) | API provider: auto, openrouter, nous, openai-codex, zai, kimi-coding, minimax, custom |
| timeoutSec | number | 300 | Execution timeout in seconds |
| graceSec | number | 10 | Grace period after SIGTERM before SIGKILL |

## Tool Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| toolsets | string | (all) | Comma-separated toolsets to enable (e.g. "terminal,file,web") |

## Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| persistSession | boolean | true | Resume sessions across heartbeats |
| worktreeMode | boolean | false | Use git worktree for isolated changes |
| checkpoints | boolean | false | Enable filesystem checkpoints |

## Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| hermesCommand | string | hermes | Path to hermes CLI binary |
| dangerouslySkipPermissions | boolean | false | Pass --yolo flag to skip Hermes permission prompts |
| verbose | boolean | false | Enable verbose output |
| extraArgs | string[] | [] | Additional CLI arguments |
| env | object | {} | Extra environment variables |
| promptTemplate | string | (default) | Custom prompt template with {{variable}} placeholders |

## Available Template Variables

- \`{{agentId}}\` — Paperclip agent ID
- \`{{agentName}}\` — Agent display name
- \`{{companyId}}\` — Paperclip company ID
- \`{{companyName}}\` — Company display name
- \`{{runId}}\` — Current heartbeat run ID
- \`{{taskId}}\` — Current task/issue ID (if assigned)
- \`{{taskTitle}}\` — Task title (if assigned)
- \`{{taskBody}}\` — Task description (if assigned)
- \`{{projectName}}\` — Project name (if scoped to a project)
`;
