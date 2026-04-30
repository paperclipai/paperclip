export const type = "aider_local";
export const label = "Aider (local)";

export const DEFAULT_AIDER_LOCAL_MODEL = "ollama/llama3.1:8b";
export const DEFAULT_AIDER_LOCAL_OLLAMA_BASE_URL = "http://localhost:11434";

// A small curated default list. Real selection comes from whatever the user
// has pulled locally — see `listAiderModels` for dynamic discovery against the
// configured Ollama base URL.
export const models = [
  { id: "ollama/llama3.1:8b", label: "Ollama · llama3.1:8b" },
  { id: "ollama/llama3.1:70b", label: "Ollama · llama3.1:70b" },
  { id: "ollama/qwen2.5-coder:7b", label: "Ollama · qwen2.5-coder:7b" },
  { id: "ollama/qwen2.5-coder:14b", label: "Ollama · qwen2.5-coder:14b" },
  { id: "ollama/qwen2.5-coder:32b", label: "Ollama · qwen2.5-coder:32b" },
  { id: "ollama/deepseek-coder-v2:16b", label: "Ollama · deepseek-coder-v2:16b" },
];

export const agentConfigurationDoc = `# aider_local agent configuration

Adapter: aider_local

Wraps the [Aider](https://aider.chat) CLI (\`aider-chat\` on PyPI) so any local
model exposed via Ollama can drive a Paperclip agent. Aider provides the agent
loop (prompt construction, file editing, tool use, git integration); Paperclip
treats it as a subprocess like \`claude_local\` does for Claude Code.

Core fields:
- model (string, optional): Aider model id, e.g. \`ollama/llama3.1:8b\` or any
  other Aider-compatible provider/model. Defaults to ${DEFAULT_AIDER_LOCAL_MODEL}.
- ollamaBaseUrl (string, optional): exported as \`OLLAMA_API_BASE\` so Aider can
  reach the local Ollama server. Defaults to ${DEFAULT_AIDER_LOCAL_OLLAMA_BASE_URL}.
- editFormat (string, optional): one of \`whole\`, \`diff\`, \`udiff\`, \`architect\`.
  Aider picks a sensible default per model when omitted.
- promptTemplate (string, optional): overrides the default Paperclip wake prompt template.
- maxChatHistoryTokens (number, optional): forwarded as \`--max-chat-history-tokens\`.
- autoCommits (boolean, optional, default false): when false, Paperclip controls
  git; when true, Aider runs its own auto-commit loop.
- yesAlways (boolean, optional, default true): pass \`--yes-always\` so Aider does
  not prompt interactively (Paperclip runs Aider headless).
- restoreChatHistory (boolean, optional, default true): pass
  \`--restore-chat-history\` so multi-turn agents continue from \`.aider.chat.history.md\`.
- cwd (string, optional): default working directory for the agent process.
- command (string, optional): defaults to \`aider\`.
- extraArgs (string[], optional): additional CLI args appended after Paperclip's flags.
- env (object, optional): KEY=VALUE environment variables.
- timeoutSec (number, optional): run timeout in seconds.
- graceSec (number, optional): SIGTERM grace period in seconds.

Notes:
- Aider must be installed and on PATH (\`pip install aider-chat\`).
- Ollama must be running locally (\`ollama serve\`) and the requested model must
  be pulled (\`ollama pull llama3.1:8b\`).
- This adapter is unauthenticated — there is no \`<cli> login\` flow for Ollama.
  The Adapters page surfaces a "Local Ollama (reachable)" / "Ollama unreachable"
  badge instead of a Sign-in button.
`;
