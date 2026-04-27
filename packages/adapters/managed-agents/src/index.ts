export const type = "managed_agents";
export const label = "Claude Managed Agents";

export const models = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `# managed_agents adapter configuration

Adapter: managed_agents (Claude Managed Agents beta — managed-agents-2026-04-01)

Config fields:
- role (string, required): free-text role description baked into the system prompt
- model (string, required): one of claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
- cornerstoneNamespace (string, optional): namespace passed to Cornerstone /context; defaults to "default"
- outputFormat (string, optional): "markdown" | "json" | "plain"; injected into prompt
- agentId (string, optional): existing Managed Agents agent_... id; created on first run if absent
- environmentId (string, optional): existing env_... id; created on first run if absent
- timeoutSec (number, optional): hard cap on per-run duration; defaults to 600
- promptTemplate (string, optional): override the built-in prompt template

Required environment variables (on the Paperclip server host):
- ANTHROPIC_API_KEY: Anthropic key with managed-agents beta access
- MEMORY_API_KEY: Cornerstone superuser/shared API key (also used as Cookbook MCP bearer for the spike)

Notes:
- Agents are persistent and versioned. The adapter creates one agent per Paperclip agent on first run and stashes the id into sessionParams so subsequent runs resume the same object.
- Containers are created lazily alongside agents. Default config is unrestricted networking + empty packages; extend via Environments API in a follow-up.
- Billing: $0.08/session-hour runtime + per-model token usage. Both are summed into AdapterExecutionResult.costUsd.
`;
