export const type = "deepseek_api";
export const label = "DeepSeek API";

export const models = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "deepseek-chat", label: "DeepSeek Chat (legacy alias)" },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner (legacy)" },
];

export const agentConfigurationDoc = `# deepseek_api agent configuration

Adapter: deepseek_api

Calls DeepSeek's OpenAI-compatible Chat Completions API directly with a
bring-your-own API key. Each Paperclip heartbeat becomes a single chat
completion turn. The adapter does not spawn a local process — it issues
an HTTPS request to https://api.deepseek.com/v1.

Core fields:
- model (string, optional): DeepSeek model id. Defaults to deepseek-v4-flash.
  deepseek-v4-pro is the strongest model; deepseek-v4-flash is faster/cheaper.
  Legacy ids deepseek-chat / deepseek-reasoner still resolve.
- baseUrl (string, optional): override the API base URL. Defaults to
  https://api.deepseek.com/v1.
- systemPrompt (string, optional): system message prepended to every turn.
- temperature (number, optional): sampling temperature (0.0 - 2.0).
- maxTokens (number, optional): cap on output tokens per turn.
- timeoutSec (number, optional): request timeout in seconds. Default 600.
- env.DEEPSEEK_API_KEY (string, required): DeepSeek API key from
  https://platform.deepseek.com.

Notes:
- Token usage (input/output) is captured from the API response and rolled
  into Paperclip cost telemetry.
- The adapter streams output incrementally via Server-Sent Events so logs
  appear live in the run timeline.
`;
