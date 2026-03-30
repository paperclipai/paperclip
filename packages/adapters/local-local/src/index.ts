export const type = "local_local";
export const label = "Local (Claude + LM Studio)";

export const models = [
  // Claude models (routed to Claude CLI)
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  // Local models (routed to LM Studio via OpenAI-compatible API)
  { id: "qwen/qwen3.5-9b", label: "Qwen 3.5 9B (Local)" },
  { id: "qwen/qwen3.5-35b-a3b", label: "Qwen 3.5 35B A3B (Local)" },
  { id: "qwen2.5-coder:32b", label: "Qwen 2.5 Coder 32B (Local)" },
  { id: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B (Local)" },
  { id: "deepseek-coder-v2:16b", label: "DeepSeek Coder V2 16B (Local)" },
  { id: "deepseek-r1:8b", label: "DeepSeek R1 8B (Local)" },
];

export function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-") || model.startsWith("claude/");
}

export const agentConfigurationDoc = `# local_local agent configuration

Adapter: local_local

A unified adapter that routes between Claude Code CLI and local LM Studio models.
Select a Claude model to run via the Claude CLI, or a local model to run via
LM Studio's OpenAI-compatible API. Supports automatic fallback from Claude to
a local model when Claude quota is exhausted or login is required.

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, required): model id — Claude models (claude-*) route to CLI, others route to LM Studio
- fallbackModel (string, optional): local model to fall back to when Claude is unavailable (default: first loaded LM Studio model)
- localBaseUrl (string, optional): LM Studio API base URL (default: http://127.0.0.1:1234/v1)
- effort (string, optional): reasoning effort for Claude runs (low|medium|high)
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one Claude run
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions to Claude
- command (string, optional): Claude CLI command (defaults to "claude")
- extraArgs (string[], optional): additional CLI args for Claude
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy (git_worktree)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Routing:
- model starts with "claude-" → Claude CLI
- all other models → LM Studio at localBaseUrl

Fallback:
- If Claude returns auth error or quota exceeded, the adapter automatically
  retries with the configured fallbackModel via LM Studio.

Notes:
- Claude runs inherit all claude_local behavior (sessions, skills, quota).
- LM Studio runs are stateless (no session resume).
- LM Studio must be running locally with a model loaded for local model routing to work.
`;
