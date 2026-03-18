export const type = "mistral_local";
export const label = "Mistral (local)";
export const DEFAULT_MISTRAL_MODEL = "mistral-medium-latest";

export const models = [
  { id: "mistral-medium-latest", label: "Mistral Medium (latest)" },
  { id: "mistral-small-latest", label: "Mistral Small (latest)" },
  { id: "mistral-large-latest", label: "Mistral Large (latest)" },
  { id: "codestral-latest", label: "Codestral (latest)" },
  { id: "open-mistral-nemo", label: "Mistral Nemo" },
];

export const agentConfigurationDoc = `# mistral_local agent configuration

Adapter: mistral_local

Use when:
- You want Paperclip to call the Mistral API directly on each heartbeat
- You want to use Mistral models (including Codestral for coding tasks)
- You have a MISTRAL_API_KEY available in the environment

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- You need a full local agentic loop with tool use (use claude_local or opencode_local)

Core fields:
- model (string, optional): Mistral model id. Defaults to mistral-medium-latest.
- promptTemplate (string, optional): run prompt template
- maxTokens (number, optional): maximum tokens to generate (default: 4096)
- cwd (string, optional): working directory context passed to the model
- env (object, optional): KEY=VALUE environment variables (must include MISTRAL_API_KEY if not set globally)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds (unused, kept for API compatibility)

Notes:
- MISTRAL_API_KEY must be set in the environment or in the env config field.
- Mistral's API endpoint is OpenAI-compatible: https://api.mistral.ai/v1
- Each heartbeat sends a fresh request; sessions are not resumed across heartbeats.
- Default model is mistral-medium-latest. Use codestral-latest for coding-focused tasks.
`;
