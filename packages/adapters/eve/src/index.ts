export const gatewayType = "eve_gateway";
export const localType = "eve_local";
export const gatewayLabel = "Eve Gateway";
export const localLabel = "Eve";
export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# eve agent configuration

Adapters: eve_gateway (this package also reserves eve_local for locally spawned Eve agents)

Use when:
- Your agent is built with Vercel's Eve framework (https://eve.dev) and is reachable over HTTP
- You want Paperclip heartbeats to map onto durable Eve sessions with follow-up messages
- The Eve agent runs via \`eve dev\` locally or is deployed on Vercel

Do not use when:
- You want a CLI coding agent on the local machine — use claude_local/codex_local instead
- The target does not expose the Eve HTTP contract (/eve/v1/session, /eve/v1/info)

Core fields (eve_gateway):
- baseUrl (string, required): root URL of the running Eve agent, e.g. https://my-agent.vercel.app or http://127.0.0.1:3000
- headers (object, optional): static request headers, e.g. {"Authorization": "Bearer <token>"} for deployed targets
- model (string, optional): informational only; Eve agents pin their own model
- timeoutMs (number, optional): per-HTTP-request timeout, default 30000
- runTimeoutMs (number, optional): whole-run cap, default 30 minutes
- instructionsFilePath (string, optional): agent instructions file prepended to the prompt
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): first-run-only bootstrap prompt template

Core fields (eve_local, later plan):
- projectDir (string): Eve project directory to launch
- command (string, optional): launch command override
- port (number, optional): local port to bind

Notes:
- Paperclip persists the Eve sessionId and continuationToken across heartbeats; each wake becomes a follow-up message on the same durable Eve session.
- A stale continuation token automatically falls back to starting a fresh Eve session.
- The adapter speaks plain HTTP/NDJSON; it does not require the eve npm package.
`;
