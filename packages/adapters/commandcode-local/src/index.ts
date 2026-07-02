import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "commandcode_local";
export const label = "CommandCode (local)";

export const SANDBOX_INSTALL_COMMAND = "npm i -g command-code@latest";

export const DEFAULT_COMMANDCODE_LOCAL_MODEL = "deepseek/deepseek-v4-flash";

export const models = [
  { id: DEFAULT_COMMANDCODE_LOCAL_MODEL, label: DEFAULT_COMMANDCODE_LOCAL_MODEL },
  { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" },
  { id: "claude-sonnet-5", label: "claude-sonnet-5" },
  { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { id: "gpt-5.5", label: "gpt-5.5" },
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { id: "google/gemini-3.5-flash", label: "google/gemini-3.5-flash" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use CommandCode's default fast open-source coding model as the budget lane.",
    adapterConfig: {
      model: DEFAULT_COMMANDCODE_LOCAL_MODEL,
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# commandcode_local agent configuration

Adapter: commandcode_local

Use when:
- You want Paperclip to run CommandCode locally on the host machine
- You want resumable CommandCode sessions across heartbeats via \`--resume\`
- You want CommandCode's model routing and taste-learning behavior

Don't use when:
- You need structured JSON tool-call transcript events; CommandCode print mode currently returns plain text
- You need a webhook-style external invocation (use http or a gateway adapter)
- You only need a one-shot shell command without an AI coding agent loop (use process)
- CommandCode CLI is not installed or authenticated on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, optional): CommandCode model id. Defaults to CommandCode's configured/default model when omitted.
- promptTemplate (string, optional): run prompt template
- maxTurns (number, optional): passed as \`--max-turns\` in print mode
- dangerouslySkipPermissions (boolean, optional, default true): pass \`--yolo\` for unattended execution
- command (string, optional): defaults to "commandcode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use CommandCode print mode: \`commandcode -p\`.
- Paperclip sends the prompt through stdin so long prompts do not hit command-line length limits.
- Sessions resume with \`--resume <sessionId>\` when the saved session cwd matches the current cwd.
- The adapter passes \`--verbose\` and extracts a session id from stderr when CommandCode prints one.
- Environment checks use \`commandcode status --json\`, \`commandcode --list-models\`, and a live \`hello\` probe.
`;
