export const type = "openclaw";
export const label = "OpenClaw";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# openclaw agent configuration

Adapter: openclaw

Use when:
- You run an OpenClaw agent remotely and wake it via webhook.
- You want Paperclip heartbeat/task events delivered over HTTP.

Don't use when:
- You need local CLI execution inside Paperclip (use claude_local/codex_local/opencode_local/process).
- The OpenClaw endpoint is not reachable from the Paperclip server.

Core fields:
- url (string, required): OpenClaw webhook endpoint URL
- method (string, optional): HTTP method, default POST
- headers (object, optional): extra HTTP headers for webhook calls
- webhookAuthHeader (string, optional): Authorization header value if your endpoint requires auth
- payloadTemplate (object, optional): additional JSON payload fields merged into each wake payload

Operational fields:
- timeoutSec (number, optional): request timeout in seconds (default 30)
`;
