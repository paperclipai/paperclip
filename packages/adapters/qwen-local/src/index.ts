export const type = "qwen_local";
export const label = "Qwen Code CLI (local)";
export const DEFAULT_QWEN_LOCAL_MODEL = "auto";

export const models = [
  { id: DEFAULT_QWEN_LOCAL_MODEL, label: "Auto" },
  { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus" },
  { id: "qwen3-coder-next", label: "Qwen3 Coder Next" },
];

export const agentConfigurationDoc = `# qwen_local agent configuration

Adapter: qwen_local

Use when:
- You want Paperclip to run the Qwen Code CLI locally on the host machine
- You want Qwen chat sessions resumed across heartbeats with --resume
- You want Paperclip skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Qwen Code CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Qwen model id. Defaults to auto.
- sandbox (boolean, optional): run in sandbox mode (default: false)
- command (string, optional): defaults to "qwen"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use positional prompt arguments, not stdin.
- Sessions resume with --resume when stored session cwd matches the current cwd.
- Paperclip auto-injects local skills into \`~/.qwen/skills/\` via symlinks, so the CLI can discover both credentials and skills in their natural location.
- Authentication can use DASHSCOPE_API_KEY or Qwen CLI OAuth (\`qwen auth login\`).
`;
