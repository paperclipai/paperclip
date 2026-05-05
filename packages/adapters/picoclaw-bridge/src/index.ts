export const type = "picoclaw_local";
export const label = "PicoClaw (local)";
export const agentConfigurationDoc = `# picoclaw_local

Adapter: picoclaw_local

Runs PicoClaw as a local agent process. Requires \`picoclaw\` to be installed
and accessible on PATH.

Each heartbeat run spawns an isolated child process with its own session so
runs never share context with each other. The picoclaw agent uses a dedicated
per-agent workspace at ~/.paperclip/instances/default/workspaces/<agent-id>/.

Core fields:
- command (string, optional): picoclaw binary to invoke (default: "picoclaw")
- cwd (string, optional): working directory for the picoclaw process (default: $HOME)
- timeoutSec (number, optional): max runtime in seconds (default: 300)
- graceSec (number, optional): grace period after timeout before SIGKILL (default: 10)
- model (string, optional): model name to pass via --model (uses picoclaw default if unset)
- extraArgs (string[], optional): additional args appended to the picoclaw command
- env (object, optional): extra environment variables injected into the process

Skill sync:
- Skills are managed in the per-agent workspace under skills/.
- The paperclip heartbeat skill is always available and linked on sync.
- Use the Skills tab to add or remove company skills for this agent.
`;

export { createServerAdapter } from "./server/index.js";
