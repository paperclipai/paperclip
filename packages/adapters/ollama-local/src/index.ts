export const type = "ollama_local";
export const label = "Ollama (local)";

export const DEFAULT_OLLAMA_LOCAL_MODEL = "llama3.2";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to run a locally installed Ollama model as the agent runtime
- You want full privacy: all inference happens on-device, no cloud API calls
- You want to use open-weight models (Llama, Mistral, Qwen, etc.) for agentic tasks

Don't use when:
- You need cloud-hosted model quality for complex coding tasks (use claude_local or opencode_local)
- Ollama is not installed on the machine (install from https://ollama.com)
- You need session resume across heartbeats (Ollama is stateless per-run)

Core fields:
- baseUrl (string, optional): Ollama server base URL (default: http://localhost:11434)
- model (string, optional): Ollama model name as returned by \`ollama list\` (default: llama3.2)
- cwd (string, optional): working directory for tool execution (default: process.cwd())
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): total run timeout in seconds (0 = no timeout)

Notes:
- Ollama must be running before starting an agent: \`ollama serve\`
- Pull a model before use: \`ollama pull llama3.2\`
- List installed models: \`ollama list\` or GET http://localhost:11434/api/tags
- The adapter uses Ollama's native /api/chat endpoint (streaming JSONL)
- Tool calls are executed locally in the configured cwd
- Available tools: read_file, write_file, run_bash, list_directory, paperclip_get_context
- Sessions are stateless: each Paperclip run starts a fresh conversation
- sessionId is set to \`ollama-<runId>\` for traceability
- Token usage is reported from Ollama's prompt_eval_count / eval_count fields
`;
