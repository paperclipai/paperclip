export const type = "kimi_local";
export const label = "Kimi Code (local)";

export const DEFAULT_KIMI_LOCAL_MODEL = "kimi-k2.6";

export const models = [
  { id: DEFAULT_KIMI_LOCAL_MODEL, label: DEFAULT_KIMI_LOCAL_MODEL },
  { id: "kimi-k2.5", label: "kimi-k2.5" },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want Paperclip to run Kimi Code CLI locally on the host machine
- You want resumable Kimi sessions across heartbeats via \`-r\` / \`--resume\`
- You want Paperclip-managed instructions staged into the execution workspace

Don't use when:
- You need a webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Kimi Code CLI is not installed or authenticated on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file. Paperclip stages it into the execution workspace as \`Agents.md\` when safe
- promptTemplate (string, optional): run prompt template
- model (string, optional): Kimi model id. Defaults to kimi-k2.6.
- command (string, optional): defaults to "kimi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`kimi --print -p <prompt> --output-format=stream-json\`.
- Sessions resume with \`-r <sessionId>\` when the saved session cwd matches the current cwd.
- Use \`kimi login\` on the host to authenticate before running agents.
`;
