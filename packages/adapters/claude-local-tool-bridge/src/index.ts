#!/usr/bin/env node
/**
 * MCP stdio server that surfaces Paperclip plugin tools to a Claude Code
 * session. Spawned per agent run by the `claude-local` adapter. Reads
 * scope + auth from env, exposes `tools/list` and `tools/call`, proxies
 * each call to Paperclip's `/api/plugins/tools/*` endpoints.
 *
 * Required env:
 *   PAPERCLIP_API_BASE     e.g. http://localhost:3100
 *   PAPERCLIP_AGENT_TOKEN  agent-scoped JWT (createLocalAgentJwt)
 *   PAPERCLIP_AGENT_ID     UUID
 *   PAPERCLIP_RUN_ID       UUID
 *   PAPERCLIP_COMPANY_ID   UUID
 *
 * Optional:
 *   PAPERCLIP_PROJECT_ID   UUID, omitted for project-less runs
 *   PAPERCLIP_TIMEOUT_MS   per-call HTTP timeout, default 30000
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createPaperclipClient } from "./paperclip-client.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`[paperclip-tool-bridge] missing required env: ${name}\n`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const apiBase = required("PAPERCLIP_API_BASE");
  const token = required("PAPERCLIP_AGENT_TOKEN");
  const runContext = {
    agentId: required("PAPERCLIP_AGENT_ID"),
    runId: required("PAPERCLIP_RUN_ID"),
    companyId: required("PAPERCLIP_COMPANY_ID"),
    projectId: process.env.PAPERCLIP_PROJECT_ID || null,
  };
  const timeoutMs = process.env.PAPERCLIP_TIMEOUT_MS
    ? Number.parseInt(process.env.PAPERCLIP_TIMEOUT_MS, 10)
    : undefined;

  const client = createPaperclipClient({ apiBase, token, runContext, timeoutMs });

  const server = new Server(
    { name: "paperclip-plugin-tools", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await client.listTools();
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parametersSchema as Record<string, unknown>,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const result = await client.executeTool(name, args ?? {});

    // Two error shapes: HTTP-level error wraps the body in `result.error`
    // with the route's message; per-tool error comes back nested in
    // `result.result.error`. Surface both as MCP `isError`.
    const inner = result.result;
    if (result.error || inner?.error) {
      const message = result.error ?? inner?.error ?? "tool execution failed";
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }

    const text =
      inner?.content ??
      (inner?.data !== undefined ? JSON.stringify(inner.data) : "");
    return { content: [{ type: "text", text }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[paperclip-tool-bridge] fatal: ${err}\n`);
  process.exit(1);
});
