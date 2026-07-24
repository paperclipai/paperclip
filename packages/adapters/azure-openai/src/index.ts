import type { AdapterSessionManagement, ServerAdapterModule } from "@paperclipai/adapter-utils";

import { ADAPTER_LABEL, ADAPTER_TYPE } from "./shared/constants.js";
import {
  execute,
  testEnvironment,
  sessionCodec,
  getConfigSchema,
} from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

export const models: { id: string; label: string }[] = [];

const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: false,
  nativeContextManagement: "none",
};

export const agentConfigurationDoc = `# azure_openai agent configuration

Adapter: azure_openai

Covers three Azure surfaces with one adapter:

1. Azure OpenAI resource + named deployment (classic).
2. Azure AI Foundry serverless deployments.
3. Azure AI Foundry model / Agent endpoints using the OpenAI Responses API
   (URL like https://<project>.services.ai.azure.com/openai/v1/responses).

Endpoint URL construction is controlled by endpointMode:
- deployment (default): adapter builds the URL from endpoint + deployment + apiVersion.
- raw: adapter posts to endpoint verbatim. Use for the Foundry per-model URL you
  copied from the portal.

Request/response shape is controlled by apiSurface:
- auto (default): URLs ending in /responses go through the Responses API;
  everything else goes through Chat Completions.
- chat_completions: classic /chat/completions shape.
- responses: OpenAI Responses API — input + instructions in,
  response.output_text.delta + response.completed SSE out.

Authentication (authMode):
- api_key (default): sends 'api-key: <apiKey>'.
- bearer: sends 'Authorization: Bearer <bearerToken>'. Operator refreshes
  the token externally (adapter never refreshes).
- azure_ad: uses @azure/identity DefaultAzureCredential for the
  https://cognitiveservices.azure.com/.default scope (override with aadScope).
  Handles managed identity, az login, env vars, interactive browser.
  In-process token cache with 5-min refresh margin. Required for tenants
  where API key auth is disabled.

Required fields:
- endpoint (string).
- One of: apiKey (authMode=api_key), bearerToken (authMode=bearer),
  a working AAD identity (authMode=azure_ad).
- deployment (only when endpointMode=deployment and deploymentKind=azure_openai).

Optional: endpointMode, deploymentKind, apiSurface, authMode, aadScope, model,
apiVersion, systemPrompt, temperature, maxOutputTokens, timeoutSec, headers.

Runtime mapping:
- Renders the Paperclip wake payload through the shared prompt renderer so
  recovery, plan-review, and task-context scaffolding match every other adapter.
- Sends POST with stream=true; parses SSE and forwards content deltas to
  ctx.onLog("stdout", ...) in real time.
- Reports usage.{inputTokens, outputTokens, cachedInputTokens?} from the final
  frame. usageBasis="per_run".
- Best-effort USD cost from a per-model table (server/pricing.ts) with
  longest-prefix match. Unknown deployments return costUsd=null so budgets
  track tokens honestly.

Billing type: metered_api (Azure pay-as-you-go).

Security guidance:
- Prefer azure_ad in AAD-only tenants. Otherwise use bearer with an
  externally refreshed token, or api_key where it is enabled.
- The adapter never puts credentials in prompts, comments, or resultJson.
  onMeta.context.headers shows Authorization/api-key as '***'.
`;

/**
 * External adapter plugin entrypoint expected by Paperclip's adapter manager.
 * Also imported directly by server/src/adapters/registry.ts for the first-party
 * built-in registration.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    supportsLocalAgentJwt: false,
    supportsInstructionsBundle: false,
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema,
  };
}

export { createServerAdapter as createAzureOpenAIServerAdapter };
