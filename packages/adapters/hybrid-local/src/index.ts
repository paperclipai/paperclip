export const type = "hybrid_local";
export const label = "Hybrid (local)";

// Only Claude models are hardcoded — local models are discovered dynamically
// from the OpenAI-compatible /v1/models endpoint via listOpenAICompatModels() in registry.ts.
// Hardcoding local model IDs here causes stale IDs to be stored in agent configs
// when the local server updates its naming convention.
export const models = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
];

export function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-") || model.startsWith("claude/");
}

export const agentConfigurationDoc = `# hybrid_local agent configuration

Adapter: hybrid_local

A hybrid adapter that pairs a local planning model (OpenAI-compatible endpoint)
with a coding CLI adapter (Claude or Codex). The local model handles heartbeats
and triage, and only hands off to the coding adapter when explicitly requested.

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, required): local planning model id (OpenAI-compatible)
- codingModel (string, optional): CLI model to run when handoff is requested (Claude or Codex)
- localBaseUrl (string, optional): OpenAI-compatible API base URL (default: http://127.0.0.1:11434/v1)
- quotaThresholdPercent (number, optional): Claude quota usage percent at which to pre-emptively skip to local (default: 80, set to 0 to disable)
- allowExtraCredit (boolean, optional): whether Claude can continue past quota policy; default false (recommended)
- localToolMode (string, optional): tool access for local planning (off | read_only | full; default: read_only)
- effort (string, optional): reasoning effort for Claude runs (low|medium|high)
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one Claude run
- maxTotalTokens (number, optional): max cumulative input + output tokens for local tool-use runs (default: 300000)
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions to Claude
- command (string, optional): Claude CLI command (defaults to "claude")
- extraArgs (string[], optional): additional CLI args for Claude
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy (git_worktree)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Routing:
- Local planning runs always use the OpenAI-compatible endpoint at localBaseUrl.
- If the local model emits "HANDOFF: true", Paperclip invokes the coding CLI.
- Claude models (claude-*) use the Claude CLI; all others use the Codex CLI.

Cost policy:
- allowExtraCredit=false (default) enforces fail-closed quota behavior for Claude coding runs.
- If quota pre-check is unavailable, Claude coding runs are blocked.

Compatible local backends:
- Ollama (default, http://127.0.0.1:11434/v1)
- LM Studio (http://127.0.0.1:1234/v1)
- LiteLLM proxy (http://127.0.0.1:4000/v1)
- Any OpenAI-compatible server

Local model selection:

RECOMMENDED: qwen2.5-coder (7b/32b variants)
- Best tool-calling support among open models
- Strong code generation and reasoning
- 7b: ~7GB VRAM, 32b: ~24GB VRAM
- Expected token burn: 2-4x Claude for equivalent task
- Best for: CI/CD, code review, testing, debugging

ALTERNATIVE: llama3.1 (8b/70b variants)
- Larger context window (128k tokens)
- Good general reasoning
- 8b: ~8GB VRAM, 70b: ~40GB VRAM
- Expected token burn: 3-5x Claude
- Best for: Long-context tasks, research, analysis

ALTERNATIVE: mistral (7b/12b variants)
- Fast inference, smaller models
- Good for latency-critical tasks
- 7b: ~6GB VRAM, 12b: ~10GB VRAM
- Expected token burn: 5-8x Claude
- Best for: Lightweight tasks, streaming responses

LOCAL VS CLAUDE COSTS:
- Local: Zero API costs, but GPU compute cost (~$0.50-2.00/hour on consumer GPU)
- Claude: API costs ($3-30 per million tokens depending on model)
- Break-even point: ~5M tokens of equivalent work using qwen2.5-coder (7b)
- Most cost-effective: Use local + Claude fallback for quota management

Notes:
- Claude/Codex runs inherit their respective local adapter behavior (sessions, skills, quota).
- Local planning runs are stateless (no session resume).
- The local endpoint must be running with a model loaded for planning to work.
- When localToolMode=off, the local model should end its response with "HANDOFF: true" to request coding.
- When localToolMode=read_only, only read commands are allowed (ls, rg, cat, git status, etc.).
- Token limits: 30 tool turns max, 300k tokens total by default, 5 tools per turn max, 1MB output per command.
- Guards: Dangerous command blocklist (rm -rf, sudo, dd, fdisk, format, shutdown, reboot, halt, poweroff, pkill, kill -9).
`;
