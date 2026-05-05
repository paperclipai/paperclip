import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "ollama_local";
export const label = "Ollama (local)";

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:14b";
export const DEFAULT_OLLAMA_MAX_ITERATIONS = 25;
export const DEFAULT_OLLAMA_TIMEOUT_SEC = 600;

/**
 * Static seed list. The real model catalog is discovered at runtime by calling
 * `/api/tags` on the configured Ollama host (see server/models.ts).
 */
export const models: Array<{ id: string; label: string }> = [
  { id: "qwen2.5-coder:14b", label: "qwen2.5-coder:14b (recommended)" },
  { id: "qwen2.5-coder:32b", label: "qwen2.5-coder:32b" },
  { id: "gpt-oss:20b", label: "gpt-oss:20b" },
  { id: "llama3.2:latest", label: "llama3.2:latest" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Small",
    description: "Use a smaller, faster Ollama model lane.",
    adapterConfig: {
      model: "qwen2.5-coder:7b",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to drive an Ollama-served model directly, without an external
  coding-agent CLI in between.
- You are running fully offline / air-gapped and Ollama is your inference backend.

Don't use when:
- You need session resume across heartbeats (use codex_local or opencode_local).
- You need remote execution over SSH.
- The model you want is reachable through a hosted provider — those are better
  served by claude_local / codex_local / gemini_local etc.

Core fields:
- model (string, required): an Ollama tag (e.g. \`qwen2.5-coder:14b\`).
- host (string, optional): Ollama server URL. Defaults to OLLAMA_HOST env or
  http://localhost:11434.
- cwd (string, optional): working directory for tool execution.
- instructionsFilePath (string, optional): markdown file prepended to the system
  prompt.
- promptTemplate (string, optional): user prompt template.
- maxIterations (number, optional, default 25): maximum tool-call rounds.
- env (object, optional): environment variables for run_bash tool calls.

Operational fields:
- timeoutSec (number, optional, default 600): wall-clock run timeout.
- graceSec (number, optional): SIGTERM grace period for in-flight bash tool calls.

Built-in tools:
- read_file, write_file, list_dir, run_bash.

Notes:
- This adapter implements its own agent loop in-process; there is no external
  binary to install beyond \`ollama\` itself.
- Pick a model that Ollama flags as supporting \`tools\` (\`ollama show <model>\`),
  otherwise tool calls will not be emitted by the model.
- v0.1 is experimental: no session resume, no remote execution, no skill bundle
  injection. See package CHANGELOG for the roadmap.
`;
