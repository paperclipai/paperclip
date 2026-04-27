export const type = "openhands_local";
export const label = "OpenHands (local)";

export const DEFAULT_OPENHANDS_LOCAL_MODEL = "openai/mountainlabs-main";

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_OPENHANDS_LOCAL_MODEL, label: DEFAULT_OPENHANDS_LOCAL_MODEL },
  { id: "openai/gpt-4o", label: "openai/gpt-4o" },
  { id: "openai/gpt-4o-mini", label: "openai/gpt-4o-mini" },
  { id: "openai/gpt-4-turbo", label: "openai/gpt-4-turbo" },
  { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
  { id: "anthropic/claude-3.5-sonnet", label: "anthropic/claude-3.5-sonnet" },
  { id: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
];

export const agentConfigurationDoc = `# openhands_local agent configuration

Adapter: openhands_local

Use when:
- You want Paperclip to run OpenHands locally as the agent runtime
- You want provider/model routing in OpenHands format (provider/model)
- You want OpenHands session resume across heartbeats via --resume

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OpenHands CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OpenHands model id in provider/model format (for example anthropic/claude-sonnet-4-5)
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "openhands"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenHands supports multiple providers and models. Use \`openhands models\` to list available options in provider/model format.
- Paperclip requires an explicit \`model\` value for \`openhands_local\` agents.
- Runs are executed with: openhands --headless --override-with-envs -t "<task>"
- Sessions are resumed with --resume when stored session cwd matches current cwd.
- The adapter uses --override-with-envs to prevent OpenHands from writing settings files.
- Model selection and API configuration are passed via environment variables (LLM_MODEL, LLM_API_KEY, LLM_BASE_URL).
- OpenHands requires both OPENAI_API_KEY and OPENAI_API_BASE environment variables for compatibility.
`;
