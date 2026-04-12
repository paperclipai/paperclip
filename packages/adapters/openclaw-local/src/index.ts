export const type = "openclaw_local";
export const label = "OpenClaw Local";

export const models: { id: string; label: string }[] = [
  { id: "openclaw-default", label: "OpenClaw Default" },
];

export const agentConfigurationDoc = `# openclaw_local agent configuration

Adapter: openclaw_local

Use when:
- You want Paperclip to invoke a locally-running OpenClaw instance via REST API.
- OpenClaw gateway runs on port 18789 with REST endpoints.

Don't use when:
- You want WebSocket-based gateway communication (use openclaw_gateway).
- OpenClaw runs on a remote server (use http_agent adapter).

Core fields:
- endpoint (string, required): OpenClaw gateway REST endpoint (default http://localhost:18789)
- agentType (string, optional): OpenClaw agent type to invoke (default "main")
- authToken (string, optional): authentication token for gateway
- sessionKey (string, optional): session key for continuity

Operational fields:
- timeoutSec (number, optional): request timeout in seconds (default 120)
- pollIntervalMs (number, optional): polling interval for streaming results (default 1000)
`;
