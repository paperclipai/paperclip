export const type = "opencode_local";
export const label = "OpenCode (local)";
export const DEFAULT_OPENCODE_LOCAL_MODEL = "openai/gpt-5.2-codex";

export const models = [
  { id: DEFAULT_OPENCODE_LOCAL_MODEL, label: DEFAULT_OPENCODE_LOCAL_MODEL },
  { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
  { id: "openai/gpt-5.1-codex-max", label: "openai/gpt-5.1-codex-max" },
  { id: "openai/gpt-5.1-codex-mini", label: "openai/gpt-5.1-codex-mini" },
];

export const agentConfigurationDoc = `# opencode_local agent configuration

Adapter: opencode_local

Use when:
- You want Paperclip to run OpenCode locally as the agent runtime
- You want provider/model routing in OpenCode format (provider/model)
- You want OpenCode session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw or http)
- You only need one-shot shell commands (use process)
- OpenCode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, optional): OpenCode model id in provider/model format (for example openai/gpt-5.2-codex)
- variant (string, optional): provider-specific reasoning/profile variant passed as --variant
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "opencode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs are executed with: opencode run --format json ...
- Prompts are passed as the final positional message argument.
- Sessions are resumed with --session when stored session cwd matches current cwd.
`;
