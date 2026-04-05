export const type = "kiro_local";
export const label = "Kiro CLI (local)";

export const models = [
  { id: "auto", label: "Auto — 1.00x credits" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6 — 2.20x credits" },
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6 — 1.30x credits" },
  { id: "claude-opus-4.5", label: "Claude Opus 4.5 — 2.20x credits" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5 — 1.30x credits" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4 — 1.30x credits" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5 — 0.40x credits" },
  { id: "deepseek-3.2", label: "DeepSeek V3.2 — 0.25x credits" },
  { id: "minimax-m2.5", label: "MiniMax M2.5 — 0.25x credits" },
  { id: "minimax-m2.1", label: "MiniMax M2.1 — 0.15x credits" },
  { id: "glm-5", label: "GLM-5 — 0.50x credits" },
  { id: "qwen3-coder-next", label: "Qwen3 Coder Next — 0.05x credits" },
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
- model (string, optional): Kiro model id (auto, claude-opus-4.6, claude-sonnet-4.6, claude-opus-4.5, claude-sonnet-4.5, claude-sonnet-4, claude-haiku-4.5, deepseek-3.2, minimax-m2.5, minimax-m2.1, glm-5, qwen3-coder-next)
- promptTemplate (string, optional): run prompt template
- trustAllTools (boolean, optional): pass --trust-all-tools to skip tool permission prompts (default: true)
- command (string, optional): defaults to "kiro-cli"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
