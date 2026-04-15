export const type = "openrouter_local";
export const label = "OpenRouter";
export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.1-flash-lite-preview";
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

export const models = [
  { id: "google/gemma-4-26b-a4b-it", label: "Gemma 4 26B — $0.08/$0.35" },
  { id: "google/gemma-4-31b-it", label: "Gemma 4 31B — $0.13/$0.38" },
  { id: "minimax/minimax-m2.7", label: "MiniMax M2.7 — $0.30/$1.20" },
  { id: "z-ai/glm-5.1", label: "GLM-5.1 — $0.95/$3.15" },
  { id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite — $0.25/$1.50" },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6 — $3/$15 ★ owner only" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro — $2/$12 ★ owner only" },
];

export const agentConfigurationDoc = `# openrouter_local agent configuration

Adapter: openrouter_local

Use when:
- You want access to multiple AI models via a single API key
- You want to switch models without redeploying
- You do not need local tool use or file system access

Don't use when:
- You need a local CLI-based agent with tool use and file access (use gemini_local, claude_local)
- You need session resumption across heartbeats

## Model selection guide

CHEAP — use for routine tasks, summaries, status updates, simple Q&A:
- google/gemma-4-26b-a4b-it   $0.08 in / $0.35 out per 1M tokens  (DEFAULT)
- google/gemma-4-31b-it        $0.13 in / $0.38 out per 1M tokens
- minimax/minimax-m2.7         $0.30 in / $1.20 out per 1M tokens

MID — use for moderately complex reasoning, code review, planning:
- z-ai/glm-5.1                       $0.95 in / $3.15 out per 1M tokens
- google/gemini-3.1-flash-lite-preview  $0.25 in / $1.50 out per 1M tokens

PREMIUM — use only for complex multi-step tasks, architecture decisions, critical reviews:
- anthropic/claude-sonnet-4.6        $3.00 in / $15.00 out per 1M tokens
- google/gemini-3.1-pro-preview      $2.00 in / $12.00 out per 1M tokens

Default model: google/gemini-3.1-flash-lite-preview. Only upgrade when the task clearly requires it.
Most team members (junior devs, QA, support) should stay on CHEAP or MID tier.
PREMIUM models (marked ★) must NEVER be selected by agents — they are reserved for manual configuration by the owner only.

Core fields:
- model (string, required): OpenRouter model ID (see list above)
- apiKey (string, optional): OPENROUTER_API_KEY override; falls back to server environment variable
- systemPrompt (string, optional): system message prepended to every request
- promptTemplate (string, optional): run prompt template
- bootstrapPromptTemplate (string, optional): one-time bootstrap prompt for the first run
- maxTokens (number, optional): maximum output tokens (default: 8192)
- temperature (number, optional): sampling temperature 0.0-2.0 (default: 0.7)
- maxSteps (number, optional): maximum agentic tool-call steps per run (default: 20)
- baseUrl (string, optional): override OpenRouter API base URL

Operational fields:
- timeoutSec (number, optional): request timeout in seconds (default: 300)
`;
