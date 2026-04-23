export const type = "hermes_gateway";
export const label = "Hermes Gateway";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# hermes_gateway agent configuration

Adapter: hermes_gateway

Use when:
- You want Paperclip to connect to a standalone Hermes Agent running on the network (e.g. Railway)

Core fields:
- url (string, required): Hermes API base URL. Prefer a base ending in \`/v1\` (e.g., \`http://hermes-agent.internal:8642/v1\`). Legacy full endpoint URLs still work.
- apiKey (string, optional): Auth key setup in Hermes
- model (string, optional): Model override to send to Hermes. Leave blank to let Hermes use its own default model.
- apiMode (string, optional): \`chat_completions\` or \`responses\`. Defaults to \`chat_completions\` unless the configured URL already points at \`/v1/responses\`.
- timeoutSec (number, optional): Request timeout in seconds. Default 300.
- sessionKeyStrategy (string, optional): \`issue\`, \`run\`, or \`fixed\`. Used with Hermes Responses API conversation continuity. Default \`issue\`.
- sessionKey (string, optional): Fixed conversation key override when \`sessionKeyStrategy=fixed\`.
- storeResponses (boolean, optional): When using Responses API, keep Hermes server-side response history. Default true.

Behavior notes:
- This adapter stays within Hermes' OpenAI-compatible API surface.
- It prefers the Hermes Responses API when configured so Paperclip can get issue-scoped conversation continuity via \`conversation\`.
- When Hermes has the \`hermes-paperclip-plugin\` installed, the adapter prompt instructs Hermes to prefer first-class \`paperclip_*\` tools over raw HTTP.
`;
