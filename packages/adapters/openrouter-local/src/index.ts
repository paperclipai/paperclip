import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "openrouter_local";
export const label = "OpenRouter (local)";

export const DEFAULT_OPENROUTER_LOCAL_MODEL = "meta-llama/llama-3.1-405b-instruct:free";

export const models = [
  { id: "meta-llama/llama-3.1-405b-instruct:free", label: "Llama 3.1 405B (Free)" },
  { id: "meta-llama/llama-3.2-90b-vision-instruct:free", label: "Llama 3.2 90B Vision (Free)" },
  { id: "google/gemma-2-9b-it:free", label: "Gemma 2 9B (Free)" },
  { id: "mistralai/mistral-7b-instruct:free", label: "Mistral 7B Instruct (Free)" },
  { id: "microsoft/phi-3-mini-128k-instruct:free", label: "Phi-3 Mini (Free)" },
  { id: "qwen/qwen-2.5-coder-32b-instruct:free", label: "Qwen 2.5 Coder 32B (Free)" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
  { id: "anthropic/claude-3-haiku", label: "Claude 3 Haiku" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  { id: "openai/gpt-4-turbo", label: "GPT-4 Turbo" },
  { id: "google/gemini-pro-1.5", label: "Gemini Pro 1.5" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use a free OpenRouter model as the budget lane while preserving the primary model.",
    adapterConfig: {
      model: "mistralai/mistral-7b-instruct:free",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# openrouter_local agent configuration

Adapter: openrouter_local

Use when:
- You want Paperclip to use OpenRouter's API for accessing various LLM providers
- You want access to multiple model providers through a single API key
- You want cost-effective routing across different model providers
- You need fallback options across different model families

Don't use when:
- You only need a single provider's API (use provider-specific adapters)
- You require direct provider authentication and billing
- You need ultra-low latency (OpenRouter adds a proxy layer)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): OpenRouter model ID in format "provider/model-name". Defaults to meta-llama/llama-3.1-405b-instruct:free
- baseUrl (string, optional): OpenRouter API base URL. Defaults to https://openrouter.ai/api/v1
- apiKey (string, optional): OpenRouter API key. Can also be set via OPENROUTER_API_KEY env var
- maxTokens (number, optional): maximum tokens to generate
- temperature (number, optional): sampling temperature (0-2)
- topP (number, optional): nucleus sampling parameter
- topK (number, optional): top-k sampling parameter
- frequencyPenalty (number, optional): frequency penalty (-2 to 2)
- presencePenalty (number, optional): presence penalty (-2 to 2)
- stop (string[], optional): stop sequences
- responseFormat (string, optional): response format ("text" or "json")
- provider (object, optional): provider routing preferences
  - order (string[], optional): ordered list of provider slugs to try
  - allowFallbacks (boolean, optional): whether to allow provider fallbacks
  - ignore (string[], optional): providers to exclude
- extraHeaders (object, optional): additional headers to include in requests
- timeoutSec (number, optional): request timeout in seconds

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenRouter provides unified access to 100+ models across providers
- Free models are available with rate limits; paid models require credits
- Use the model ID format "provider/model-name" (e.g., "anthropic/claude-3.5-sonnet")
- Provider routing can optimize for price, latency, or reliability
- The adapter uses OpenRouter's REST API with streaming support
- Set OPENROUTER_API_KEY environment variable or configure apiKey directly
- Visit https://openrouter.ai/models for the full list of available models
`;
