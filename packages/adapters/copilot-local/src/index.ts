export const type = "copilot_local";
export const label = "GitHub Copilot CLI (local)";

export const models = [
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "gpt-5.4", label: "GPT 5.4" },
  { id: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
  { id: "gpt-5.2", label: "GPT 5.2" },
  { id: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Core fields:
- cwd (string, optional): default absolute working directory for the agent process
- model (string, optional): model id (e.g. claude-sonnet-4.6, gpt-5.4)
- effort (string, optional): reasoning effort (low|medium|high|xhigh)
- promptTemplate (string, optional): run prompt template
- dangerouslySkipPermissions (boolean, optional): pass --allow-all / --yolo
- command (string, optional): defaults to "copilot"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Copilot CLI must be installed and authenticated via GitHub.
- Uses --output-format json for structured JSONL output.
- Session resume is supported via --resume=<sessionId>.
`;
