import { CONNECTION_REQUEST_TOOL_DESCRIPTION, CONNECTIONS_SEARCH_TOOL_DESCRIPTION } from "@paperclipai/shared";

export const RUNTIME_CONNECTION_TOOL_DEFINITIONS = [
  {
    name: "connections_search",
    description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "connection_request",
    description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { service: { type: "string" } },
      required: ["service"],
      additionalProperties: false,
    },
  },
] as const;

