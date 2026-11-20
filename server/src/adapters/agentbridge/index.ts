import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const agentbridgeAdapter: ServerAdapterModule = {
  type: "agentbridge",
  runtimeToolDelivery: "invocation_context",
  execute,
  testEnvironment,
  models: [
    { id: "default-agent", label: "Default agent" },
    { id: "web-agent", label: "Web agent" },
    { id: "search-agent", label: "Search agent" },
    { id: "research-agent", label: "Research agent" },
    { id: "email-agent", label: "Email agent" },
  ],
  getConfigSchema: () => ({
    fields: [
      {
        key: "url",
        label: "AgentBridge URL",
        type: "text",
        default: "http://localhost:5290",
        required: true,
        hint: "Base address of the AgentBridge server. Loopback and private origins must be listed in PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST.",
      },
      {
        key: "model",
        label: "Agent set",
        type: "text",
        default: "default-agent",
        hint: "AgentBridge agent set selected through the chat model field (see GET /v1/models).",
      },
      {
        key: "llmProvider",
        label: "LLM provider",
        type: "text",
        default: "",
        hint: "Optional AgentBridge LLM provider override (llm_provider).",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "text",
        default: "",
        hint: "Optional bearer token sent as the Authorization header.",
      },
      {
        key: "timeoutMs",
        label: "Request timeout (ms)",
        type: "number",
        default: 0,
        hint: "0 means no client-side timeout.",
      },
    ],
  }),
  agentConfigurationDoc: `# AgentBridge agent configuration

Adapter: agentbridge

Drives an AgentBridge OpenAI-compatible server (Graphene-Lab/AgentBridge) through
POST /v1/chat/completions. Paperclip renders the task and wake prompt and sends it as a
single user message; the AgentBridge session_id is carried in the run session params so
multi-turn heartbeats resume the same conversation.

Core fields:
- url (string, required): AgentBridge base address, default http://localhost:5290
- model (string, optional): agent set, default default-agent
- llmProvider (string, optional): AgentBridge LLM provider override (llm_provider)
- apiKey (string, optional): bearer token for the Authorization header
- timeoutMs (number, optional): request timeout in milliseconds, 0 for none

Loopback and private origins must be added to PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST
for the guarded HTTP fetch to reach a local AgentBridge instance.
`,
};
