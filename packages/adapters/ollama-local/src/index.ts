import type { AdapterModel, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "ollama_local";
export const label = "Ollama (local)";

export const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:14b-instruct";

export const models: AdapterModel[] = [
  { id: "qwen2.5:14b-instruct", label: "qwen2.5:14b-instruct" },
  { id: "llama3.1:8b", label: "llama3.1:8b" },
  { id: "llama3.2:3b", label: "llama3.2:3b" },
  { id: "mistral:7b-instruct", label: "mistral:7b-instruct" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Smaller local Ollama model as the budget lane.",
    adapterConfig: {
      model: "llama3.2:3b",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip heartbeats to run against a locally-hosted Ollama instance.
- You want a fully on-prem / offline LLM runtime with no API costs.
- Chat-mode (no tool calls) is sufficient for the agent's job.

Don't use when:
- The agent needs real tool calls or file-edit capability (use claude_local / opencode_local).
- You need cloud-grade reasoning quality.
- Ollama is not installed on the Paperclip host.

Required fields:
- model (string): Ollama model tag, e.g. "qwen2.5:14b-instruct". Must already be pulled (\`ollama pull <model>\`).

Optional fields:
- endpoint (string): Ollama server base URL. Defaults to ${DEFAULT_OLLAMA_ENDPOINT}.
- options (object): Ollama generation options passed verbatim (temperature, num_ctx, top_p, ...).
- promptTemplate (string): run prompt template prepended to the wake context.
- timeoutSec (number): per-run timeout in seconds. Defaults to 300.
- postCommentToIssue (boolean): when true (default) and the wake carries an issueId,
  the adapter posts the model response to that issue as a comment on the agent's behalf.

Telemetry:
- tokensIn  ← Ollama \`prompt_eval_count\`
- tokensOut ← Ollama \`eval_count\`
- costUsd   = 0

Notes:
- Communication is a single HTTP POST to /api/chat (Ollama's native chat endpoint).
  Non-streaming (block) responses for MVP.
- The wake prompt is forwarded as the user message; \`promptTemplate\` (if set) is prepended.
- This adapter does not spawn a child process. It runs entirely in-band inside the
  Paperclip server's heartbeat call.
`;
