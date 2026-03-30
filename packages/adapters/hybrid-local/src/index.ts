export const type = "hybrid_local";
export const label = "Hybrid (local)";

export const models = [
  // Claude models (routed to Claude CLI)
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  // Local models (routed to OpenAI-compatible endpoint)
  { id: "qwen/qwen3.5-9b", label: "Qwen 3.5 9B (Local)" },
  { id: "qwen/qwen3.5-35b-a3b", label: "Qwen 3.5 35B A3B (Local)" },
  { id: "qwen/qwen2.5-coder-32b", label: "Qwen 2.5 Coder 32B (Local)" },
  { id: "qwen/qwen2.5-coder-7b", label: "Qwen 2.5 Coder 7B (Local)" },
  { id: "deepseek-coder-v2:16b", label: "DeepSeek Coder V2 16B (Local)" },
  { id: "deepseek-r1:8b", label: "DeepSeek R1 8B (Local)" },
];

export function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-") || model.startsWith("claude/");
}

export const agentConfigurationDoc = `# hybrid_local agent configuration

Adapter: hybrid_local

A hybrid adapter that routes between Claude Code CLI and any OpenAI-compatible
local inference server (LM Studio, Ollama, LiteLLM, vLLM, etc.).

Select a Claude model to run via the Claude CLI, or a local model to run via
the configured OpenAI-compatible endpoint. Supports bidirectional fallback:
- Claude model fails (quota/auth) → falls back to local model
- Local model fails (server down/GPU busy) → falls back to Claude model

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, required): model id — Claude models (claude-*) route to CLI, others route to local endpoint
- fallbackModel (string, optional): model to fall back to when the primary is unavailable; can be Claude or local
- localBaseUrl (string, optional): OpenAI-compatible API base URL (default: http://127.0.0.1:1234/v1)
- quotaThresholdPercent (number, optional): Claude quota usage percent at which to pre-emptively skip to local (default: 80, set to 0 to disable)
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
- all other models → OpenAI-compatible endpoint at localBaseUrl

Fallback (bidirectional):
- Claude model + quota/auth error → retry with fallbackModel via local endpoint
- Local model + connection/timeout error → retry with fallbackModel via Claude CLI
- Set fallbackModel to "" to disable fallback (fail on error)

Compatible local backends:
- LM Studio (default, http://127.0.0.1:1234/v1)
- Ollama (http://127.0.0.1:11434/v1)
- LiteLLM proxy (http://127.0.0.1:4000/v1)
- Any OpenAI-compatible server

Notes:
- Claude runs inherit all claude_local behavior (sessions, skills, quota).
- Local runs are stateless (no session resume).
- The local endpoint must be running with a model loaded for local routing to work.
`;
