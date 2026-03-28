export const type = "opencode_remote";
export const label = "OpenCode (remote)";

export const models: Array<{ id: string; label: string }> = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `# opencode_remote agent configuration

Adapter: opencode_remote

Use when:
- OpenCode is running as a persistent HTTP server (not a local CLI process)
- You want Paperclip to create sessions and send messages via OpenCode's REST API
- The OpenCode server is reachable over the network (e.g. intra-cluster DNS)
- You want session persistence across heartbeats via OpenCode's session model

Don't use when:
- OpenCode is installed locally and should be spawned per-run (use opencode_local)
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)

Core fields:
- url (string, required): base URL of the OpenCode server (e.g. http://codev:5400)
- directory (string, required): project directory on the OpenCode server filesystem (e.g. /home/coder/src). All API calls are scoped to this project.
- providerID (string, optional): AI provider ID for message requests (e.g. "anthropic"). Default: "anthropic"
- model (string, optional): model ID for message requests (e.g. "claude-sonnet-4-6"). Default: "claude-sonnet-4-6"
- promptTemplate (string, optional): run prompt template with Paperclip variable substitution
- instructionsFilePath (string, optional): path to a markdown instructions file prepended to the run prompt. Resolved relative to the Paperclip agent's cwd (not the OpenCode directory).

Operational fields:
- timeoutSec (number, optional): message request timeout in seconds. 0 = no timeout.
- graceSec (number, optional): not applicable for HTTP adapter, included for consistency.

Notes:
- Sessions are created per-task and persisted via sessionParams for cross-heartbeat resume.
- The adapter sends the full prompt as a single text message part.
- Token usage and cost are extracted from the OpenCode message response.
- The OpenCode server must be reachable from the Paperclip server process.
`;
