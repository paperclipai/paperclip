export const type = "mistral_local";
export const label = "Mistral Vibe CLI (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g mistral-vibe";

export const DEFAULT_MISTRAL_LOCAL_MODEL = "codestral-latest";

export const models: Array<{ id: string; label: string }> = [
  { id: "codestral-latest", label: "Codestral (latest) — code-optimised" },
  { id: "devstral-small", label: "Devstral Small — lightweight agentic" },
  { id: "mistral-medium-3.5", label: "Mistral Medium 3.5" },
  { id: "mistral-large-latest", label: "Mistral Large (latest)" },
  { id: "mistral-small-latest", label: "Mistral Small (latest)" },
];

export const agentConfigurationDoc = `# mistral_local agent configuration

Adapter: mistral_local

Use when:
- You want Paperclip to run the Mistral Vibe CLI locally as the agent runtime
- You want Codestral or Devstral for code-heavy tasks ($0 on La Plateforme free tier)
- You have a Mistral La Plateforme account (subscription or API key)

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need one-shot shell commands without an AI loop (use process)
- Vibe CLI is not installed on the host machine

## Prerequisites

- Install Vibe: \`npm install -g mistral-vibe\` (requires Node.js 20+)
- Configure: \`vibe --setup\` to log in to Mistral La Plateforme
- Or set \`MISTRAL_API_KEY\` in the agent env for API-key billing mode

## Model aliases

Vibe CLI uses model aliases defined in \`~/.vibe/config.toml\`. The \`model\` field
in the adapter config must match an alias defined there, not the raw API model id.
If a model alias is missing, Vibe will exit with "model not found in configuration".

The aliases used by the models listed above should be added to config.toml:

\`\`\`toml
[[models]]
name = "codestral-latest"
provider = "mistral"
alias = "codestral-latest"
\`\`\`

## Core fields

- cwd (string, optional): working directory for the agent process (created if missing)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Vibe model alias from config.toml. Defaults to codestral-latest.
- timeoutSec (number, optional): run timeout in seconds (default: 600)
- graceSec (number, optional): SIGTERM grace period before SIGKILL (default: 10)
- persistSession (boolean, optional): resume Vibe sessions across heartbeats (default: true)
- env (object, optional): KEY=VALUE environment variables — set MISTRAL_API_KEY here for API-key mode

## Billing

- No MISTRAL_API_KEY → billingType=\"subscription\", costUsd=null (\$0 on free tier)
- MISTRAL_API_KEY present → billingType=\"api\", metered by Mistral
`;
