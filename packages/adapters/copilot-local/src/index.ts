export const type = "copilot_local";
export const label = "GitHub Copilot CLI (local)";
export const DEFAULT_COPILOT_LOCAL_MODEL = "claude-sonnet-4.5";

export const models = [
  { id: DEFAULT_COPILOT_LOCAL_MODEL, label: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-4.1", label: "GPT-4.1" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- You want Paperclip to run GitHub Copilot CLI locally on the host machine
- You want resumable Copilot sessions across heartbeats with --resume
- You want Copilot to discover Paperclip skills from its own ~/.copilot/skills directory

Don't use when:
- GitHub Copilot CLI is not installed or not authenticated on the host
- You need a simple non-agent shell command without a coding assistant loop (use process)
- You need webhook-style remote invocation instead of a local CLI runtime (use http or openclaw_gateway)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Copilot CLI model id. Defaults to claude-sonnet-4.5.
- autopilot (boolean, optional): when true, passes --autopilot (default: true)
- experimental (boolean, optional): when true, passes --experimental
- enableReasoningSummaries (boolean, optional): when true, passes --enable-reasoning-summaries
- command (string, optional): defaults to "copilot"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use non-interactive prompt mode (-p) with JSON output (--output-format json).
- Paperclip always grants allow-all permissions for unattended runs and disables interactive ask_user prompts.
- Sessions resume with --resume when the stored session cwd matches the current cwd.
- Paperclip injects desired local skills into ~/.copilot/skills/ via symlinks so Copilot can discover $paperclip and related skills without writing into the target workspace.
- Copilot continues to respect repo-scoped AGENTS.md and other Copilot instruction files in the active workspace.
`;
