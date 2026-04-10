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
- url (string, optional): OpenClaw gateway WebSocket URL (ws:// or wss://); if omitted, defaults to ws://127.0.0.1:18789 (same host)
- headers (object, optional): handshake headers; supports x-openclaw-token / x-openclaw-auth
- authToken (string, optional): shared gateway token override
- Server fallback (no token in config): env \`PAPERCLIP_OPENCLAW_GATEWAY_TOKEN\` or \`PAPERCLIP_OPENCLAW_GATEWAY_TOKEN_FILE\` (path to \`gateway.token\`) is read by the adapter when the agent config has no credentials.
- password (string, optional): gateway shared password, if configured

Gateway connect identity fields:
- clientId (string, optional): gateway client id (default gateway-client)
- clientMode (string, optional): gateway client mode (default backend)
- clientVersion (string, optional): client version string
- role (string, optional): gateway role (default operator)
- scopes (string[] | comma string, optional): gateway scopes (default ["operator.admin"])
- disableDeviceAuth (boolean, optional): disable signed device payload in connect params (default false)

Request behavior fields:
- payloadTemplate (object, optional): additional fields merged into gateway agent params
- workspaceRuntime (object, optional): reserved workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- timeoutSec (number, optional): adapter timeout in seconds (default 900)
- waitTimeoutMs (number, optional): agent.wait timeout override in milliseconds (default timeoutSec * 1000)
- Note: the gateway \`agent\` RPC \`timeout\` field is in **seconds** (OpenClaw). Paperclip sets it from \`timeoutSec\`, or from \`waitTimeoutMs / 1000\` when \`timeoutSec\` is 0.
- Subagents (\`sessions_spawn\`): child run length is controlled by OpenClaw \`agents.defaults.subagents.runTimeoutSeconds\` in **openclaw.json** (seconds). Raise it there (e.g. 900) if subagents hit timeouts while the Paperclip parent already uses a higher \`waitTimeoutMs\`.
- autoPairOnFirstConnect (boolean, optional): on first "pairing required", attempt device.pair.list/device.pair.approve via shared auth, then retry once (default true)
- paperclipApiUrl (string, optional): absolute Paperclip base URL advertised in wake text
- claimedApiKeyPath (string, optional): path to the claimed API key JSON file read by the agent at wake time (default ~/.openclaw/workspace/paperclip-claimed-api-key.json)

Session routing fields:
- sessionKeyStrategy (string, optional): issue (default), fixed, or run
- sessionKey (string, optional): fixed session key when strategy=fixed (default paperclip)

Standard outbound context (OpenClaw agent params forbid extra root keys):
- The same structured Paperclip context is appended to the gateway field "extraSystemPrompt" as a "## Paperclip context" JSON block (a root "paperclip" property is rejected).
- Includes workspace, workspaces, workspaceRuntime, wake metadata, and env-derived fields as built by the adapter.

Standard result metadata supported:
- meta.runtimeServices (array, optional): normalized adapter-managed runtime service reports
- meta.previewUrl (string, optional): shorthand single preview URL
- meta.previewUrls (string[], optional): shorthand multiple preview URLs
`;
