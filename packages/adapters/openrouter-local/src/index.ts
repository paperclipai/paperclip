// Shared metadata for the openrouter_local adapter.
//
// This module is imported by both the server runtime and the UI plugin
// loader; it must remain free of Node-only imports.

import type { AdapterModel, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "openrouter_local";
export const label = "OpenRouter (local)";

export const DEFAULT_OPENROUTER_LOCAL_MODEL = "anthropic/claude-sonnet-4";
export const DEFAULT_OPENROUTER_LOCAL_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_LOCAL_MAX_ITERATIONS = 25;
export const DEFAULT_OPENROUTER_LOCAL_RUN_COMMAND_TIMEOUT_SEC = 120;

export const supportsInstructionsBundle = true;
export const instructionsPathKey = "instructionsFilePath";
export const requiresMaterializedRuntimeSkills = false;
export const supportsLocalAgentJwt = true;

export const models: AdapterModel[] = [
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (via OpenRouter)" },
  { id: "anthropic/claude-haiku-4", label: "Claude Haiku 4 (via OpenRouter)" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini (via OpenRouter)" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini (via OpenRouter)" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat (via OpenRouter)" },
  { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (via OpenRouter)" },
  { id: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B (via OpenRouter)" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use a low-cost OpenRouter model for non-critical lanes.",
    adapterConfig: {
      model: "openai/gpt-4o-mini",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# openrouter_local agent configuration

Adapter: openrouter_local

Routes Paperclip agent runs to any OpenAI Chat Completions-compatible
endpoint and runs the tool-calling loop locally on the Paperclip host.
Default baseUrl is OpenRouter; works equally well with api.openai.com or
any other OpenAI-compatible gateway.

Required config:
- baseUrl (string): e.g. https://openrouter.ai/api/v1
- model (string): provider/model slug (e.g. anthropic/claude-sonnet-4)

Required env input:
- OPENROUTER_API_KEY (or OPENAI_API_KEY for whichever endpoint you point at)

Optional env input:
- OPENROUTER_MODEL (string): model slug to use when config.model is not set
  (e.g. deepseek/deepseek-r1). Takes precedence over the built-in default.

Optional config:
- cwd (string): absolute working directory for built-in tools (defaults to
  PAPERCLIP_WORKSPACE_PATH or process.cwd())
- instructionsFilePath (string): markdown instructions prepended to the system prompt
- promptTemplate (string): user prompt template, rendered with
  { agentId, agentName, companyId, runId, taskId, taskTitle }
- maxIterations (number): cap on tool-call rounds per run (default 25)
- maxRunCommandTimeoutSec (number): per-call timeout for run_command (default 120)
- timeoutSec (number): wall-clock timeout for the entire run; execute() returns
  timedOut: true after this many seconds. Aborts in-flight OpenAI requests and
  SIGTERMs any running run_command subprocess. Absent or 0 means no limit.
- extraHeaders (object): additional HTTP headers to send with each request
- disabledTools (string[]): tool names to omit from the request

Built-in tools exposed to the model:
- read_file({ path }) -> file contents
- write_file({ path, content }) -> bytes written
- list_directory({ path }) -> directory entries
- run_command({ command, timeoutSec? }) -> { exitCode, stdout, stderr }
- apply_patch({ patch }) -> applies a unified diff via 'git apply'

Notes:
- The adapter automatically loads AGENTS.md and HEARTBEAT.md from cwd when present.
- The OPENROUTER_API_KEY env var is preferred; OPENAI_API_KEY is a fallback.
- When OpenRouter is the upstream, the adapter sets HTTP-Referer and
  X-Title headers so requests show up correctly on the OpenRouter dashboard.
`;
