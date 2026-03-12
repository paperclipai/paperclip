export const type = "remote_node";
export const label = "Remote Node";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# remote_node agent configuration

Adapter: remote_node

Use when:
- The agent needs to run on a specific remote machine (e.g., a developer's Mac with browser access, a GPU workstation).
- You want to execute Claude Code (or another local adapter) on a machine outside the Paperclip server's host.
- The remote machine has tools, files, or network access not available on the server.

Don't use when:
- The agent can run locally on the Paperclip server host — use claude_local instead.
- You need a cloud-hosted execution environment — use openclaw_gateway instead.

Core fields:
- nodeId (string, uuid, required): ID of the registered remote node where this agent will execute.
  Use GET /api/companies/:companyId/nodes to see available nodes and their capabilities.
- localAdapterType (string, optional): The adapter type to use on the remote node for actual execution.
  Defaults to "claude_local". Other options: "codex_local", "opencode_local", "pi_local", "cursor".
- localAdapterConfig (object, optional): Adapter configuration passed through to the local adapter on the node.
  Supports the same fields as the chosen localAdapterType (e.g., cwd, instructionsFilePath, chrome, model).

Operational fields:
- timeoutSec (number, optional): Maximum seconds to wait for the remote runner to claim and complete the run. Default: 3600.

Example:
{
  "nodeId": "abc-123-def",
  "localAdapterType": "claude_local",
  "localAdapterConfig": {
    "cwd": "/Users/dev/project",
    "instructionsFilePath": "/Users/dev/project/AGENTS.md",
    "chrome": true
  },
  "timeoutSec": 1800
}

Notes:
- The remote node must be online (running \`paperclipai node run\`) for the agent to execute.
- Register nodes with \`paperclipai node register <name> --company-id <id>\`.
- The node runner picks up queued runs, executes them locally, and reports results back.
- Session continuity works across runs — the runner reports session state back to the server.
`;
