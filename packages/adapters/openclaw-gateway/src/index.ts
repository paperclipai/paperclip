export const type = "openclaw_gateway";
export const label = "OpenClaw Gateway";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# openclaw_gateway agent configuration

Adapter: openclaw_gateway

Use when:
- You want Paperclip to invoke OpenClaw over the Gateway WebSocket protocol.
- You want native gateway auth/connect semantics instead of HTTP /v1/responses or /hooks/*.

Don't use when:
- You only expose OpenClaw HTTP endpoints.
- Your deployment does not permit outbound WebSocket access from the Paperclip server.

Core fields:
- url (string, required): OpenClaw gateway WebSocket URL (ws:// or wss://)
- authToken (string, optional): shared gateway token override
- authTokenRef (secret_ref, optional): Bizbox-managed secret reference for the gateway token
- headers (object, optional): handshake headers; supports x-openclaw-token / x-openclaw-auth
- password (string, optional): gateway shared password, if configured

Managed business flow:
- In the primary Connect OpenClaw flow, operators should only provide Gateway URL and Access token.
- Bizbox persists the token securely and resolves authTokenRef at runtime. Do not require users to paste raw headers.

Gateway connect identity fields:
- clientId (string, optional): gateway client id (default gateway-client)
- clientMode (string, optional): gateway client mode (default backend)
- clientVersion (string, optional): client version string
- role (string, optional): gateway role (default operator)
- scopes (string[] | comma string, optional): gateway scopes (default ["operator.admin", "operator.write"]; explicit custom scopes are used as provided)
- disableDeviceAuth (boolean, optional): disable signed device payload in connect params (default true; set false only for explicit pairing mode)

Request behavior fields:
- payloadTemplate (object, optional): additional fields merged into gateway agent params
- workspaceRuntime (object, optional): reserved workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- timeoutSec (number, optional): adapter timeout in seconds (default 120)
- waitTimeoutMs (number, optional): agent.wait timeout override (default timeoutSec * 1000)
- autoPairOnFirstConnect (boolean, optional): on first "pairing required", attempt device.pair.list/device.pair.approve via shared auth, then retry once (default true when device auth is enabled)
- paperclipApiUrl (string, optional): absolute Paperclip base URL advertised in wake text
- claimedApiKeyPath (string, optional): path to the claimed API key JSON file read by the agent at wake time (default ~/.openclaw/workspace/paperclip-claimed-api-key.json)
- artifactOutputs (array, optional): declared workspace-relative output file/glob patterns to collect as downloadable deliverables after successful issue-backed runs

Session routing fields:
- sessionKeyStrategy (string, optional): issue (default), fixed, or run
- sessionKey (string, optional): fixed session key when strategy=fixed (default paperclip)

Outbound payload behavior:
- Wake context is included in the structured wake message/text sent to the gateway agent.
- payloadTemplate fields are merged directly into gateway agent params.
- Do not rely on a top-level paperclip params object; OpenClaw may reject unknown top-level params.
- The adapter strips payloadTemplate.paperclip before sending the agent request. Paperclip context belongs in the wake message, not in agent params.

Standard result metadata supported:
- meta.runtimeServices (array, optional): normalized adapter-managed runtime service reports
- meta.previewUrl (string, optional): shorthand single preview URL
- meta.previewUrls (string[], optional): shorthand multiple preview URLs
- gateway artifacts.list + artifacts.download (optional): adapter will ingest declared output files when the gateway exposes artifact RPCs for the run/session scope
`;
