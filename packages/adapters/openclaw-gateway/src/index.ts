export const type = "openclaw_gateway";
export const label = "OpenClaw Gateway";

export { models } from "./models.js";

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
- headers (object, optional): handshake headers; supports x-openclaw-token / x-openclaw-auth
- authToken (string, optional): shared gateway token override
- password (string, optional): gateway shared password, if configured

Gateway connect identity fields:
- clientId (string, optional): gateway client id (default gateway-client)
- clientMode (string, optional): gateway client mode (default backend)
- clientVersion (string, optional): client version string
- role (string, optional): gateway role (default operator)
- scopes (string[] | comma string, optional): gateway scopes (default ["operator.admin", "operator.pairing"])
- disableDeviceAuth (boolean, optional): disable signed device payload in connect params (default false)

Request behavior fields:
- model (string, optional): provider/model id forwarded on gateway agent requests; when omitted, OpenClaw uses its configured default model routing
- fallbackModels (string[] | comma string, optional): ordered backup model ids retried when the active model fails with a transient upstream/provider error
- instructionsFilePath (string, optional): local instructions file whose contents are prepended to the OpenClaw wake message before the Paperclip workflow instructions
- payloadTemplate (object, optional): additional fields merged into gateway agent params
- workspaceRuntime (object, optional): reserved workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- timeoutSec (number, optional): adapter timeout in seconds (default 120)
- waitTimeoutMs (number, optional): agent.wait timeout override (default timeoutSec * 1000)
- autoPairOnFirstConnect (boolean, optional): on first "pairing required", attempt device.pair.list/device.pair.approve via shared auth, then retry once (default true)
- paperclipApiUrl (string, optional): absolute Paperclip base URL advertised in wake text
- claimedApiKeyPath (string, optional): path to the claimed API key JSON file read by the agent at wake time (default ~/.openclaw/workspace/paperclip-claimed-api-key.json)

Session routing fields:
- sessionKeyStrategy (string, optional): issue (default), fixed, or run; issue uses paperclip:issue:<issueId> when an issue id is present and falls back to a fresh run-scoped session when it is not
- sessionKey (string, optional): fixed session key when strategy=fixed (default paperclip)

Standard outbound payload additions:
- paperclip (object): standardized Paperclip context added to every gateway agent request
- paperclip.workspace (object, optional): resolved execution workspace for this run
- paperclip.workspaces (array, optional): additional workspace hints Paperclip exposed to the run
- paperclip.workspaceRuntime (object, optional): reserved workspace runtime metadata when explicitly supplied outside normal heartbeat execution

Standard result metadata supported:
- meta.runtimeServices (array, optional): normalized adapter-managed runtime service reports
- meta.previewUrl (string, optional): shorthand single preview URL
- meta.previewUrls (string[], optional): shorthand multiple preview URLs
`;
