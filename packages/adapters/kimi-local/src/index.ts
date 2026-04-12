export const type = "kimi_local";
export const label = "Kimi (local)";

export const models = [
  { id: "kimi-for-coding", label: "Kimi for Coding" },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want Paperclip to run Kimi CLI (the AI coding agent by Moonshot AI) locally as the agent runtime
- You want to leverage Kimi's code understanding and generation capabilities
- You want session resume across heartbeats via --session
- You need Kimi's tool set (read, bash, edit, write, grep, find, ls)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Kimi CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Kimi model id (defaults to "kimi-for-coding")
- thinking (boolean, optional): enable thinking mode (defaults to true)
- command (string, optional): defaults to "kimi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- maxStepsPerTurn (number, optional): max steps per turn (default: from config)
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
- Kimi CLI uses OAuth for authentication. Run \`kimi login\` to authenticate.
`;
