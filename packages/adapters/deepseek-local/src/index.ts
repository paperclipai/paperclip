export const type = "deepseek_local";
export const label = "DeepSeek";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

export const models: Array<{ id: string; label: string }> = [
  { id: "deepseek-chat", label: "DeepSeek Chat (V3)" },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)" },
];

export const agentConfigurationDoc = `# deepseek_local agent configuration

Adapter: deepseek_local

Use when:
- You want Paperclip to call DeepSeek's hosted models directly via the
  OpenAI-compatible Chat Completions API.
- A DeepSeek API key is available either through Paperclip secrets, the agent
  env config, or the DEEPSEEK_API_KEY environment variable on the server.

Don't use when:
- You need full agent tool use (read/edit/bash). This adapter is a
  single-shot completion runtime intended for LLM-only workloads and smoke
  tests; pair DeepSeek with opencode_local if you need a tool-using runtime.

Core fields:
- model (string, optional): DeepSeek model id. Defaults to "deepseek-chat".
  Common values: "deepseek-chat" (V3), "deepseek-reasoner" (R1).
- baseUrl (string, optional): override DeepSeek API base URL. Defaults to
  https://api.deepseek.com/v1.
- apiKey (string, optional): plaintext API key. Prefer env bindings
  (env.DEEPSEEK_API_KEY) so values can come from Paperclip secrets.
- env (object, optional): KEY=VALUE bindings. DEEPSEEK_API_KEY is the
  canonical place to wire the secret.
- promptTemplate (string, optional): user prompt template; defaults to the
  Paperclip wake prompt.
- systemPrompt (string, optional): system prompt prepended to every request.
  When omitted, falls back to the agent instructions file (if any).
- instructionsFilePath (string, optional): absolute path to a markdown file
  injected as the system prompt at runtime.
- temperature (number, optional): sampling temperature (default 0.2).
- maxTokens (number, optional): max output tokens (default 4096).

Operational fields:
- timeoutSec (number, optional): request timeout in seconds (default 120).

Notes:
- DeepSeek's API is OpenAI-compatible. Authentication uses
  "Authorization: Bearer <DEEPSEEK_API_KEY>".
- This adapter performs a single non-streaming chat completion per heartbeat.
  Use it for simple agent loops, smoke tests, or benchmarking. For
  iterative tool use, configure opencode_local with a deepseek/* model.
- Cost/quota policy lives outside this adapter; rate limits and pricing are
  managed in DeepSeek's dashboard.
`;
