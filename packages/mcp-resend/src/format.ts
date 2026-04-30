import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ResendApiError } from "./client.js";

export function formatTextResponse(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

export function formatErrorResponse(error: unknown): CallToolResult {
  if (error instanceof ResendApiError) {
    return formatTextResponse({ error: error.message, statusCode: error.statusCode });
  }
  return formatTextResponse({ error: error instanceof Error ? error.message : String(error) });
}
