export const type = "cursor";
export const label = "Cursor CLI (local)";
export const DEFAULT_CURSOR_LOCAL_MODEL = "auto";

const CURSOR_MODEL_ALIASES: Record<string, string> = {
  "composer-1": "composer-1.5",
  "gpt-5.1-codex-max": "gpt-5.1-codex-max-medium",
  "opus-4.6": "claude-4.6-opus-high",
  "opus-4.6-thinking": "claude-4.6-opus-high-thinking",
  "opus-4.5": "claude-4.5-opus-high",
  "opus-4.5-thinking": "claude-4.5-opus-high-thinking",
  "sonnet-4.6": "claude-4.6-sonnet-medium",
  "sonnet-4.6-thinking": "claude-4.6-sonnet-medium-thinking",
  "sonnet-4.5": "claude-4.5-sonnet",
  "sonnet-4.5-thinking": "claude-4.5-sonnet-thinking",
  "gemini-3-pro": "gemini-3.1-pro",
  "grok": "grok-4-20",
};

export function normalizeCursorModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  return CURSOR_MODEL_ALIASES[trimmed] ?? trimmed;
}

const CURSOR_FALLBACK_MODEL_IDS = Array.from(new Set([
  "auto",
  "composer-2-fast",
  "composer-2",
  "composer-1.5",
  "composer-1",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-low-fast",
  "gpt-5.3-codex",
  "gpt-5.3-codex-fast",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-high-fast",
  "gpt-5.3-codex-xhigh",
  "gpt-5.3-codex-xhigh-fast",
  "gpt-5.3-codex-spark-preview",
  "gpt-5.2",
  "gpt-5.2-codex-low",
  "gpt-5.2-codex-low-fast",
  "gpt-5.2-codex",
  "gpt-5.2-codex-fast",
  "gpt-5.2-codex-high",
  "gpt-5.2-codex-high-fast",
  "gpt-5.2-codex-xhigh",
  "gpt-5.2-codex-xhigh-fast",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-medium",
  "gpt-5.1-codex-max-high",
  "gpt-5.2-high",
  "gpt-5.1-high",
  "gpt-5.1-codex-mini",
  "opus-4.6-thinking",
  "opus-4.6",
  "opus-4.5",
  "opus-4.5-thinking",
  "sonnet-4.6",
  "sonnet-4.6-thinking",
  "sonnet-4.5",
  "sonnet-4.5-thinking",
  "claude-4.6-opus-high",
  "claude-4.6-opus-high-thinking",
  "claude-4.6-opus-max",
  "claude-4.6-opus-max-thinking",
  "claude-4.6-sonnet-medium",
  "claude-4.6-sonnet-medium-thinking",
  "claude-4.5-opus-high",
  "claude-4.5-opus-high-thinking",
  "claude-4.5-sonnet",
  "claude-4.5-sonnet-thinking",
  "gemini-3.1-pro",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok",
  "grok-4-20",
  "grok-4-20-thinking",
  "kimi-k2.5",
].map(normalizeCursorModelId)));

export const models = CURSOR_FALLBACK_MODEL_IDS.map((id) => ({ id, label: id }));

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
- model (string, optional): Cursor model id (for example auto or claude-4.6-sonnet-medium-thinking)
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
