#!/usr/bin/env node
/**
 * Paperclip Plugin Tools MCP Bridge.
 *
 * A short-lived stdio MCP server that:
 *   - announces every plugin tool registered with the host's
 *     `plugin-tool-registry` for the current run, and
 *   - forwards `tools/call` requests to the host's
 *     `POST /api/plugins/tools/execute` endpoint.
 *
 * It is spawned by a CLI child process (claude, gemini, codex, opencode)
 * via that CLI's normal MCP config block. The spec/config is produced by
 * `buildPluginToolsMcpServer` in the sibling module `plugin-tools-mcp.ts`.
 *
 * Logging goes to stderr only; stdout is reserved for MCP frames.
 *
 * @see KSI-664 — design decision B.1.a
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface BridgeArgs {
  apiUrl: string;
  apiKeyEnvVar: string;
  companyId: string;
  agentId: string;
  runId: string;
  projectId: string;
}

interface ToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  pluginId: string;
}

interface ToolExecutionResult {
  pluginId: string;
  toolName: string;
  result: {
    content?: Array<{ type: string; [key: string]: unknown }>;
    data?: unknown;
    error?: { message?: string; [key: string]: unknown };
    is_error?: boolean;
  };
}

function log(message: string, ...rest: unknown[]): void {
  // Bridge logs go to stderr; stdout is the MCP transport.
  // eslint-disable-next-line no-console
  console.error("[paperclip-mcp-bridge]", message, ...rest);
}

function parseArgs(argv: readonly string[]): BridgeArgs {
  const opts: Partial<BridgeArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--api-url":
        opts.apiUrl = value;
        i += 1;
        break;
      case "--api-key-env":
        opts.apiKeyEnvVar = value;
        i += 1;
        break;
      case "--company-id":
        opts.companyId = value;
        i += 1;
        break;
      case "--agent-id":
        opts.agentId = value;
        i += 1;
        break;
      case "--run-id":
        opts.runId = value;
        i += 1;
        break;
      case "--project-id":
        opts.projectId = value;
        i += 1;
        break;
      default:
        if (flag.startsWith("--")) {
          log(`unknown flag ignored: ${flag}`);
          i += 1;
        }
        break;
    }
  }
  const required: (keyof BridgeArgs)[] = [
    "apiUrl",
    "apiKeyEnvVar",
    "companyId",
    "agentId",
    "runId",
    "projectId",
  ];
  for (const k of required) {
    if (!opts[k] || String(opts[k]).length === 0) {
      throw new Error(`paperclip-mcp-bridge: missing required flag for ${k}`);
    }
  }
  return opts as BridgeArgs;
}

function buildAuthHeader(apiKeyEnvVar: string): string {
  const token = process.env[apiKeyEnvVar];
  if (!token || token.length === 0) {
    throw new Error(
      `paperclip-mcp-bridge: env var ${apiKeyEnvVar} is empty; the bridge cannot authenticate.`,
    );
  }
  return `Bearer ${token}`;
}

async function listTools(args: BridgeArgs): Promise<ToolDescriptor[]> {
  const url = new URL("/api/plugins/tools", args.apiUrl);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: buildAuthHeader(args.apiKeyEnvVar),
      "X-Paperclip-Run-Id": args.runId,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /api/plugins/tools failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as ToolDescriptor[];
  if (!Array.isArray(json)) {
    throw new Error("GET /api/plugins/tools did not return an array");
  }
  return json;
}

async function executeTool(
  args: BridgeArgs,
  toolName: string,
  parameters: unknown,
): Promise<ToolExecutionResult> {
  const url = new URL("/api/plugins/tools/execute", args.apiUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: buildAuthHeader(args.apiKeyEnvVar),
      "X-Paperclip-Run-Id": args.runId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool: toolName,
      parameters: parameters ?? {},
      runContext: {
        companyId: args.companyId,
        agentId: args.agentId,
        runId: args.runId,
        projectId: args.projectId,
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `POST /api/plugins/tools/execute failed (${res.status}) for "${toolName}": ${text.slice(0, 500)}`,
    );
  }
  let parsed: ToolExecutionResult;
  try {
    parsed = JSON.parse(text) as ToolExecutionResult;
  } catch (err) {
    throw new Error(
      `POST /api/plugins/tools/execute returned non-JSON for "${toolName}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return parsed;
}

function toMcpToolListEntry(tool: ToolDescriptor): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: tool.name,
    description: tool.description ?? tool.displayName ?? tool.name,
    inputSchema:
      tool.parametersSchema && typeof tool.parametersSchema === "object"
        ? tool.parametersSchema
        : { type: "object" },
  };
}

function toMcpCallResponse(result: ToolExecutionResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const r = result.result ?? {};
  if (Array.isArray(r.content) && r.content.length > 0) {
    const normalized = r.content
      .filter((c): c is { type: string; [k: string]: unknown } => Boolean(c))
      .map((c) => {
        const maybeText = (c as { text?: unknown }).text;
        if (c.type === "text" && typeof maybeText === "string") {
          return { type: "text" as const, text: maybeText };
        }
        return { type: "text" as const, text: JSON.stringify(c) };
      });
    return {
      content: normalized,
      ...(r.is_error || r.error ? { isError: true } : {}),
    };
  }
  if (r.error) {
    const message =
      typeof r.error.message === "string" ? r.error.message : JSON.stringify(r.error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
  if (r.data !== undefined) {
    return {
      content: [
        {
          type: "text",
          text: typeof r.data === "string" ? r.data : JSON.stringify(r.data),
        },
      ],
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log("starting", {
    apiUrl: args.apiUrl,
    companyId: args.companyId,
    agentId: args.agentId,
    runId: args.runId,
  });

  const server = new Server(
    { name: "paperclip-plugin-tools", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const tools = await listTools(args);
      return { tools: tools.map(toMcpToolListEntry) };
    } catch (err) {
      log("listTools failed:", err instanceof Error ? err.message : String(err));
      return { tools: [] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: parameters } = request.params;
    try {
      const result = await executeTool(args, name, parameters);
      return toMcpCallResponse(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`callTool failed for ${name}:`, message);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("connected; awaiting requests");

  const shutdown = (signal: NodeJS.Signals) => {
    log(`received ${signal}, shutting down`);
    server
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
