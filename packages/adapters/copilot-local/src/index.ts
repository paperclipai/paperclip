export const type = "copilot_local";
export const label = "GitHub Copilot CLI (local)";
export const DEFAULT_COPILOT_LOCAL_MODEL = "gpt-5";

const COPILOT_FALLBACK_MODEL_IDS = [
  "gpt-5",
  "gpt-5-mini",
  "claude-sonnet-4",
  "claude-opus-4.1",
  "gemini-2.5-pro",
];

export const models = COPILOT_FALLBACK_MODEL_IDS.map((id) => ({ id, label: id }));

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- You want Paperclip to run GitHub Copilot CLI locally as the agent runtime

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- GitHub Copilot CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Copilot model id
- command (string, optional): defaults to "copilot"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
