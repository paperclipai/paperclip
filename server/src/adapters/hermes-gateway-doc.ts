export const hermesGatewayAgentConfigurationDoc = `# hermes_gateway agent configuration

Adapter: hermes_gateway

Use when:
- Hermes is already running outside Paperclip and exposes its API server.
- Paperclip should invoke Hermes through the gateway HTTP API instead of spawning Hermes locally.
- The Hermes runtime may live on another host, a private overlay, in Docker, or behind a TLS reverse proxy.

Don't use when:
- Paperclip should start the Hermes CLI directly on the same host. Use hermes_local from the external Hermes adapter plugin for that flow.
- Hermes is the process calling Paperclip APIs after claiming its key. That is Hermes-originated Paperclip API usage, not the gateway adapter transport.

Runtime distinction:
- hermes_local: Paperclip starts Hermes on the Paperclip host through the external Hermes adapter plugin.
- hermes_gateway: Paperclip calls an already-running Hermes API server using agentDefaultsPayload.apiBaseUrl.
- Hermes-originated Paperclip API usage: Hermes calls Paperclip with PAPERCLIP_API_URL and PAPERCLIP_BRIDGE_API_KEY. Create that Paperclip key with scope.kind = "task_bridge" and an approved parent/project boundary; do not expose a normal claimed agent key to Hermes-facing chat/webhook surfaces. Do not use agentDefaultsPayload.apiBaseUrl for Paperclip API calls.

Hermes gateway process setup:
- Set API_SERVER_ENABLED=true.
- Set API_SERVER_KEY to a generated secret value. Do not paste a real key into tickets, docs, screenshots, or tests.
- Start Hermes with: hermes gateway run --replace --accept-hooks
- Default Hermes API server port: 8642.

Join request minimum:
{
  "requestType": "agent",
  "agentName": "My Hermes Gateway Agent",
  "adapterType": "hermes_gateway",
  "capabilities": "Hermes gateway agent",
  "agentDefaultsPayload": {
    "apiBaseUrl": "http://127.0.0.1:8642",
    "apiKey": "<same-value-as-API_SERVER_KEY>",
    "paperclipApiUrl": "http://localhost:3100"
  }
}

Core fields:
- agentDefaultsPayload.apiBaseUrl (string, required): Base URL for the Hermes API server as reachable from the Paperclip server.
- agentDefaultsPayload.apiKey (string, required unless the adapter package documents another auth field): Hermes API server key matching API_SERVER_KEY.
- agentDefaultsPayload.paperclipApiUrl (string, strongly recommended): Paperclip base URL as reachable from Hermes for invite, claim, skill bootstrap, and later Paperclip API calls.
- agentDefaultsPayload.timeoutSec or timeoutMs (number, optional): Runtime request timeout when supported by the installed Hermes gateway adapter.

Network examples:
- Local loopback on one host: agentDefaultsPayload.apiBaseUrl = "http://127.0.0.1:8642"; agentDefaultsPayload.paperclipApiUrl = "http://127.0.0.1:3100".
- LAN/private network: agentDefaultsPayload.apiBaseUrl = "http://192.168.1.25:8642"; agentDefaultsPayload.paperclipApiUrl = "http://192.168.1.10:3100". Use private IPs or hostnames reachable from both machines.
- Private overlay: agentDefaultsPayload.apiBaseUrl = "http://hermes-host.tailnet-name.ts.net:8642"; agentDefaultsPayload.paperclipApiUrl = "http://paperclip-host.tailnet-name.ts.net:3100". Add the Paperclip hostname with pnpm paperclipai allowed-hostname <host> when authenticated/private mode requires it.
- Docker: if Hermes runs on the host and Paperclip runs in Docker, use agentDefaultsPayload.apiBaseUrl = "http://host.docker.internal:8642". If Hermes runs in another container, use the Compose service DNS name such as "http://hermes:8642".
- Reverse proxy/TLS: publish Hermes behind HTTPS and set agentDefaultsPayload.apiBaseUrl = "https://hermes-gateway.example"; set agentDefaultsPayload.paperclipApiUrl = "https://paperclip.example". Keep API_SERVER_KEY required at the origin or proxy.

Security notes:
- Treat API_SERVER_KEY and PAPERCLIP_BRIDGE_API_KEY as secrets.
- Never use a normal claimed Paperclip agent API key for internet-facing Hermes-originated task bridge calls; task_bridge keys cannot use company-wide issue list/search/read surfaces and can only mutate bridge-created or assigned issues.
- Prefer private network or TLS for non-loopback gateway access.
- Use placeholders such as <same-value-as-API_SERVER_KEY> in docs and tests.
`;
