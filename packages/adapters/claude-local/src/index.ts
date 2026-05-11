import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "claude_local";
export const label = "Claude Code (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

export const models = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Claude Sonnet as the lower-cost Claude Code lane while preserving the agent's primary model.",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      effort: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# claude_local agent configuration

Adapter: claude_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort passed via --effort (low|medium|high)
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional, default true): pass --dangerously-skip-permissions to claude; defaults to true because Paperclip runs Claude in headless --print mode where interactive permission prompts cannot be answered
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- leakCheck (object, optional): controls the adapter-level leak-check shim that intercepts \`gh\` and \`git\` write commands to refuse customer-facing publishes containing Paperclip-internal references. Defaults to enabled for local execution when a company-scoped policy script is found at \`<instanceRoot>/companies/<companyId>/policies/leak-check.sh\`.
  - leakCheck.disabled (boolean, optional, default false): when true, skip shim setup entirely for this agent
  - leakCheck.scriptPath (string, optional): absolute path to the leak-check script; overrides the per-company default location
  - Env contract at the spawn boundary (set by the harness, not the agent):
    - PAPERCLIP_LEAK_CHECK_SCRIPT: resolved abs path to leak-check.sh
    - PAPERCLIP_LEAK_CHECK_SHIM_DIR: shim dir prepended to PATH
    - PAPERCLIP_LEAK_OVERRIDE=1: required (alongside the \`--allow-leak-OK\` flag on the agent's gh/git invocation) to bypass a blocked publish; the harness only sets this when an accepted board-approved override is linked to the current issue

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
- The leak-check shim runs only for local execution in v1. Remote/sandbox execution targets bypass the shim until the runtime-asset sync path is extended.
`;
