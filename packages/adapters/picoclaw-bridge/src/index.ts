export const type = "picoclaw_local";
export const label = "PicoClaw (local)";
export const agentConfigurationDoc = `# picoclaw_local

Adapter: picoclaw_local

Runs PicoClaw as a local agent process. Requires \`picoclaw\` to be installed
and accessible on PATH.

Each heartbeat run spawns an isolated child process with its own session so
runs never share context with each other.

Core fields:
- cwd (string, optional): working directory for the picoclaw process (default: $HOME)
- timeoutSec (number, optional): max runtime in seconds (default: 300)
`;

export { createServerAdapter } from "./server/index.js";
