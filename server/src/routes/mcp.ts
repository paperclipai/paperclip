import { Router, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PaperclipApiClient, createToolDefinitions } from "@paperclipai/mcp-server";
import type { PaperclipMcpConfig } from "@paperclipai/mcp-server";
import { logger } from "../middleware/logger.js";

/**
 * Creates an Express router that serves the Paperclip MCP tools over
 * Streamable HTTP — the transport claude.ai (and other remote MCP clients)
 * uses when stdio is not available.
 *
 * Each incoming request carries its own Bearer API key. A stateless MCP
 * server instance is spun up per request, configured to call back into the
 * local Paperclip API with that key. This keeps auth consistent with the
 * rest of the API surface.
 */
export function mcpRoutes(opts: { serverPort: number }) {
  const router = Router();

  function buildConfig(apiKey: string): PaperclipMcpConfig {
    return {
      apiUrl: `http://127.0.0.1:${opts.serverPort}/api`,
      apiKey,
      companyId: null,
      agentId: null,
      runId: null,
    };
  }

  function buildMcpServer(apiKey: string): McpServer {
    const config = buildConfig(apiKey);
    const server = new McpServer({
      name: "paperclip",
      version: "0.1.0",
    });
    const client = new PaperclipApiClient(config);
    const tools = createToolDefinitions(client);
    for (const tool of tools) {
      server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
    }
    return server;
  }

  async function handleMcp(req: Request, res: Response) {
    const authHeader = req.headers.authorization;
    const apiKey =
      authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

    if (!apiKey) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    try {
      const server = buildMcpServer(apiKey);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "MCP request failed");
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal MCP error" });
      }
    }
  }

  // Streamable HTTP uses POST for messages, GET for SSE stream, DELETE for session end.
  // In stateless mode only POST is meaningful, but we route all three so the
  // transport can return proper error codes for the others.
  router.post("/", handleMcp);
  router.get("/", handleMcp);
  router.delete("/", handleMcp);

  return router;
}
