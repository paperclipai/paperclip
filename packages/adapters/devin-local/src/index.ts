export const type = "devin_local";
export const label = "Devin (local)";

export const models: { id: string; label: string }[] = [
  { id: "claude-opus-4.6", label: "Claude Opus 4.6 — default, most capable" },
  { id: "claude-opus-4.5", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5 — fast & capable" },
  { id: "claude-sonnet-4.5-thinking", label: "Claude Sonnet 4.5 Thinking" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5 — fastest Claude" },
  { id: "swe-1.6", label: "SWE 1.6 — fastest" },
  { id: "swe-1.5", label: "SWE 1.5" },
  { id: "swe-1.5-fast", label: "SWE 1.5 Fast" },
  { id: "gpt-5.4", label: "GPT 5.4" },
  { id: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
  { id: "gpt-5.3-codex", label: "GPT 5.3 Codex — OpenAI, optimised for code" },
  { id: "gpt-5.2", label: "GPT 5.2" },
];

export const agentConfigurationDoc = `# devin_local agent configuration

Adapter: devin_local

Use when:
- You want Paperclip to invoke Devin CLI locally as the agent runtime.
- Devin is installed on the machine running the Paperclip server.
- You want session-based continuity across heartbeats via Devin's built-in session management.

Don't use when:
- Devin CLI is not installed on the Paperclip server host.
- You need the Devin cloud API instead of the local CLI (use http adapter for that).

Core fields:
- cwd (string, optional): default absolute working directory for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Devin model id. Available models:
  claude-opus-4.6 (alias: opus) — default, most capable
  claude-opus-4.5
  claude-sonnet-4.6
  claude-sonnet-4.5 (alias: sonnet)
  claude-sonnet-4.5-thinking
  claude-sonnet-4
  claude-haiku-4.5
  swe-1.6 — fastest
  swe-1.5 (alias: swe)
  swe-1.5-fast
  gpt-5.4
  gpt-5.4-mini
  gpt-5.3-codex (alias: codex) — OpenAI, optimised for code
  gpt-5.2
- permissionMode (string, optional): permission mode passed via --permission-mode (auto|dangerous, default dangerous)
- command (string, optional): defaults to "devin"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Devin sessions are identified by UUID and scoped to a working directory.
- On first run Paperclip discovers the session ID via \`devin list --format json\` and stores it for subsequent runs.
- On subsequent heartbeats Paperclip resumes the session via \`devin -r <session_id>\`.
- Permission mode defaults to "dangerous" for headless operation; set to "auto" for read-only auto-approval only.
`;
