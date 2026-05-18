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
 * Includes OAuth 2.0 client_credentials flow so claude.ai can exchange
 * an API key (passed as client_secret) for a Bearer token.
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

/**
 * OAuth 2.0 token endpoint and discovery metadata for claude.ai MCP connectors.
 *
 * claude.ai authenticates MCP connectors via OAuth client_credentials flow:
 *   1. Discovers auth server via /.well-known/oauth-authorization-server
 *   2. POSTs to /oauth/token with client_id + client_secret
 *   3. Gets back an access_token it uses as Bearer token on /api/mcp
 *
 * The client_secret IS the Paperclip board API key. The token endpoint
 * simply passes it through as the access_token, so the existing Bearer
 * auth middleware works unchanged.
 */
export function mcpOAuthRoutes(opts: { publicUrl: string }) {
  const router = Router();
  const issuer = opts.publicUrl.replace(/\/+$/, "");

  // RFC 8414 — OAuth Authorization Server Metadata
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer,
      token_endpoint: `${issuer}/oauth/token`,
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      grant_types_supported: ["client_credentials"],
      response_types_supported: ["token"],
      service_documentation: `${issuer}/api/health`,
    });
  });

  // RFC 9728 — OAuth Protected Resource Metadata (points MCP clients to our auth server)
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${issuer}/api/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    });
  });

  // OAuth 2.0 Token Endpoint — client_credentials grant
  router.post("/oauth/token", (req, res) => {
    const grantType = req.body?.grant_type;
    if (grantType !== "client_credentials") {
      res.status(400).json({
        error: "unsupported_grant_type",
        error_description: "Only client_credentials grant is supported",
      });
      return;
    }

    // Accept credentials from body (client_secret_post)
    const clientSecret =
      req.body?.client_secret as string | undefined;

    if (!clientSecret?.trim()) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "client_secret is required",
      });
      return;
    }

    // The API key IS the access token — pass it through so the existing
    // Bearer auth middleware on /api/mcp can validate it as normal.
    res.json({
      access_token: clientSecret.trim(),
      token_type: "Bearer",
      // Board API keys last 30 days; report a conservative TTL
      expires_in: 86400,
    });
  });

  return router;
}
