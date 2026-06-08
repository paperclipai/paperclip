import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "claude_local";
export const label = "Claude Code (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

export const models = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
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

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Remote SDK bridge fields:
- agentSdkServerUrl (string, optional): ws:// or wss:// Paperclip Claude SDK server endpoint. When set, Paperclip talks to the remote bridge over WebSocket instead of launching local \`claude\`
- agentSdkServerBearerToken (string, optional): bearer token sent as \`Authorization\` during the remote bridge WebSocket handshake
- agentSdkServerHeaders (object, optional): extra WebSocket handshake headers for remote bridge auth

Notes:
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
- Remote bridge mode is a Paperclip protocol for self-hosted Claude infrastructure, not an official Anthropic Claude Code remote-control API.
- The remote bridge is expected to run Claude locally on its own host and stream stdout/stderr back to Paperclip.
- In remote bridge mode, Paperclip forwards the contents of \`instructionsFilePath\` over the bridge. The remote host does not need that Paperclip-local path to exist.
- In remote bridge mode, \`paperclipWorkspace.cwd\` is treated as a Paperclip-side workspace hint only. The remote Claude process uses \`adapterConfig.cwd\` if you set one; otherwise it stays in the bridge host's own local working directory.
- The standalone bridge server lives in this repo as \`@paperclipai/claude-sdk-server\`. The remote host does not need the rest of Paperclip's runtime packages just to run the bridge; it only needs this package plus the local \`claude\` CLI.
- In a repo checkout, you can start it with \`node packages/claude-sdk-server/dist/cli.js --listen ws://127.0.0.1:4400\` after \`pnpm --filter @paperclipai/claude-sdk-server build\`.
- If you want to ship the remote bridge as an archive instead of a repo checkout, run \`pnpm --filter @paperclipai/claude-sdk-server bundle\` and deploy the generated tarball from \`packages/claude-sdk-server/bundle/\`.
- For the safest setup, run the bridge on loopback on the remote host and SSH-forward that port back to the Paperclip host. If you expose it directly, prefer \`wss://\` and set \`agentSdkServerBearerToken\` when the bridge requires bearer auth.
- Current limitation: the standalone bridge currently uses a slimmer Claude execution path than the full in-process \`claude_local\` adapter and does not materialize Paperclip-managed Claude skill/runtime assets on the remote host.
`;
