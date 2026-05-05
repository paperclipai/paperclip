# @paperclipai/adapter-ollama-local

## 0.1.0

- Initial release. First-class Ollama adapter (`ollama_local`).
- Implements an in-process agent loop on top of Ollama's `/api/chat` tool-calling API.
- Built-in tools: `read_file`, `write_file`, `list_dir`, `run_bash`.
- `listModels` queries `/api/tags` on the configured Ollama host.
- `testEnvironment` checks Ollama reachability and lists installed models.
- Marked **experimental**: no session resume, no remote execution target, no Paperclip skill bundle injection yet.
