export const type = "blockrun";
export const label = "BlockRun";

export const models: { id: string; label: string }[] = [
  { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "openai/gpt-5.2", label: "GPT-5.2" },
  { id: "openai/gpt-4o", label: "GPT-4o" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  { id: "xai/grok-3", label: "Grok 3" },
  { id: "nvidia/gpt-oss-120b", label: "NVIDIA GPT-OSS 120B (Free)" },
];

export const agentConfigurationDoc = `# BlockRun adapter configuration

Adapter: blockrun

Use when:
- You want agents to call 30+ AI models through a single adapter.
- You want pay-per-request micropayments via x402 protocol on Base chain.
- You need automatic cost tracking with real on-chain settlement.
- You want to use smart model routing based on task complexity.

Don't use when:
- You need a full coding agent with file access (use claude_local/codex_local).
- You have no Base chain USDC for payments (use free nvidia/gpt-oss-120b model).

Core fields:
- walletPrivateKey (string, required): Base chain wallet private key for x402 payments. Use a Paperclip secret reference.
- model (string, optional): Model ID (e.g. "openai/gpt-4o"). If omitted, uses routingMode for smart selection.
- routingMode (string, optional): Smart routing mode when model is not set. One of: "fast", "balanced", "powerful", "cheap", "reasoning". Default: "balanced".

Tuning fields:
- maxTokens (number, optional): Maximum output tokens per request. Default: 4096.
- temperature (number, optional): Sampling temperature 0-2. Default: 0.7.
- systemPrompt (string, optional): Additional system instructions prepended to the agent prompt.
- maxHistoryMessages (number, optional): Max conversation turns to retain across heartbeats. Default: 20.

Operational fields:
- apiUrl (string, optional): BlockRun API base URL. Default: "https://blockrun.ai".
- timeoutSec (number, optional): Request timeout in seconds. Default: 120.

Supported models (30+):
- Anthropic: claude-opus-4-6, claude-sonnet-4-6
- OpenAI: gpt-5.2, gpt-4o, gpt-4o-mini, o3, o1
- Google: gemini-2.5-pro, gemini-2.5-flash
- DeepSeek: deepseek-chat, deepseek-reasoner
- xAI: grok-3
- NVIDIA: gpt-oss-120b (free)
- And more via blockrun.ai/models
`;
