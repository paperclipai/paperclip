import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OutlookApiError } from "./client.js";

export function formatTextResponse(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

export function formatMixedResponse(
  blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
): CallToolResult {
  return { content: blocks as CallToolResult["content"] };
}

export function formatErrorResponse(error: unknown): CallToolResult {
  if (error instanceof OutlookApiError) {
    return formatTextResponse({ error: error.message, status: error.status, method: error.method, url: error.url, body: error.body });
  }
  return formatTextResponse({ error: error instanceof Error ? error.message : String(error) });
}
