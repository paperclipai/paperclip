export const type = "hermes_local";
export const label = "Hermes Agent";

export const models: { id: string; label: string }[] = [
  { id: "hermes-default", label: "Hermes Default" },
];

export const agentConfigurationDoc = `# hermes_local agent configuration

Adapter: hermes_local

Use when:
- You want Paperclip to invoke a locally-running Hermes agent.
- You need Cabinet memory sync for cross-agent knowledge sharing.
- You want Hermes skills, cron, and multi-platform integration.

Don't use when:
- You only need a simple CLI process (use process adapter).
- Hermes runs on a remote server (use http_agent adapter).

Core fields:
- command (string, required): hermes CLI command path
- args (string[] | string, optional): command arguments
- cwd (string, optional): working directory for hermes
- env (object, optional): KEY=VALUE environment variables
- workspace (string, optional): Hermes workspace path

Cabinet memory fields:
- cabinetEndpoint (string, optional): Cabinet API URL (default http://localhost:3000)
- cabinetSlug (string, optional): memory slug for this agent (default: agent name)
- cabinetMemorySync (string, optional): "bidirectional" | "push" | "pull" | "off" (default: "push")
- cabinetAutoAppend (boolean, optional): auto-append task completion to Cabinet (default: true)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
