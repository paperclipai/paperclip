export const type = "ollama_local";
export const label = "Ollama (local)";

export const DEFAULT_OLLAMA_LOCAL_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_LOCAL_MODEL = "llama3.1:8b";

// Curated default list. The actual selection comes from `listOllamaModels`,
// which queries the configured Ollama instance for what's pulled locally.
export const models = [
  { id: "llama3.1:8b", label: "llama3.1:8b" },
  { id: "llama3.1:70b", label: "llama3.1:70b" },
  { id: "qwen2.5:14b", label: "qwen2.5:14b" },
  { id: "qwen2.5:32b", label: "qwen2.5:32b" },
  { id: "mistral:7b", label: "mistral:7b" },
  { id: "phi3:mini", label: "phi3:mini" },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

A thin adapter that POSTs the agent's wake prompt to a local Ollama server
and returns the reply text. Designed for non-coding "thinking" agents:
research, triage, status updates, summarization, scheduling, decision-making.

Compared to other local adapters:
- claude_local / codex_local — full agent runtimes (file editing, tools, etc.)
- aider_local — coding agent that edits files
- ollama_local — just inference + reply, no tools, no file editing

Core fields:
- model (string, optional): Ollama model tag, e.g. "llama3.1:8b". Defaults to ${DEFAULT_OLLAMA_LOCAL_MODEL}.
- ollamaBaseUrl (string, optional): URL of the local Ollama HTTP API. Defaults to ${DEFAULT_OLLAMA_LOCAL_BASE_URL}.
- promptTemplate (string, optional): overrides the standard Paperclip wake prompt template.
- systemPrompt (string, optional): system message prepended to the conversation. Defaults to the agent's "capabilities" field.
- temperature (number, optional): sampling temperature 0.0–2.0. Defaults to Ollama's default (0.8).
- numPredict (number, optional): max tokens to generate. Defaults to Ollama's default (-1 = unlimited).
- timeoutSec (number, optional): request timeout in seconds. Defaults to 600 (10 min).

Notes:
- Ollama must be running locally (\`ollama serve\`) and the requested model must
  be pulled (\`ollama pull <model>\`). The adapter auto-pulls missing models on
  first run, streaming progress to the run log.
- Ollama is unauthenticated, so this adapter has no Sign-in flow. The Adapters
  page shows a "Local Ollama (N models)" badge when reachable.
- This adapter does not support tool calling, file editing, or multi-turn
  workflows in v1 — the agent reads context, the model writes a reply, that
  reply becomes the run output. For coding agents that need file edits, use
  aider_local. For agents that need to act on the Paperclip API directly
  (post comments, update issues), make sure the system prompt instructs the
  model to format its reply as the desired action.
`;
