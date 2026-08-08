import type { AdapterConfigSchema, ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const openAiCompatibleConfigSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "baseUrl",
      label: "Base URL",
      type: "text",
      default: "http://127.0.0.1:8080",
      hint: "Base URL for the API server when `url` is not provided.",
    },
    {
      key: "url",
      label: "Endpoint URL",
      type: "text",
      hint: "Optional full chat-completions URL. If provided, Base URL is ignored.",
    },
    {
      key: "endpointPath",
      label: "Endpoint path",
      type: "text",
      default: "/v1/chat/completions",
      hint: "Used with Base URL when Endpoint URL is empty.",
    },
    {
      key: "model",
      label: "Model",
      type: "text",
      required: true,
      hint: "Model ID accepted by this endpoint.",
    },
    {
      key: "systemPrompt",
      label: "System prompt",
      type: "textarea",
      hint: "Optional custom system prompt for this run.",
    },
    {
      key: "promptTemplate",
      label: "Prompt template",
      type: "textarea",
      hint: "Template used for the user message. Supports `{{context}}`, `{{agent.*}}`, `{{runId}}`.",
    },
    {
      key: "timeoutMs",
      label: "Request timeout (ms)",
      type: "number",
      default: 30000,
      hint: "Hard timeout passed to the request. 0 disables timeout.",
    },
  ],
};

export const openAiCompatibleAdapter: ServerAdapterModule = {
  type: "openai_compatible",
  execute,
  testEnvironment,
  getConfigSchema: () => openAiCompatibleConfigSchema,
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: `# openai_compatible agent configuration

Adapter: openai_compatible

Runs one OpenAI-compatible chat completion request and captures the assistant
message content as the Paperclip run result. Intended for local/self-hosted
pilot endpoints such as llama.cpp-compatible servers.

Core fields:
- baseUrl (string, required unless url is set): endpoint base URL, for example http://127.0.0.1:8080
- url (string, optional): full chat completions URL
- endpointPath (string, optional): default /v1/chat/completions
- model (string, required): model name to send to the endpoint
- systemPrompt (string, optional): system message template
- promptTemplate (string, optional): user message template; receives {{agent.*}}, {{runId}}, and {{context.*}}
- timeoutMs (number, optional): request timeout in milliseconds

Rollback: switch the pilot agent back to its previous adapter type/config or
pause the agent. This adapter has no migrations or persistent runtime state.
`,
};
