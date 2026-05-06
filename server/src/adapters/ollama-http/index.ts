import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const ollamaHttpAdapter: ServerAdapterModule = {
  type: "ollama_http",
  execute,
  testEnvironment,
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: `# ollama_http agent configuration

Adapter: ollama_http

Use when:
- You want Paperclip to talk directly to an Ollama-compatible HTTP API
- You want auto-selection from the remote /api/tags model catalog
- You need a quota fallback target for claude_local without using an OpenClaw websocket gateway

Core fields:
- baseUrl (string, required): Ollama HTTP base URL (for example https://ollama-api.example.com)
- tagsUrl (string, optional): model discovery endpoint; defaults to <baseUrl>/api/tags
- chatUrl (string, optional): chat endpoint; defaults to <baseUrl>/api/chat
- model (string, optional): explicit model id; use "auto" or omit to auto-select from /api/tags
- modelPreference (string, optional): auto-selection bias (coding|general)
- headers (object, optional): request headers
- timeoutSec (number, optional): request timeout in seconds
- stream (boolean, optional): stream native Ollama chat responses; defaults to true to avoid reverse-proxy idle/read timeouts
- temperature (number, optional): optional Ollama temperature override
- keepAlive (string, optional): optional Ollama keep_alive value

Prompt fields:
- promptTemplate (string, optional): Paperclip heartbeat prompt template
- bootstrapPromptTemplate (string, optional): optional bootstrap prompt for fresh sessions
- instructionsFilePath (string, optional): markdown instructions prepended to the prompt

Notes:
- This adapter is stateless; it does not persist provider-side sessions.
- When model is omitted, Paperclip fetches /api/tags and picks the best fit automatically.
- This adapter uses Ollama's native HTTP API, not the OpenClaw websocket gateway protocol.
`,
};