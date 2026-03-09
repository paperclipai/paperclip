export const type = "nanoclaw_gateway";
export const label = "NanoClaw Gateway";

export const models: { id: string; label: string }[] = [];

export const NANOCLAW_AGENTS = ["dozer", "scout", "myco", "sally"] as const;
export type NanoClawAgent = (typeof NANOCLAW_AGENTS)[number];

export const agentConfigurationDoc = `# nanoclaw_gateway agent configuration

Adapter: nanoclaw_gateway

Use when:
- You want Paperclip to invoke NanoClaw agents (Dozer, Scout, Myco, Sally) via NanoClaw's HTTP API.
- NanoClaw runs Docker-containerized Claude agents with their own MCP server on port 18790.

Don't use when:
- You want to talk to the OpenClaw gateway directly (use openclaw_gateway instead).
- Your NanoClaw instance is not running.

Core fields:
- url (string, optional): NanoClaw HTTP base URL (default http://127.0.0.1:18790)
- agentName (string, required): NanoClaw agent to route to (dozer, scout, myco, sally, or custom)
- agentId (string, optional): Paperclip agent ID override (defaults to agentName)

Request behavior fields:
- timeoutMs (number, optional): HTTP request timeout in milliseconds (default 30000)

How it works:
- Paperclip POSTs to NanoClaw's /paperclip/wakeup endpoint with { agentId, runId, context }
- NanoClaw maps agentId to a registered group via the paperclipAgentId field
- The agent runs in a Docker container and delivers output via WhatsApp
- This is fire-and-forget — results are delivered asynchronously via WhatsApp, not returned to Paperclip
`;
