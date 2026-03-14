export const type = "kiro_local";
export const label = "Kiro CLI (local)";

export const models = [
  { id: "auto", label: "Auto (recommended)" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4-0", label: "Claude Sonnet 4.0" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `# kiro_local agent configuration

Adapter: kiro_local

Use when:
- The agent needs to run Kiro CLI locally on the host machine
- You need session persistence across runs (Kiro supports --resume)
- The task requires Kiro-specific features (spec-driven development, MCP tools)
- You want access to Amazon/AWS-backed Claude models via Kiro's routing

Don't use when:
- Kiro CLI is not installed on the host (install via https://cli.kiro.dev/install)
- You need a simple one-shot script execution (use the "process" adapter instead)
- The agent doesn't need conversational context between runs

Core fields:
- cwd (string, optional): absolute working directory for the agent process
- model (string, optional): Kiro model id (auto, claude-opus-4-6, claude-sonnet-4-5, claude-sonnet-4-0, claude-haiku-4-5)
- promptTemplate (string, optional): run prompt template
- trustAllTools (boolean, optional): pass --trust-all-tools to skip tool permission prompts (default: true)
- command (string, optional): defaults to "kiro-cli"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
