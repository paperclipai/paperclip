export const type = "kilocode_local";
export const label = "Kilocode CLI (local)";
export const DEFAULT_KILOCODE_LOCAL_MODEL = "auto";

export const models = [
  { id: DEFAULT_KILOCODE_LOCAL_MODEL, label: "Auto" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini" },
  { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
  { id: "claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
  { id: "claude-3.5-haiku", label: "Claude 3.5 Haiku" },
  { id: "claude-3-opus", label: "Claude 3 Opus" },
];

export const agentConfigurationDoc = `# kilocode_local agent configuration

Adapter: kilocode_local

Use when:
- You want Paperclip to run the Kilocode CLI locally on the host machine
- You want Kilocode sessions resumed across heartbeats
- You want Paperclip skills injected locally without polluting the global environment
- You prefer a terminal-based AI coding assistant with file awareness

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Kilocode CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Kilocode model id. Defaults to auto.
- command (string, optional): defaults to "kilocode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use positional prompt arguments for non-interactive execution.
- Sessions resume with session tracking when stored session cwd matches the current cwd.
- Paperclip auto-injects local skills into \`~/.kilocode/skills/\` via symlinks, so the CLI can discover both credentials and skills in their natural location.
- Authentication uses KILOCODE_API_KEY environment variable or local Kilocode CLI login.
- Kilocode provides file-aware operations, multi-language support, and local model execution options.
`;
