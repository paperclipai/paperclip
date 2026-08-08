export const type = "ollama_local";
export const label = "Ollama";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Core fields:
- baseUrl (string, optional): Ollama server URL, default http://127.0.0.1:11434
- apiMode (select, optional): openai (default, /v1/chat/completions) or ollama (/api/chat)
- model (string, required): installed Ollama model name, for example qwen3:8b
- apiKey (string, optional): bearer token for a protected OpenAI-compatible endpoint
- stream (boolean, optional): stream response deltas to the Paperclip run log, default true
- tools (array, optional): native OpenAI tool declarations
- responseFormat (object, optional): native response_format JSON/schema declaration
- timeoutSec (number, optional): request timeout, default 300

This adapter is available-but-unused until an agent is explicitly configured with adapterType ollama_local.
`;

export { execute, testEnvironment, sessionCodec } from "./server/index.js";
