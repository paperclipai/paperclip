export const type = "ollama_local";
export const label = "Ollama (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want a free, local-model-powered agent running on Ollama
- You want to handle heartbeats with a local model (gemma4, llama3.1, qwen2.5-coder, etc.)
- You want a cost-free triage or worker agent that escalates to paid models when needed
- Ollama is running locally or on the network
- You need coding/file-system tools for a local model (set codingMode: true)

Don't use when:
- Ollama is not available on the network
- You need a full IDE integration (use claude_local, codex_local, etc.)

Core fields:
- baseUrl (string, required): Ollama server URL, e.g. http://192.168.1.21:11434
- model (string, required): Ollama model name, e.g. gemma4:latest, llama3.1:8b, qwen2.5-coder:7b
- maxTurns (number, optional): maximum tool-call rounds per heartbeat, default 20
- timeoutSec (number, optional): per-Ollama-call timeout in seconds, default 60
- systemPromptExtra (string, optional): additional instructions appended to the system prompt

Coding mode fields (set codingMode: true to enable):
- codingMode (boolean, optional): when true, exposes bash_exec, file_read, file_write, and file_list tools in addition to the standard Paperclip tools. Default: false.
- cwd (string, optional): default working directory for bash_exec and relative file paths. Defaults to the process working directory.

Coding tools (only available when codingMode: true):
- bash_exec(command, cwd?, timeout_sec?): run a shell command, returns stdout/stderr/exitCode
- file_read(path): read a file, returns content (truncated at 50000 chars for large files)
- file_write(path, content): write/create a file, auto-creates parent directories
- file_list(path): list directory contents with file/dir type and size

Operational fields:
- No subprocess is spawned — the adapter communicates directly with Ollama's HTTP API.
- In standard mode the agent has two tools: call_paperclip_api and finish.
- In codingMode the agent additionally has: bash_exec, file_read, file_write, file_list.
- Tool calling requires a model that supports it (gemma4, llama3.1, mistral-nemo, qwen2.5-coder, etc.).
- If Ollama is unreachable, the heartbeat fails with an error (no silent fallback).

Notes:
- gemma4:latest is Google's Gemma 4 model and supports function calling well.
- Use \`ollama list\` on the Ollama host to see available models.
- Keep maxTurns low (5-10) for simple triage agents; set higher (30-50) for coding agents.
- For benchmark/coding agents, set codingMode: true and point cwd at the git worktree.
`;
