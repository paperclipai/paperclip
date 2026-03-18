export const MISTRAL_LOCAL_ADAPTER_TYPE = "mistral_local" as const;

export const DEFAULT_MISTRAL_MODEL = "mistral-medium-latest";

export const models = [
  { id: "mistral-medium-latest", label: "Mistral Medium 2508 — 375K tok/min, no monthly cap (recommended)" },
  { id: "mistral-large-2411", label: "Mistral Large 2411 — 600K tok/min, 200B tok/month" },
  { id: "labs-leanstral-2603", label: "Leanstral 2603 (labs) — 1M tok/min, no monthly cap" },
  { id: "magistral-medium-latest", label: "Magistral Medium — 75K tok/min, 1B tok/month, chain-of-thought" },
  { id: "magistral-small-latest", label: "Magistral Small — 75K tok/min, 1B tok/month" },
  { id: "devstral-latest", label: "Devstral (latest) — 50K tok/min, 4M tok/month" },
  { id: "mistral-small-latest", label: "Mistral Small (latest) — 50K tok/min, 4M tok/month" },
  { id: "mistral-large-latest", label: "Mistral Large (latest) — 50K tok/min, 4M tok/month" },
];

export const agentConfigurationDoc = `# mistral_local agent configuration

Adapter: mistral_local

Use when:
- You want Paperclip to call the Mistral API directly on each heartbeat
- You want to use Mistral models without a local CLI install
- You have a MISTRAL_API_KEY available in the environment

Don't use when:
- You need a full local agentic loop with file edits and tool use (use claude_local or opencode_local)
- You need webhook-style external invocation (use openclaw_gateway or http)

## Model Selection Guide (Free Tier — verified against live dashboard)

| Model | Tokens/min | Tokens/month | Best for |
|-------|-----------|--------------|----------|
| mistral-medium-latest | 375,000 | No cap | General tasks (recommended default) |
| mistral-large-2411 | 600,000 | ~200B (unlimited) | High-volume, legacy |
| labs-leanstral-2603 | 1,000,000 | No cap | Highest throughput available |
| magistral-medium-latest | 75,000 | 1B | Complex reasoning / planning |
| magistral-small-latest | 75,000 | 1B | Lightweight reasoning |
| devstral-latest | 50,000 | 4M | Coding (same pool as standard) |
| mistral-small-latest | 50,000 | 4M | Use sparingly |
| mistral-large-latest | 50,000 | 4M | Use sparingly |

⚠️ Note: devstral-latest shares the standard 4M tokens/month pool. For sustained agent workloads,
prefer mistral-medium-latest (no monthly cap) or mistral-large-2411 (effectively unlimited).

The global free tier limit is 1 request per second per API key regardless of model.

## Core fields:
- model (string, optional): Mistral model id. Defaults to mistral-medium-latest.
- promptTemplate (string, optional): run prompt template
- maxTokens (number, optional): maximum tokens to generate (default: 4096)
- cwd (string, optional): working directory context passed to the model
- env (object, optional): KEY=VALUE environment variables

## Notes:
- MISTRAL_API_KEY must be set in the environment or in the env config field.
- Mistral's API endpoint is OpenAI-compatible: https://api.mistral.ai/v1
- Each heartbeat sends a fresh request; sessions are not resumed across heartbeats.
`;
