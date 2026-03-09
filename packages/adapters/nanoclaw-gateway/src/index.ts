export const type = "nanoclaw_gateway";
export const label = "NanoClaw Gateway";

export const models: { id: string; label: string }[] = [];

export const NANOCLAW_AGENTS = ["dozer", "scout", "myco", "sally"] as const;
export type NanoClawAgent = (typeof NANOCLAW_AGENTS)[number];

export const agentConfigurationDoc = `# nanoclaw_gateway agent configuration

Adapter: nanoclaw_gateway

Use when:
- You want Paperclip to invoke NanoClaw agents (Dozer, Scout, Myco, Sally) via the OpenClaw Gateway.
- NanoClaw runs Docker-containerized Claude agents on top of the OpenClaw gateway.

Don't use when:
- You want to talk to the OpenClaw gateway directly (use openclaw_gateway instead).
- Your NanoClaw instance is not running or the gateway is unreachable.

Core fields:
- url (string, optional): Gateway WebSocket URL (default ws://127.0.0.1:18789)
- agentName (string, required): NanoClaw agent to route to (dozer, scout, myco, sally, or custom)
- authToken (string, optional): shared gateway token override

Request behavior fields:
- timeoutSec (number, optional): adapter timeout in seconds (default 300 — NanoClaw agents run longer in Docker)
- waitTimeoutMs (number, optional): agent.wait timeout override (default timeoutSec * 1000)

Session routing fields:
- sessionKeyStrategy (string, optional): issue (default), fixed, or run
- sessionKey (string, optional): fixed session key when strategy=fixed (default paperclip)

All other OpenClaw gateway fields (headers, role, scopes, payloadTemplate, etc.) are also supported
and passed through to the underlying openclaw_gateway adapter.
`;
