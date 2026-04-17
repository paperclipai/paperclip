export const type = "copilot_local";
export const label = "GitHub Copilot (local)";

export const DEFAULT_COPILOT_MODEL = "claude-sonnet-4-5";

export const COPILOT_API_BASE_URL = "https://api.githubcopilot.com";
// NOTE: This is an undocumented internal endpoint with no stability guarantees.
// GitHub may rename, gate, or remove it without a deprecation notice.
export const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

export const models: Array<{ id: string; label: string }> = [
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5 (via Copilot)" },
  { id: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet (via Copilot)" },
  { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (via Copilot)" },
  { id: "gpt-4o", label: "GPT-4o (via Copilot)" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini (via Copilot)" },
  { id: "o3-mini", label: "o3-mini (via Copilot)" },
  { id: "gemini-2.0-flash-001", label: "Gemini 2.0 Flash (via Copilot)" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- You have a GitHub Copilot subscription and want to use it as your AI backend
- You want to avoid separate API billing for Claude, GPT-4o, or Gemini
- You want to run the Claude CLI locally but route through your Copilot subscription
- Your team has Copilot Business/Enterprise licenses you want to leverage

Don't use when:
- You don't have a GitHub Copilot subscription
- You need models not available through Copilot
- You need webhook-style invocation (use http or openclaw_gateway)

Core fields:
- model (string, optional): Model ID. Defaults to claude-sonnet-4-5.
  Claude models run via the Claude CLI; OpenAI/Gemini models require the openai-compatible CLI.
- cwd (string, optional): default absolute working directory for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file
- promptTemplate (string, optional): run prompt template
- command (string, optional): agent CLI to invoke. Defaults to "claude".
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Auth (one of the following):
- env.GITHUB_TOKEN: GitHub PAT with \`read:user\` or \`copilot\` scope
- env.GITHUB_COPILOT_TOKEN: a pre-fetched short-lived Copilot token (skips exchange)
- If neither is set, falls back to \`gh auth token\` from the GitHub CLI

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- A GitHub PAT is exchanged for a short-lived Copilot API token (TTL ~30 min) automatically.
- The Copilot API is OpenAI-compatible. Claude models work via ANTHROPIC_BASE_URL override.
- For Claude models the adapter runs the \`claude\` CLI by default.
- Copilot model availability depends on your subscription tier and GitHub's current rollout.
`;
