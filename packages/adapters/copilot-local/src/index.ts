export const type = "copilot_local";
export const label = "Copilot (local)";

export const models = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- The agent should use GitHub Copilot CLI as its runtime
- Copilot is available through GitHub subscription or GitHub Enterprise
- You want agents backed by multiple model providers via a single GitHub auth

Don't use when:
- You need direct control over Anthropic/OpenAI API keys (use claude_local or codex_local)
- Copilot CLI is not installed on the host
- You need provider-specific quota tracking (Copilot uses premium-request accounting)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- model (string, optional): model id passed via --model (e.g. claude-opus-4-6, gpt-5.2)
- effort (string, optional): reasoning effort passed via --effort (low|medium|high|xhigh)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt at runtime
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max autopilot continuation turns for one run
- command (string, optional): defaults to "copilot"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Copilot CLI reads AGENTS.md natively from the working directory for agent instructions.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
- Copilot CLI uses GitHub authentication. Ensure \`copilot login\` has been completed or GITHUB_TOKEN is available.
- Usage is tracked via premium requests rather than raw token counts.
`;
