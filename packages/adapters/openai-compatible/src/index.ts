export const type = "openai_compatible";
export const label = "OpenAI-compatible API";

/** Env key that holds the provider bearer key. Stored as a secret binding. */
export const OPENAI_COMPATIBLE_API_KEY_ENV = "OPENAI_COMPATIBLE_API_KEY";

export const DEFAULT_OPENAI_COMPATIBLE_MAX_TURNS = 40;
export const DEFAULT_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SEC = 300;
export const DEFAULT_OPENAI_COMPATIBLE_MAX_HISTORY_CHARS = 120_000;
export const DEFAULT_OPENAI_COMPATIBLE_SHELL_TIMEOUT_SEC = 120;

// Models come from the third-party provider, so there is no fixed catalog.
export const models: Array<{ id: string; label: string }> = [];

/**
 * Normalize a user-entered API URL to the provider base URL that
 * `/chat/completions` and `/models` are appended to. Accepts a pasted
 * `.../chat/completions` endpoint as well as a bare base URL.
 * Returns null when the value is not an http(s) URL.
 */
export function normalizeOpenAiCompatibleApiUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.search = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/chat\/completions$/i, "");
  url.pathname = pathname;
  return url.toString().replace(/\/+$/, "");
}

export const agentConfigurationDoc = `# openai_compatible agent configuration

Adapter: openai_compatible

Use when:
- The agent should run on a third-party LLM provider that exposes an OpenAI-compatible
  Chat Completions API (e.g. OpenRouter, Together, Groq, DeepSeek, Fireworks, vLLM,
  LM Studio, Ollama's /v1 endpoint, an internal LLM gateway)
- You only have an API URL, a model id, and an API key — no agent CLI installed
- The work is mostly coordination through the Paperclip API (triage, planning,
  writing comments and documents, delegating child issues)

Don't use when:
- The provider's model does not support tool/function calling (the agent loop needs it)
- The task needs a full coding harness with rich editing tools; prefer claude_local,
  codex_local, or opencode_local (opencode can also target custom providers)
- You need a remote sandbox for code execution; workspace tools here run on the
  Paperclip server host only

How it runs:
- Paperclip runs a tool-calling loop in the server process against
  {apiUrl}/chat/completions. No CLI is spawned.
- Built-in tools: paperclip_api_request (authenticated Paperclip REST calls for this
  run), load_skill (reads assigned Paperclip skills on demand), and — only when
  enableWorkspaceTools is true and execution is local — run_shell, read_file, write_file
  scoped to the workspace cwd.
- The conversation is persisted as the task session and resumed on the next wake,
  trimmed to maxHistoryChars.

Core fields:
- apiUrl (string, required): provider base URL, e.g. https://openrouter.ai/api/v1.
  A full .../chat/completions URL is accepted and normalized.
- model (string, required): provider model id, e.g. deepseek/deepseek-chat
- env.${OPENAI_COMPATIBLE_API_KEY_ENV} (secret, required for hosted providers): bearer key
  sent as "Authorization: Bearer <key>". Store it as a secret binding, never plain text.
- temperature (number, optional): sampling temperature; omitted means provider default
- maxTokens (number, optional): max output tokens per model response
- maxTurns (number, optional, default ${DEFAULT_OPENAI_COMPATIBLE_MAX_TURNS}): max model calls per heartbeat
- requestTimeoutSec (number, optional, default ${DEFAULT_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SEC}): per-request timeout
- maxHistoryChars (number, optional, default ${DEFAULT_OPENAI_COMPATIBLE_MAX_HISTORY_CHARS}): resumed history budget
- enableWorkspaceTools (boolean, optional, default false): expose run_shell/read_file/write_file
  in the workspace cwd on the Paperclip host. Runs model-chosen shell commands with the
  server user's permissions — enable only for trusted providers and workspaces.
- shellTimeoutSec (number, optional, default ${DEFAULT_OPENAI_COMPATIBLE_SHELL_TIMEOUT_SEC}): run_shell timeout
- cwd (string, optional): fallback workspace directory when the run has no workspace
- instructionsFilePath (string, optional): agent instructions prepended to the system prompt
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): first-run-only bootstrap prompt template
- extraHeaders (object, optional): additional HTTP headers for the provider (e.g. HTTP-Referer)

Notes:
- The provider never receives the Paperclip API key; Paperclip calls are executed by
  the adapter on the model's behalf.
- Token usage is reported from the provider's usage block; cost is not computed.
`;
