export const type = "copilot_local";
export const label = "GitHub Copilot CLI";
export const DEFAULT_COPILOT_LOCAL_MODEL = "claude-sonnet-4.6";

export const models = [
  { id: DEFAULT_COPILOT_LOCAL_MODEL, label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" }
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local (GitHub Copilot CLI)

Core fields:
- cwd (string, optional): absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): model id (default: claude-sonnet-4.6)
- effort (string, optional): reasoning effort level (low, medium, high, xhigh)
- command (string, optional): defaults to "copilot"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
