/**
 * Azure OpenAI + Azure AI Foundry adapter for Paperclip.
 *
 * Wraps Azure's OpenAI-compatible /chat/completions endpoint (SSE streaming,
 * `api-key` header, `api-version` query parameter for classic Azure OpenAI;
 * plain /chat/completions for Foundry serverless deployments).
 *
 * @packageDocumentation
 */

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

/**
 * Model list is intentionally empty — the operator picks the deployment name
 * per Azure resource; there is no meaningful global list. UI should surface
 * `deployment` as a free-text field (see getConfigSchema()).
 */
export const models: { id: string; label: string }[] = [];

const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: false,
  nativeContextManagement: "none",
};

export const agentConfigurationDoc = `# azure_openai agent configuration

Adapter: azure_openai

Use when:
- The company already has an Azure OpenAI resource or an Azure AI Foundry
  serverless deployment, and you want to run a Paperclip agent directly against
  a chat model without owning a CLI agent.
- Compliance requires the model call to originate from Azure (data residency,
  private link, tenant-scoped auth).

Don't use when:
- The agent needs local tools, filesystem access, shell, or long-running
  in-process state — use a CLI adapter (claude_local, codex_local, hermes_local)
  and configure that CLI to talk to Azure OpenAI at the provider layer.
- The agent needs Copilot subscription semantics — use the GitHub Copilot
  adapter (roadmap; not this adapter).

Required fields:
- endpoint (string):
    Azure OpenAI resource URL, e.g. https://my-resource.openai.azure.com/
    or Foundry serverless URL, e.g. https://my-project.eastus2.inference.ai.azure.com/
- apiKey (string): Azure resource api-key OR Foundry inference key. Stored as
  a Paperclip secret; never appears in prompts or comments.
- deployment (string): required when deploymentKind='azure_openai'. Ignored
  (but recorded as model label) when deploymentKind='azure_ai_foundry'.

Optional fields:
- deploymentKind (azure_openai | azure_ai_foundry): defaults to azure_openai.
- apiVersion (string): defaults to 2024-10-21. Ignored for Foundry serverless.
- systemPrompt (string): stable system message prepended to every request.
- temperature (number): defaults to 0.2.
- maxOutputTokens (number): defaults to 4096.
- timeoutSec (number): defaults to 300.
- headers (JSON object): extra non-secret headers. Adapter-managed headers
  (Authorization, api-key, content-type) cannot be overridden.

Runtime mapping:
- Renders the Paperclip wake payload through the shared prompt renderer so
  recovery, plan-review, and task-context scaffolding match every other adapter.
- Sends POST {endpoint-shape}/chat/completions with stream=true and
  stream_options.include_usage=true; parses SSE frames and forwards content
  deltas to the Paperclip log stream in real time.
- Reports usage.{inputTokens,outputTokens,cachedInputTokens} and a best-effort
  costUsd from a built-in pricing table (see server/pricing.ts). Unknown
  deployments fall back to costUsd=null so budgets track tokens honestly.

Billing type: metered_api (Azure pay-as-you-go).

Security guidance:
- Prefer resource-level api-key with tight IP restrictions, or Azure AD
  bearer tokens via the extra 'headers' field (adapter still sends api-key
  by default; a follow-up change may add first-class AAD support).
- Do not put apiKey in prompts, comments, extraHeaders, or agent notes.
- Foundry serverless endpoints are per-model; treat the endpoint URL itself
  as sensitive if it identifies the customer.
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
