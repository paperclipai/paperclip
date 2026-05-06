import type { AdapterModel, ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const DEFAULT_CLOUDFLARE_WORKERS_AI_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";

export const CLOUDFLARE_WORKERS_AI_MODELS: AdapterModel[] = [
  {
    id: DEFAULT_CLOUDFLARE_WORKERS_AI_MODEL,
    label: "Qwen 2.5 Coder 32B Instruct (Cloudflare)",
  },
];

export const cloudflareWorkersAiAdapter: ServerAdapterModule = {
  type: "cloudflare_workers_ai",
  execute,
  testEnvironment,
  models: CLOUDFLARE_WORKERS_AI_MODELS,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: `# cloudflare_workers_ai agent configuration

Adapter: cloudflare_workers_ai

Use when:
- You want Paperclip to call Cloudflare Workers AI directly
- You want to route those requests through Cloudflare AI Gateway when desired
- You want an easy way to use proxied models such as alibaba/qwen3-max

Core fields:
- accountId (string, required): Cloudflare account ID
- apiToken (string, required): Cloudflare API token with Workers AI access
- gatewayId (string, optional): AI Gateway name; when set, requests use the OpenAI-compatible AI Gateway endpoint
- model (string, optional): Workers AI model id; defaults to ${DEFAULT_CLOUDFLARE_WORKERS_AI_MODEL}
- timeoutSec (number, optional): request timeout in seconds
- maxCompletionTokens (number, optional): optional max completion token cap
- temperature (number, optional): optional generation temperature
- headers (object, optional): extra HTTP headers sent with each request

Prompt fields:
- promptTemplate (string, optional): Paperclip heartbeat prompt template
- bootstrapPromptTemplate (string, optional): optional bootstrap prompt for fresh sessions
- instructionsFilePath (string, optional): markdown instructions prepended to the prompt

Notes:
- When gatewayId is set, Paperclip calls https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/compat/chat/completions
- Gateway requests automatically use the documented cf-aig-authorization header and a workers-ai/{model} request model.
- Otherwise it calls https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/{model}
- This adapter is stateless; it does not persist provider-side sessions.
`,
};
