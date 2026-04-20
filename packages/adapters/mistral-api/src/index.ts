export const type = "mistral_api";
export const label = "Mistral API";

export const models = [
  { id: "mistral-tiny", label: "Mistral Tiny" },
  { id: "mistral-small", label: "Mistral Small" },
  { id: "mistral-medium", label: "Mistral Medium" },
  { id: "mistral-large", label: "Mistral Large" },
  { id: "codestral", label: "Codestral" },
];

export const agentConfigurationDoc = `# mistral_api agent configuration

Adapter: mistral_api

Core fields:
- apiKey (string, required): Mistral API key
- model (string, optional): Mistral model id (default: mistral-small)
- temperature (number, optional): Temperature for sampling (0.0-1.0, default: 0.7)
- maxTokens (number, optional): Maximum number of tokens to generate
- topP (number, optional): Nucleus sampling parameter (0.0-1.0)
- safePrompt (boolean, optional): Enable safe prompt filtering
- randomSeed (number, optional): Random seed for reproducibility

Operational fields:
- timeoutSec (number, optional): request timeout in seconds
- retries (number, optional): number of retry attempts for failed requests

Notes:
- Requires a valid Mistral API key from https://mistral.ai
- All requests are made to https://api.mistral.ai/v1/chat/completions
- Supports streaming responses for real-time interaction
`;

export { createServerAdapter } from "./server/create-server-adapter.js";
