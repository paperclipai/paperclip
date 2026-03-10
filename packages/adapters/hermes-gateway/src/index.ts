export const type = "hermes_gateway";
export const label = "Hermes Gateway";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# hermes_gateway agent configuration

Adapter: hermes_gateway

Use when:
- You want Paperclip to invoke Hermes over a persistent gateway/runtime connection.
- You want Hermes to control Paperclip agents directly instead of spawning hermes CLI locally.

Core fields:
- url (string, required): Hermes gateway WebSocket URL (ws:// or wss://)
- sessionKeyStrategy (string, optional): fixed (default), issue, or run
- sessionKey (string, optional): fixed session key override when strategy=fixed
- model (string, optional): model override advertised to Hermes
- toolsets (string|string[], optional): requested Hermes toolsets
- maxTurnsPerRun (number, optional): requested turn limit
- gatewayAuthToken (string, optional): shared token for the Hermes gateway transport
- paperclipApiUrl (string, optional): Paperclip API base URL override sent to Hermes

Notes:
- Paperclip resolves instructions locally and sends final system text to Hermes.
- Paperclip auth is passed as a per-run agent JWT.
- Session isolation is per Paperclip agent identity.
`;
