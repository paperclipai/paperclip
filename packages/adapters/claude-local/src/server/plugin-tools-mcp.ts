/**
 * Minimal MCP (Model Context Protocol) stdio server that exposes Paperclip
 * plugin tools to a Claude Code subprocess.
 *
 * This file is spawned as a child process by the claude_local adapter when
 * plugin tools are available. It reads tool descriptors from a JSON file
 * (path passed as argv[2]) and proxies execution calls to the Paperclip API.
 *
 * Protocol: JSON-RPC 2.0 over stdio — one JSON object per line on stdin,
 * one per line on stdout (newline-delimited transport).
 */

import { createInterface } from "node:readline";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Tool descriptor shape (matches AgentToolDescriptor from the server)
// ---------------------------------------------------------------------------

interface ToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  pluginId: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isValidToolDescriptor(value: unknown): value is ToolDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.description === "string";
}

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LOCALHOST_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap: read tool descriptors and env config
// ---------------------------------------------------------------------------

const toolsFilePath = process.argv[2];
if (!toolsFilePath) {
  process.stderr.write("plugin-tools-mcp: missing tools file path argument\n");
  process.exit(1);
}

let tools: ToolDescriptor[];
try {
  const raw = JSON.parse(readFileSync(toolsFilePath, "utf-8"));
  if (!Array.isArray(raw)) {
    process.stderr.write("plugin-tools-mcp: tools file must contain a JSON array\n");
    process.exit(1);
  }
  tools = raw.filter((item) => {
    if (!isValidToolDescriptor(item)) {
      process.stderr.write(`plugin-tools-mcp: skipping invalid tool descriptor: ${JSON.stringify(item)}\n`);
      return false;
    }
    return true;
  });
} catch (err) {
  process.stderr.write(`plugin-tools-mcp: failed to read tools file: ${err}\n`);
  process.exit(1);
}

const apiUrl = process.env.PAPERCLIP_API_URL ?? "";
const apiKey = process.env.PAPERCLIP_API_KEY ?? "";
const agentId = process.env.PAPERCLIP_AGENT_ID ?? "";
const companyId = process.env.PAPERCLIP_COMPANY_ID ?? "";
const runId = process.env.PAPERCLIP_RUN_ID ?? "";

if (!apiUrl) {
  process.stderr.write("plugin-tools-mcp: WARNING: PAPERCLIP_API_URL not set, tool calls will fail\n");
}
if (!agentId || !companyId || !runId) {
  process.stderr.write("plugin-tools-mcp: WARNING: PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, or PAPERCLIP_RUN_ID not set\n");
}

// Guard: only allow requests to localhost to prevent SSRF and credential leakage
if (apiUrl && !isLocalhostUrl(apiUrl)) {
  process.stderr.write(
    `plugin-tools-mcp: PAPERCLIP_API_URL (${apiUrl}) is not localhost — refusing to proxy tool calls to prevent credential leakage\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function sendResponse(id: string | number | null, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendError(id: string | number | null, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

// ---------------------------------------------------------------------------
// HTTP helper: POST to Paperclip API (localhost only)
// ---------------------------------------------------------------------------

function postJson(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const doRequest = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const req = doRequest(
      url,
      { method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

// ---------------------------------------------------------------------------
// MCP method handlers
// ---------------------------------------------------------------------------

async function handleInitialize(id: string | number | null): Promise<void> {
  sendResponse(id, {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "paperclip-plugin-tools",
      version: "1.0.0",
    },
  });
}

function handleToolsList(id: string | number | null): void {
  const mcpTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object" as const,
      ...t.parametersSchema,
    },
  }));
  sendResponse(id, { tools: mcpTools });
}

async function handleToolsCall(
  id: string | number | null,
  params: { name: string; arguments?: Record<string, unknown> },
): Promise<void> {
  const tool = tools.find((t) => t.name === params.name);
  if (!tool) {
    sendError(id, -32602, `Unknown tool: ${params.name}`);
    return;
  }

  if (!apiUrl) {
    sendError(id, -32603, "PAPERCLIP_API_URL not set — cannot proxy tool call");
    return;
  }

  try {
    const executeUrl = `${apiUrl}/api/plugins/tools/execute`;
    const response = await postJson(executeUrl, {
      tool: params.name,
      parameters: params.arguments ?? {},
      runContext: { agentId, runId, companyId },
    });

    if (response.status >= 400) {
      let errorMessage = `Plugin tool execution failed (HTTP ${response.status})`;
      try {
        const parsed = JSON.parse(response.body);
        if (parsed.error) errorMessage = parsed.error;
      } catch {
        // use default message
      }
      sendResponse(id, {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      });
      return;
    }

    let resultText: string;
    try {
      const parsed = JSON.parse(response.body);
      resultText = parsed.result?.content
        ? JSON.stringify(parsed.result.content)
        : JSON.stringify(parsed);
    } catch {
      resultText = response.body;
    }

    sendResponse(id, {
      content: [{ type: "text", text: resultText }],
    });
  } catch (err) {
    sendResponse(id, {
      content: [{ type: "text", text: `Tool execution error: ${err}` }],
      isError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Main: read JSON-RPC messages from stdin
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg: { jsonrpc: string; id?: string | number | null; method?: string; params?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`plugin-tools-mcp: malformed JSON-RPC message: ${line.slice(0, 200)}\n`);
    return;
  }

  const id = msg.id ?? null;
  const method = msg.method ?? "";

  switch (method) {
    case "initialize":
      void handleInitialize(id).catch((err) => sendError(id, -32603, String(err)));
      break;
    case "initialized":
      // notification — no response needed
      break;
    case "tools/list":
      handleToolsList(id);
      break;
    case "tools/call":
      void handleToolsCall(id, (msg.params ?? {}) as { name: string; arguments?: Record<string, unknown> }).catch((err) => sendError(id, -32603, String(err)));
      break;
    case "notifications/cancelled":
      // ignore cancellation notifications
      break;
    default:
      if (id !== null) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
});

rl.on("close", () => {
  process.exit(0);
});
