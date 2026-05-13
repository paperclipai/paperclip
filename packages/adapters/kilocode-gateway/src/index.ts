export const type = "kilocode_gateway";
export const label = "KiloCode Gateway";

export const models: { id: string; label: string }[] = [
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "anthropic/claude-opus-4", label: "Claude Opus 4" },
  { id: "openai/gpt-4o", label: "GPT-4o" },
  { id: "openai/gpt-4.1", label: "GPT-4.1" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
  { id: "deepseek/deepseek-v3", label: "DeepSeek V3" },
];

export const agentConfigurationDoc = `# kilocode_gateway agent configuration

Adapter: kilocode_gateway

Use when:
- You want Paperclip to invoke AI models via the KiloCode Gateway (OpenAI-compatible HTTP API).
- You need access to multiple providers (Anthropic, OpenAI, Google, DeepSeek) through a single endpoint.
- You prefer an OpenAI-compatible REST interface with SSE streaming.

Don't use when:
- You want local model execution or direct provider SDK integration.
- You do not have a KiloCode API key or access to the KiloCode gateway.

Core fields:
- apiKey (string, required): KiloCode Bearer API token. Can also be set via KILO_API_KEY env var.
- model (string, required): Model ID to use (e.g. "anthropic/claude-sonnet-4.5", "openai/gpt-4o").
- baseUrl (string, optional): KiloCode gateway base URL (default: https://api.kilo.ai/api/gateway).
- temperature (number, optional): Sampling temperature (default: 0.7).
- maxTokens (number, optional): Maximum tokens in completion (default: 8192).
- stream (boolean, optional): Enable SSE streaming (default: true).
- timeoutSec (number, optional): Request timeout in seconds (default: 120).
`;
