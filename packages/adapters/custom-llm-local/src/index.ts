export { getConfigSchema } from "./schema.js";

export const agentConfigurationDoc = `
# Custom LLM (Local) Adapter

Calls local or proxy LLM endpoints directly via OpenAI-compatible or Anthropic-compatible HTTP APIs.
No provider inference — model ID is passed verbatim to the endpoint.

## Required fields
- **model** — model ID sent verbatim (e.g. \`or-llama-4-scout\`)
- **baseUrl** — endpoint base URL (e.g. \`http://127.0.0.1:8317/v1\`)
- **transport** — \`openai_chat_completions\` or \`anthropic_messages\`

## Optional fields
- **apiKeyEnv** — name of the env var holding the API key
- **instructionsFilePath** — absolute path to AGENTS.md
- **timeoutSec** / **graceSec** — timeout control
- **modelAlias** — canonical model ID for display/records
- **extraHeaders** — additional HTTP headers

## Security
Never put raw API keys in adapterConfig. Use \`apiKeyEnv\` to reference a server environment variable.
`.trim();

export const models = [];
