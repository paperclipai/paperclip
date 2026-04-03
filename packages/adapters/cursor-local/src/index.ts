export const type = "cursor";
export const label = "Cursor CLI (local)";
export const DEFAULT_CURSOR_LOCAL_MODEL = "auto";

const CURSOR_FALLBACK_MODEL_IDS = [
  "auto",
  "composer-2-fast",
  "composer-2",
  "composer-1.5",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-low-fast",
  "gpt-5.3-codex",
  "gpt-5.3-codex-fast",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-high-fast",
  "gpt-5.3-codex-xhigh",
  "gpt-5.3-codex-xhigh-fast",
  "gpt-5.2",
  "gpt-5.3-codex-spark-preview-low",
  "gpt-5.3-codex-spark-preview",
  "gpt-5.3-codex-spark-preview-high",
  "gpt-5.3-codex-spark-preview-xhigh",
  "gpt-5.2-codex-low",
  "gpt-5.2-codex-low-fast",
  "gpt-5.2-codex",
  "gpt-5.2-codex-fast",
  "gpt-5.2-codex-high",
  "gpt-5.2-codex-high-fast",
  "gpt-5.2-codex-xhigh",
  "gpt-5.2-codex-xhigh-fast",
  "gpt-5.1-codex-max-low",
  "gpt-5.1-codex-max-low-fast",
  "gpt-5.1-codex-max-medium",
  "gpt-5.1-codex-max-medium-fast",
  "gpt-5.1-codex-max-high",
  "gpt-5.1-codex-max-high-fast",
  "gpt-5.1-codex-max-xhigh",
  "gpt-5.1-codex-max-xhigh-fast",
  "gpt-5.4-high",
  "gpt-5.4-high-fast",
  "gpt-5.4-xhigh-fast",
  "claude-4.6-opus-high-thinking",
  "gpt-5.4-low",
  "gpt-5.4-medium",
  "gpt-5.4-medium-fast",
  "gpt-5.4-xhigh",
  "claude-4.6-sonnet-medium",
  "claude-4.6-sonnet-medium-thinking",
  "claude-4.6-opus-high",
  "claude-4.6-opus-max",
  "claude-4.6-opus-max-thinking",
  "claude-4.5-opus-high",
  "claude-4.5-opus-high-thinking",
  "gpt-5.2-low",
  "gpt-5.2-low-fast",
  "gpt-5.2-fast",
  "gpt-5.2-high",
  "gpt-5.2-high-fast",
  "gpt-5.2-xhigh",
  "gpt-5.2-xhigh-fast",
  "gemini-3.1-pro",
  "gpt-5.4-mini-none",
  "gpt-5.4-mini-low",
  "gpt-5.4-mini-medium",
  "gpt-5.4-mini-high",
  "gpt-5.4-mini-xhigh",
  "gpt-5.4-nano-none",
  "gpt-5.4-nano-low",
  "gpt-5.4-nano-medium",
  "gpt-5.4-nano-high",
  "gpt-5.4-nano-xhigh",
  "grok-4-20",
  "grok-4-20-thinking",
  "claude-4.5-sonnet",
  "claude-4.5-sonnet-thinking",
  "gpt-5.1-low",
  "gpt-5.1",
  "gpt-5.1-high",
  "gemini-3-pro",
  "gemini-3-flash",
  "gpt-5.1-codex-mini-low",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-high",
  "claude-4-sonnet",
  "claude-4-sonnet-1m",
  "claude-4-sonnet-thinking",
  "claude-4-sonnet-1m-thinking",
  "gpt-5-mini",
  "kimi-k2.5",
];

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
