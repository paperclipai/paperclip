export const type = "ollama_local";
export const label = "Ollama (local)";
export const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.3-ollama";
export const DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = true;

export const models = [
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: DEFAULT_CODEX_LOCAL_MODEL, label: DEFAULT_CODEX_LOCAL_MODEL },
  { id: "gpt-5.3-ollama-spark", label: "gpt-5.3-codex-spark" },
  { id: "gpt-5", label: "gpt-5" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "gpt-5-mini", label: "gpt-5-mini" },
  { id: "gpt-5-nano", label: "gpt-5-nano" },
  { id: "o3-mini", label: "o3-mini" },
  { id: "ollama-mini-latest", label: "Ollama Mini" },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to stdin prompt at runtime
- model (string, optional): Ollama model id
- modelReasoningEffort (string, optional): reasoning effort override (minimal|low|medium|high) passed via -c model_reasoning_effort=...
- promptTemplate (string, optional): run prompt template
- search (boolean, optional): run ollama with --search
- dangerouslyBypassApprovalsAndSandbox (boolean, optional): run with bypass flag
- command (string, optional): defaults to "ollama"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Prompts are piped via stdin (Ollama receives "-" prompt argument).
- Paperclip auto-injects local skills into Ollama personal skills dir ("$CODEX_HOME/skills" or "~/.ollama/skills") when missing, so Codex can discover "$paperclip" and related skills.
- Some model/tool combinations reject certain effort levels (for example minimal with web search enabled).
Agentic Proactive Prompting:
- If \`proactivePrompting\` is true in the runtime config, the agent will be instructed to automatically ask the user or orchestrator for the next task when it finishes the current one, keeping the process moving without manual intervention.

`;
