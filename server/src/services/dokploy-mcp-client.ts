import { logger } from "../middleware/logger.js";

/**
 * Minimal MCP client for Dokploy.
 * Speaks JSON-RPC 2.0 over HTTP (MCP streamable-HTTP transport).
 * Only the `get-application-logs` tool is exposed.
 */

const DOKPLOY_MCP_URL = process.env.DOKPLOY_MCP_URL; // e.g. http://dokploy-mcp:3001/mcp

let _jsonRpcId = 0;
function nextId() {
  return ++_jsonRpcId;
}

export interface ApplicationLogs {
  logs: string;
  applicationId: string;
}

async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (!DOKPLOY_MCP_URL) {
    throw new Error("DOKPLOY_MCP_URL is not configured. Set it to the Dokploy MCP server endpoint.");
  }

  const body = {
    jsonrpc: "2.0",
    id: nextId(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const res = await fetch(DOKPLOY_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    logger.error({ status: res.status, body: text }, "Dokploy MCP request failed");
    throw new Error(`Dokploy MCP returned HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    result?: { content?: Array<{ text?: string }> };
    error?: { code: number; message: string };
  };

  if (json.error) {
    logger.error({ mcpError: json.error }, "Dokploy MCP tool error");
    throw new Error(`Dokploy MCP error: ${json.error.message}`);
  }

  return json.result;
}

export async function getApplicationLogs(applicationId: string): Promise<ApplicationLogs> {
  const result = (await callTool("get-application-logs", {
    applicationId,
  })) as { content?: Array<{ text?: string }> } | undefined;

  const text =
    result?.content
      ?.map((c) => c.text ?? "")
      .join("\n")
      .trim() ?? "";

  return { logs: text, applicationId };
}

export function isDokployMcpConfigured(): boolean {
  return !!DOKPLOY_MCP_URL;
}
