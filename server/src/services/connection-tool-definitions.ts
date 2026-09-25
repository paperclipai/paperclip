import { CONNECTION_REQUEST_TOOL_DESCRIPTION, CONNECTIONS_SEARCH_TOOL_DESCRIPTION } from "@paperclipai/shared";

export const RUNTIME_CONNECTION_TOOL_DEFINITIONS = [
  {
    name: "connections_search",
    description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, retryProviderChoice: { type: "boolean", description: "Only when the user explicitly asks to reconsider a previous provider choice or decline" } },
      additionalProperties: false,
    },
  },
  {
    name: "connection_request",
    description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { service: { type: "string" }, targetService: { type: "string", description: "App slug returned by search only when the user explicitly named this external provider" }, selectionInteractionId: { type: "string", description: "Saved answered provider-choice interaction ID for aggregator routes" } },
      required: ["service"],
      additionalProperties: false,
    },
  },
] as const;

