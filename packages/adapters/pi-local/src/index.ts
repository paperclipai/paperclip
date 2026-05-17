import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "pi_local";
export const label = "Pi (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent@0.74.0";

export const models: Array<{ id: string; label: string }> = [];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# pi_local agent configuration

Adapter: pi_local

Use when:
- You want Paperclip to run Pi (the AI coding agent) locally as the agent runtime
- You want provider/model routing in Pi format (--provider <name> --model <id>)
- You want Pi session resume across heartbeats via --session
- You need Pi's tool set (read, bash, edit, write, grep, find, ls)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Pi CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template passed via -p flag
- model (string, required): Pi model id in provider/model format (for example xai/grok-4)
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh)
- command (string, optional): defaults to "pi"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Pi supports multiple providers and models. Use \`pi --list-models\` to list available options.
- Paperclip requires an explicit \`model\` value for \`pi_local\` agents.
- Sessions are stored in ~/.pi/paperclips/ and resumed with --session.
- All tools (read, bash, edit, write, grep, find, ls) are enabled by default.
- Agent instructions are appended to Pi's system prompt via --append-system-prompt, while the user task is sent via -p.

Ollama manual configuration:
- Download Ollama from https://ollama.com
- Source: https://docs.ollama.com/integrations/pi
- Create/edit \`~/.pi/agent/models.json\`:

  {
    "providers": {
      "ollama": {
        "baseUrl": "http://localhost:11434/v1",
        "api": "openai-completions",
        "apiKey": "ollama",
        "models": [
          { "id": "qwen3-coder" }
        ]
      }
    }
  }

- Create/edit \`~/.pi/agent/settings.json\`:

  {
    "defaultProvider": "ollama",
    "defaultModel": "qwen3-coder"
  }

- Then set \`adapterConfig.model\` to \`ollama/qwen3-coder\` (or the model you configured).

API keys:
- Ollama local instances use \`"apiKey": "ollama"\` as a placeholder (no real key needed).
- Cloud providers (OpenAI, Anthropic) require a real API key in \`apiKey\` or \`auth.json\`.
- Alternatively, pass API keys via the Paperclip \`adapterConfig.env\` field instead of hard-coding them in \`models.json\`.

Important: Claude Code vs Pi model IDs:
- \`kimi-k2.6:cloud\` is a Claude Code harness identifier, NOT a Pi model ID.
- Pi uses \`provider/model\` format (e.g. \`anthropic/claude-sonnet-4-20250514\`).
- To use Anthropic models through Pi, configure the provider in \`models.json\` (see below).

Anthropic configuration:
- Create/edit \`~/.pi/agent/models.json\`:

  {
    "providers": {
      "anthropic": {
        "baseUrl": "https://api.anthropic.com",
        "api": "anthropic-messages",
        "apiKey": "ANTHROPIC_API_KEY",
        "models": [
          { "id": "claude-sonnet-4-20250514" }
        ]
      }
    }
  }

- Create/edit \`~/.pi/agent/settings.json\`:

  {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-20250514"
  }

- Then set \`adapterConfig.model\` to \`anthropic/claude-sonnet-4-20250514\`.
- The \`apiKey\` field accepts: a literal key, an env var name, or \`!command\` for shell execution.
- Authentication resolution order (highest to lowest):
  1. CLI \`--api-key\` flag
  2. \`~/.pi/agent/auth.json\` entry
  3. Environment variable (e.g. \`ANTHROPIC_API_KEY\`)
  4. Custom provider key from \`models.json\`
`;
