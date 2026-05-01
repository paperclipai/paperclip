import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "copilot_local";
export const label = "GitHub Copilot CLI";
export const DEFAULT_COPILOT_LOCAL_MODEL = "claude-sonnet-4.6";

export const models: AdapterModel[] = [
  { id: DEFAULT_COPILOT_LOCAL_MODEL, label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4.7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "claude-opus-4.6-fast", label: "Claude Opus 4.6 Fast" },
  { id: "claude-opus-4.6-1m", label: "Claude Opus 4.6 1M" },
  { id: "claude-opus-4.5", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-5.1", label: "GPT-5.1" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5-mini", label: "GPT-5 Mini" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "auto", label: "Auto (default)" },
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
