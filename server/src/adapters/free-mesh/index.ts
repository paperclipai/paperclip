import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import {
  DEFAULT_FREE_MESH_MODEL,
  FREE_MESH_ADAPTER_TYPE,
  FREE_MESH_DATA_POLICY,
  FREE_MESH_MODELS,
} from "./constants.js";

export const freeMeshAdapter: ServerAdapterModule = {
  type: FREE_MESH_ADAPTER_TYPE,
  execute,
  testEnvironment,
  models: [...FREE_MESH_MODELS],
  modelProfiles: [
    {
      key: "cheap",
      label: "Free mesh",
      description: "Route low-stakes public validation/research through the LiteLLM free mesh.",
      adapterConfig: {
        model: DEFAULT_FREE_MESH_MODEL,
        dataPolicy: FREE_MESH_DATA_POLICY,
      },
      source: "adapter_default",
    },
  ],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: `# free-mesh agent configuration

Adapter: free-mesh

Purpose:
- Low-stakes public validation, swarm checks, and research only.
- Do not use for master, high-stakes, proprietary, customer, regulated, or secret-bearing work. Use claude_local or codex_local for those roles.
- The adapter does not receive a Paperclip local agent JWT, so it cannot mutate the control plane by default.

Core fields:
- baseUrl (string, optional): OpenAI-compatible API root. May end with /v1. Defaults to env.FREE_MESH_BASE_URL, then process.env.FREE_MESH_BASE_URL.
- apiKey (string, optional): OpenAI-compatible API key. Prefer env.FREE_MESH_API_KEY as a secret_ref instead of inline text. Falls back to process.env.FREE_MESH_API_KEY.
- env (object, optional): secret-aware environment values; configure FREE_MESH_BASE_URL and FREE_MESH_API_KEY here for production.
- model (string, optional): LiteLLM model name. Defaults to "swarm-public".
- dataPolicy (string, required): must be "low_stakes_public_only". This is an explicit operator acknowledgement that the task content may be sent to the selected free-mesh lane; it is not filtering or sanitization.
- promptTemplate (string, optional): custom user prompt. Defaults to a compact Paperclip task-context prompt.
- temperature (number, optional): OpenAI-compatible temperature. Defaults to 0.2.
- timeoutMs (number, optional): request timeout in milliseconds. Defaults to 60000.

Trust lanes:
- swarm-public: PRC public lane. Use only for public/non-confidential context.
- swarm-internal: US/EU lane. Use only for low-stakes TWB internal context; still do not send customer, production, regulated, or secret-bearing data.

Context egress:
- With the default promptTemplate, the adapter serializes the full Paperclip task context JSON and sends it to the selected LiteLLM model lane. This can include issue identifiers, titles, descriptions, comments, ancestry, and any other context fields supplied to the adapter run.
- Custom promptTemplate values replace the default context prompt. Operators are responsible for limiting what the custom prompt includes.

Usage:
1. Store the LiteLLM proxy URL/key as company secrets or environment values.
2. Create a low-stakes validation/research agent with adapterType "free-mesh".
3. Set adapterConfig.env.FREE_MESH_BASE_URL and adapterConfig.env.FREE_MESH_API_KEY via secret bindings, choose model "swarm-public" or "swarm-internal" deliberately, and set dataPolicy to "low_stakes_public_only".
4. Keep Claude/Codex as master and high-stakes adapters. Never assign proprietary/customer/secret tasks to free-mesh agents.
`,
  getConfigSchema: () => ({
    fields: [
      {
        key: "baseUrl",
        label: "LiteLLM base URL",
        type: "text",
        hint: "OpenAI-compatible API root, for example https://litellm.example/v1. Prefer FREE_MESH_BASE_URL via env secrets.",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "text",
        hint: "Prefer env.FREE_MESH_API_KEY as a secret binding; inline values are supported only for local testing.",
      },
      {
        key: "model",
        label: "Model",
        type: "combobox",
        default: DEFAULT_FREE_MESH_MODEL,
        options: FREE_MESH_MODELS.map((model) => ({ value: model.id, label: model.label })),
        hint: "LiteLLM model group exposed by the free mesh. Select the trust lane deliberately; the adapter does not sanitize context.",
      },
      {
        key: "dataPolicy",
        label: "Data policy",
        type: "select",
        default: FREE_MESH_DATA_POLICY,
        required: true,
        options: [
          {
            value: FREE_MESH_DATA_POLICY,
            label: "Low-stakes public only",
          },
        ],
        hint: "Required acknowledgement: the configured prompt/context may egress to the selected mesh lane; do not send customer, regulated, or secret-bearing data.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        default: 0.2,
      },
      {
        key: "timeoutMs",
        label: "Timeout ms",
        type: "number",
        default: 60000,
      },
      {
        key: "env",
        label: "Environment JSON",
        type: "textarea",
        hint: "Optional JSON object or secret bindings. Recommended keys: FREE_MESH_BASE_URL and FREE_MESH_API_KEY.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Optional override. Leave blank to send the default validation/research task prompt.",
      },
    ],
  }),
};
