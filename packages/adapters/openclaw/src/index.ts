export const type = "openclaw";
export const label = "OpenClaw";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# openclaw agent configuration

Adapter: openclaw

Use when:
- You run an OpenClaw agent remotely and wake it over HTTP.
- You want selectable transport:
  - \`sse\` for streaming execution in one Paperclip run.
  - \`webhook\` for wake-style callbacks (\`/hooks/wake\`, \`/hooks/agent\`, or compatibility webhooks).

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
- paperclipApiUrl (string, optional): absolute http(s) Paperclip base URL to advertise to OpenClaw as \`PAPERCLIP_API_URL\`
- hookIncludeSessionKey (boolean, optional): when true, include derived \`sessionKey\` in \`/hooks/agent\` webhook payloads (default false)

Session routing fields:
- sessionKeyStrategy (string, optional): \`fixed\` (default), \`issue\`, or \`run\`
- sessionKey (string, optional): fixed session key value when strategy is \`fixed\` (default \`paperclip\`)

Operational fields:
- timeoutSec (number, optional): SSE request timeout in seconds (default 0 = no adapter timeout)

Hire-approved callback fields (optional):
- hireApprovedCallbackUrl (string): callback endpoint invoked when this agent is approved/hired
- hireApprovedCallbackMethod (string): HTTP method for the callback (default POST)
- hireApprovedCallbackAuthHeader (string): Authorization header value for callback requests
- hireApprovedCallbackHeaders (object): extra headers merged into callback requests
`;
