export const type = "ollama_local";
export const label = "Ollama (local)";

export const DEFAULT_OLLAMA_LOCAL_MODEL = "qwen3:32b";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to run a locally installed Ollama model as the agent runtime
- You want full privacy: all inference happens on-device, no cloud API calls
- You want to use open-weight models for high-volume, lower-stakes tasks (telemetry triage,
  failure classification, policy checking, codebase Q&A) to eliminate API cost
- You want to run the meta-agent Analysis Agent on local hardware

Recommended models (48 GB Mac, one model at a time):
- qwen3:32b        — primary model: strong coding + agent capabilities, fits at Q4 (default)
- gemma4:31b       — multimodal tasks requiring screenshot/UI classification
- Pull with: \`ollama pull qwen3:32b\`

Don't use when:
- You need frontier-model quality for complex coding tasks (use claude_local or opencode_local)
- Ollama is not installed on the machine (install from https://ollama.com)
- You need session resume across heartbeats (Ollama is stateless per-run)
- The task requires > 70B capability (70B models are out of scope on 48 GB)

Core fields:
- baseUrl (string, optional): Ollama server base URL (default: http://localhost:11434)
- model (string, optional): Ollama model name as returned by \`ollama list\` (default: qwen3:32b)
- cwd (string, optional): working directory for tool execution (default: process.cwd())
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): total run timeout in seconds (0 = no timeout)

Notes:
- Ollama must be running before starting an agent: \`ollama serve\`
- Pull a model before use: \`ollama pull qwen3:32b\`
- List installed models: \`ollama list\` or GET http://localhost:11434/api/tags
- The adapter uses Ollama's native /api/chat endpoint (streaming JSONL)
- Tool calls are executed locally in the configured cwd
- Available tools: read_file, write_file, run_bash, list_directory, paperclip_get_context
- Sessions are stateless: each Paperclip run starts a fresh conversation
- sessionId is set to \`ollama-<runId>\` for traceability
- Token usage is reported from Ollama's prompt_eval_count / eval_count fields
- Context windows: cap at 8192 tokens for tasks; do not use advertised max to preserve headroom
`;
