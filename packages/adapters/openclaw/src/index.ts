export const type = "openclaw";
export const label = "OpenClaw";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# openclaw agent configuration

Adapter: openclaw

Use when:
- You run an OpenClaw agent remotely and wake it over HTTP.
- You want SSE-first execution so one Paperclip run captures live progress and completion.

Don't use when:
- You need local CLI execution inside Paperclip (use claude_local/codex_local/opencode_local/process).
- The OpenClaw endpoint is not reachable from the Paperclip server.

Core fields:
- url (string, required): OpenClaw endpoint URL
- streamTransport (string, optional): \`sse\` (default) or \`webhook\`
- method (string, optional): HTTP method, default POST
- headers (object, optional): extra HTTP headers for requests
- webhookAuthHeader (string, optional): Authorization header value if your endpoint requires auth
- payloadTemplate (object, optional): additional JSON payload fields merged into each wake payload

Session routing fields:
- sessionKeyStrategy (string, optional): \`fixed\` (default), \`issue\`, or \`run\`
- sessionKey (string, optional): fixed session key value when strategy is \`fixed\` (default \`paperclip\`)

Operational fields:
- timeoutSec (number, optional): request timeout in seconds (default 30)
`;
