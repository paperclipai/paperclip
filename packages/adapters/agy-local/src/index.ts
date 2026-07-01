export const type = "agy_local";
export const label = "Antigravity (agy)";

export const SANDBOX_INSTALL_COMMAND =
  "curl -fsSL https://antigravity.google/cli/install.sh | bash && agy auth login";

export const DEFAULT_AGY_MODEL = "gemini-2.5-flash";

export const models: Array<{ id: string; label: string }> = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (via Antigravity)" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6 (via Antigravity)" },
];

export const agentConfigurationDoc = `# agy_local agent configuration

Adapter: agy_local

Use when:
- You want Paperclip to run the Google Antigravity CLI (agy) locally as the agent runtime
- You have a Google One AI Premium, Workspace, or Play subscription (no API key required)
- gemini_local is not working — agy is Google's official replacement for Gemini CLI

Don't use when:
- You need session resume across heartbeats (agy is stateless per run)
- agy is not installed on the host machine

## Prerequisites

- Install agy: \`curl -fsSL https://antigravity.google/cli/install.sh | bash\`
- Authenticate: \`agy auth login\` (Google OAuth — interactive, run once on the server)
- Auth token stored at: \`~/.gemini/antigravity-cli/antigravity-oauth-token\`

## Core fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| cwd | string | (workspace dir) | Working directory for the agent process (created if missing) |
| instructionsFilePath | string | — | Absolute path to a markdown instructions file prepended to the run prompt |
| promptTemplate | string | — | Run prompt template |
| model | string | gemini-2.5-flash | Model ID passed to --model |
| timeoutSec | number | 600 | Run timeout in seconds |
| graceSec | number | 15 | SIGTERM grace period before SIGKILL |
| env | object | — | KEY=VALUE environment variables injected into the agy process |

## Notes

- Runs use \`agy --print <prompt> --dangerously-skip-permissions\` for non-interactive execution.
- agy does not support session resume; each heartbeat starts a fresh run.
- Output is plain text (agy --print writes to stdout).
- Billing: $0 — auth via subscription, no usage tracking.
`;
