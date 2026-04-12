export const type = "http_agent";
export const label = "HTTP Agent";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# http_agent agent configuration

Adapter: http_agent

Use when:
- You want to connect Paperclip to any remote agent with an HTTP API.
- The agent runs on another server or in a different framework.
- You need a generic way to invoke remote agents.

Don't use when:
- The agent has a dedicated adapter (use claude_local, hermes_local, etc.).
- You need streaming (consider using openclaw_gateway for WebSocket).

Core fields:
- endpoint (string, required): base URL of the agent API
- promptEndpoint (string, optional): path to send prompts (default "/api/prompt")
- healthEndpoint (string, optional): path for health checks (default "/api/health")
- authHeader (string, optional): Authorization header value (e.g., "Bearer ...")

Request fields:
- method (string, optional): HTTP method (default "POST")
- headers (object, optional): additional request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutSec (number, optional): request timeout in seconds (default 120)

Response parsing:
- resultPath (string, optional): JSON path to extract result (default "result")
- statusPath (string, optional): JSON path to check status (default "status")
- errorPath (string, optional): JSON path to check for errors (default "error")
`;
