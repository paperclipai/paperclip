export const type = "ollama_local";
export const label = "Ollama (local)";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";
export const DEFAULT_OLLAMA_CONTEXT_WINDOW = 8192;
export const DEFAULT_OLLAMA_KEEP_ALIVE_SEC = 300;
export const DEFAULT_OLLAMA_REQUEST_TIMEOUT_SEC = 600;
export const DEFAULT_OLLAMA_TEMPERATURE = 0.7;
export const DEFAULT_OLLAMA_TOP_P = 0.9;

export const models: Array<{ id: string; label: string }> = [
  { id: "llama3.1:8b", label: "Llama 3.1 8B (default)" },
  { id: "llama3.1:70b", label: "Llama 3.1 70B" },
  { id: "qwen2.5:7b", label: "Qwen 2.5 7B" },
  { id: "qwen2.5:14b", label: "Qwen 2.5 14B" },
  { id: "mistral:7b", label: "Mistral 7B" },
  { id: "deepseek-coder:6.7b", label: "DeepSeek Coder 6.7B" },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Runs a local Ollama server (\`http://127.0.0.1:11434\` by default) as the agent
runtime. The adapter streams tokens from \`POST /api/chat\` using NDJSON and
surfaces the final assistant message as the run summary.

Use when:
- You want Paperclip to drive a local LLM served by Ollama
- You run in a fully offline/local environment with no cloud adapter
- You want a simple chat-response loop (no external tools — v1 is chat-only)

Don't use when:
- You need full coding-agent tool use (file edits, bash) — use claude_local / codex_local / pi_local
- You need remote model hosts or TLS/bearer auth — this adapter is local-only in v1

Core fields:
- baseUrl (string, optional): Ollama HTTP endpoint. Default \`http://127.0.0.1:11434\`.
- model (string, required): Ollama model tag (e.g. \`llama3.1:8b\`). Must be \`ollama pull\`ed locally.
- contextWindow (number, optional): \`num_ctx\` option. Default 8192.
- keepAliveSec (number, optional): Ollama \`keep_alive\` (seconds). Default 300.
- requestTimeoutSec (number, optional): per-request timeout. Default 600.
- maxOutputTokens (number, optional): \`num_predict\` option. Default unset (Ollama default).
- temperature (number, optional): sampling temperature. Default 0.7.
- topP (number, optional): nucleus sampling. Default 0.9.
- instructionsFilePath (string, optional): absolute path to a markdown file prepended as system message.
- promptTemplate (string, optional): user-turn prompt template.

Notes:
- v1 is stateless — the full transcript is sent every heartbeat (no session resume).
- Ollama does not signal context overflow; the adapter emits a \`context_truncated\`
  warning when \`prompt_eval_count >= contextWindow\`.
- License surface for the model is enforced at the plugin UI layer (M2).
`;
