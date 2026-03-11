export const type = "nanobot_local";
export const label = "Nanobot Local";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# nanobot_local agent configuration

Adapter: nanobot_local

Use when:
- You have a long-running nanobot instance with its Paperclip channel enabled.
- You want Paperclip to send tasks to the nanobot over HTTP and receive responses.

Don't use when:
- You want to spawn a temporary nanobot process per run (use process adapter instead).
- The nanobot instance is not reachable from the Paperclip server.

Core fields:
- url (string, required): Base URL of the nanobot's Paperclip channel (e.g. http://localhost:9800)
- apiKey (string, optional): Bearer token for authenticating with the nanobot's Paperclip channel
- timeoutSec (number, optional): Seconds before the request times out (default 300)

Notes:
- The model is configured per-nanobot-instance, not per-Paperclip-agent.
- Each nanobot instance needs its own port for the Paperclip channel.
- Token usage (input/output tokens) is reported when the nanobot includes a usage object in its response.
`;
