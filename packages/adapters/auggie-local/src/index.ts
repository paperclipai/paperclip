export const type = "auggie_local";
export const label = "Auggie CLI (local)";
export const DEFAULT_AUGGIE_LOCAL_MODEL = "auto";

// Model short names come from `auggie models list --json`. Selecting "auto"
// skips passing `--model` so Auggie chooses its account default.
export const models = [
  { id: DEFAULT_AUGGIE_LOCAL_MODEL, label: "Auto (account default)" },
  { id: "opus4.7", label: "Opus 4.7" },
  { id: "opus4.6", label: "Opus 4.6" },
  { id: "opus4.6-500k", label: "Opus 4.6 (500K)" },
  { id: "sonnet4.6", label: "Sonnet 4.6" },
  { id: "sonnet4.6-500k", label: "Sonnet 4.6 (500K)" },
  { id: "haiku4.5", label: "Haiku 4.5" },
  { id: "gpt5.4", label: "GPT-5.4" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
  { id: "sonnet4.5", label: "Sonnet 4.5 (legacy)" },
  { id: "opus4.5", label: "Opus 4.5 (legacy)" },
  { id: "sonnet4", label: "Sonnet 4 (legacy)" },
  { id: "gpt5.2", label: "GPT-5.2 (legacy)" },
  { id: "gpt5.1", label: "GPT-5.1 (legacy)" },
  { id: "gpt5", label: "GPT-5 (legacy)" },
];

export const agentConfigurationDoc = `# auggie_local agent configuration

Adapter: auggie_local

Use when:
- You want Paperclip to run the Auggie CLI (Augment Code) locally on the host machine
- You want Auggie sessions resumed across heartbeats with --resume
- You want Paperclip skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Auggie CLI is not installed on the machine that runs Paperclip (requires Node 22+)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Auggie model short name (passed via --model, e.g. "opus4.7", "sonnet4.6", "haiku4.5", "gpt5.4", "gemini-3.1-pro-preview"). Defaults to "auto" which omits --model so Auggie uses its account default. Run \`auggie models list\` to see the authoritative list for your account.
- command (string, optional): defaults to "auggie"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- maxTurns (number, optional): limit the number of agentic turns via --max-turns

Notes:
- Runs pass the prompt via -i <text> in --print --output-format json mode.
- Auggie's JSON print mode emits a single final object { type: "result", result, is_error, session_id, ... }; intermediate tool_call and thinking events are not currently available in this mode.
- Sessions resume with --resume <sessionId> when stored session cwd matches the current cwd.
- Paperclip auto-injects local skills into \`~/.augment/skills/\` via symlinks so Auggie discovers both credentials and skills in their natural home.
- Authentication uses \`auggie login\` (OAuth) by default; alternatively set AUGMENT_SESSION_AUTH (session JSON) or --augment-session-json.
`;
