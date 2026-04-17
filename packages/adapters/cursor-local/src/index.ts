export const type = "cursor";
export const label = "Cursor CLI (local)";
export const DEFAULT_CURSOR_LOCAL_MODEL = "auto";

// Fallback models shown when `agent models` CLI discovery is unavailable.
// IDs must match exactly what `agent --model <id>` accepts.
const CURSOR_FALLBACK_MODELS: { id: string; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "composer-2-fast", label: "Composer 2 Fast" },
  { id: "composer-2", label: "Composer 2" },
  { id: "composer-1.5", label: "Composer 1.5" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.3-codex-fast", label: "GPT-5.3 Codex Fast" },
  { id: "gpt-5.3-codex-high", label: "GPT-5.3 Codex High" },
  { id: "gpt-5.3-codex-high-fast", label: "GPT-5.3 Codex High Fast" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { id: "gpt-5.2-codex-fast", label: "GPT-5.2 Codex Fast" },
  { id: "gpt-5.2-codex-high", label: "GPT-5.2 Codex High" },
  { id: "gpt-5.2-codex-high-fast", label: "GPT-5.2 Codex High Fast" },
  { id: "gpt-5.2-high", label: "GPT-5.2 High" },
  { id: "gpt-5.1-codex-max-medium", label: "GPT-5.1 Codex Max" },
  { id: "gpt-5.1-codex-max-high", label: "GPT-5.1 Codex Max High" },
  { id: "gpt-5.1-high", label: "GPT-5.1 High" },
  { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
  { id: "gpt-5.4-medium", label: "GPT-5.4 1M" },
  { id: "gpt-5.4-high", label: "GPT-5.4 1M High" },
  { id: "claude-4.6-opus-high-thinking", label: "Opus 4.6 1M Thinking" },
  { id: "claude-4.6-opus-high", label: "Opus 4.6 1M" },
  { id: "claude-4.6-opus-max-thinking", label: "Opus 4.6 1M Max Thinking" },
  { id: "claude-4.6-sonnet-medium", label: "Sonnet 4.6 1M" },
  { id: "claude-4.6-sonnet-medium-thinking", label: "Sonnet 4.6 1M Thinking" },
  { id: "claude-4.5-opus-high", label: "Opus 4.5" },
  { id: "claude-4.5-opus-high-thinking", label: "Opus 4.5 Thinking" },
  { id: "claude-4.5-sonnet", label: "Sonnet 4.5 1M" },
  { id: "claude-4.5-sonnet-thinking", label: "Sonnet 4.5 1M Thinking" },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash" },
  { id: "grok-4-20", label: "Grok 4.20" },
  { id: "kimi-k2.5", label: "Kimi K2.5" },
];

export const models = CURSOR_FALLBACK_MODELS;

export const agentConfigurationDoc = `# cursor agent configuration

Adapter: cursor

Use when:
- You want Paperclip to run Cursor Agent CLI locally as the agent runtime
- You want Cursor chat session resume across heartbeats via --resume
- You want structured stream output in run logs via --output-format stream-json

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Cursor Agent CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Cursor model id (for example auto or gpt-5.3-codex)
- mode (string, optional): Cursor execution mode passed as --mode (plan|ask). Leave unset for normal autonomous runs.
- command (string, optional): defaults to "agent"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs are executed with: agent -p --output-format stream-json ...
- Prompts are piped to Cursor via stdin.
- Sessions are resumed with --resume when stored session cwd matches current cwd.
- Paperclip auto-injects local skills into "~/.cursor/skills" when missing, so Cursor can discover "$paperclip" and related skills on local runs.
- Paperclip auto-adds --yolo unless one of --trust/--yolo/-f is already present in extraArgs.
`;
