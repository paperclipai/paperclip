import express, { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { publicMcpEventDefinitions, type PublicMcpEvents } from "../services/public-mcp/events.js";
import { McpEventError } from "../services/public-mcp/event-webhooks.js";
import { PUBLIC_MCP_PATH, PUBLIC_MCP_SCOPES, mcpConsentSchema } from "@paperclipai/shared";
import { McpOAuthError, type PublicMcpOAuth } from "../services/public-mcp/oauth.js";
import { McpApiError, McpCapabilityError, publicMcpCapabilities, type createPublicMcpExecutor } from "../services/public-mcp/capabilities.js";

const oauthErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  const known = error instanceof McpOAuthError;
  res.status(known ? error.status : 500).json({
    error: known ? error.code : "server_error",
    error_description: known ? error.message : "Paperclip could not complete the connection request.",
  });
};

/** Bounded in-process abuse guard; public deployments must also rate limit at their edge. */
function authRateLimit(): RequestHandler {
  const windows = new Map<string, { count: number; until: number }>();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of windows) if (value.until <= now) windows.delete(key);
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let entry = windows.get(key);
    if (!entry) {
      if (windows.size >= 10000) { res.status(429).json({ error: "temporarily_unavailable" }); return; }
      entry = { count: 0, until: now + 60_000 }; windows.set(key, entry);
    }
    if (++entry.count > 60) { res.setHeader("Retry-After", "60"); res.status(429).json({ error: "temporarily_unavailable" }); return; }
    next();
  };
}

export function publicMcpIngressRoutes(oauth: PublicMcpOAuth, execute: ReturnType<typeof createPublicMcpExecutor>, events?: PublicMcpEvents) {
  const router = Router();
  const { origin, resource } = oauth.config;
  const prefix = origin + "/mcp/oauth";
  const resourceMetadata = origin + "/.well-known/oauth-protected-resource" + PUBLIC_MCP_PATH;
  router.use(["/mcp/oauth", PUBLIC_MCP_PATH], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  router.use(["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", PUBLIC_MCP_PATH, "/mcp/oauth/register", "/mcp/oauth/authorize", "/mcp/oauth/token"], async (_req, _res, next) => {
    await oauth.assertEnabled();
    next();
  });
  router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource" + PUBLIC_MCP_PATH], (_req, res) => res.json({
    resource, authorization_servers: [origin], scopes_supported: PUBLIC_MCP_SCOPES, bearer_methods_supported: ["header"],
    resource_name: "Paperclip team",
  }));
  router.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({
    issuer: origin, authorization_endpoint: prefix + "/authorize", token_endpoint: prefix + "/token",
    registration_endpoint: prefix + "/register", revocation_endpoint: prefix + "/revoke",
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"], scopes_supported: PUBLIC_MCP_SCOPES,
  }));
  router.use("/mcp/oauth", authRateLimit(), express.urlencoded({ extended: false, limit: "16kb" }));
  router.post("/mcp/oauth/register", async (req, res) => res.status(201).json(await oauth.register(req.body, req.ip ?? req.socket.remoteAddress ?? "unknown")));
  router.get("/mcp/oauth/authorize", async (req, res) => res.redirect(303, await oauth.authorize(req.query)));
  router.post("/mcp/oauth/token", async (req, res) => res.json(await oauth.token(req.body ?? {})));
  router.post("/mcp/oauth/revoke", async (req, res) => {
    if (typeof req.body?.token !== "string" || typeof req.body?.client_id !== "string") throw new McpOAuthError("invalid_request", "A token and client_id are required.");
    await oauth.revokeToken(req.body.token, req.body.client_id); res.status(200).end();
  });
  router.all(PUBLIC_MCP_PATH, async (req, res) => {
    if (req.headers.origin && req.headers.origin !== origin) { res.status(403).json({ error: "Invalid origin" }); return; }
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    let principal;
    try { if (!token) throw new Error(); principal = await oauth.authenticate(token); }
    catch {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadata}", error="invalid_token"`);
      res.status(401).json({ error: "invalid_token" }); return;
    }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); res.status(405).end(); return; }
    const listTools = async () => ({
      tools: publicMcpCapabilities.map((c) => ({
        name: c.name, description: c.description, inputSchema: z.toJSONSchema(c.schema) as { type: "object"; properties: Record<string, unknown> },
        annotations: { readOnlyHint: !c.write, destructiveHint: false, idempotentHint: true, openWorldHint: !!c.write },
      })),
    });
    const callTool = async (request: z.infer<typeof CallToolRequestSchema>) => {
      try {
        const result = await execute(token!, request.params.name, request.params.arguments ?? {});
        return { isError: result.outcome === "unknown" || result.outcome === "rejected", content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const message = error instanceof z.ZodError ? "Invalid tool arguments."
          : error instanceof McpApiError || error instanceof McpCapabilityError || error instanceof McpOAuthError ? error.message
          : "Paperclip could not confirm this operation. Before retrying a write, inspect the task and comments and keep the same requestId.";
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    };
    const modern = req.headers["mcp-protocol-version"] === "2026-07-28"
      || req.body?.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28"
      || req.body?.method === "server/discover" || String(req.body?.method).startsWith("events/");
    if (modern) {
      const envelope = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]), method: z.string(), params: z.record(z.string(), z.unknown()) }).safeParse(req.body);
      const fail = (code: number, message: string, data?: unknown) => res.status(code === -32601 ? 404 : code === -32603 ? 500 : 400)
        .json({ jsonrpc: "2.0", id: envelope.success ? envelope.data.id : null, error: { code, message, ...(data ? { data } : {}) } });
      if (!envelope.success) { fail(-32600, "Invalid MCP request."); return; }
      const { method, params } = envelope.data;
      const meta = params._meta as Record<string, unknown> | undefined;
      if (!meta || typeof meta["io.modelcontextprotocol/protocolVersion"] !== "string"
        || !meta["io.modelcontextprotocol/clientCapabilities"] || typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object"
        || Array.isArray(meta["io.modelcontextprotocol/clientCapabilities"])) { fail(-32602, "Required per-request MCP metadata is missing."); return; }
      const decodeHeader = (value: unknown) => typeof value === "string" && /^=\?base64\?.*\?=$/.test(value)
        ? Buffer.from(value.slice(9, -2), "base64").toString("utf8") : value;
      if (req.headers["mcp-protocol-version"] !== meta["io.modelcontextprotocol/protocolVersion"] || req.headers["mcp-method"] !== method
        || (method === "tools/call" && decodeHeader(req.headers["mcp-name"]) !== params.name)) { fail(-32020, "MCP headers must match the request body."); return; }
      if (meta["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28") { fail(-32022, "Unsupported protocol version.", { supportedVersions: ["2026-07-28"] }); return; }
      if (!req.is("application/json")) { fail(-32600, "Use application/json."); return; }
      try {
        let result: Record<string, unknown>;
        switch (method) {
          case "server/discover": result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, ...(events ? { events: {} } : {}) } }; break;
          case "tools/list": result = await listTools(); break;
          case "tools/call": result = await callTool(CallToolRequestSchema.parse(envelope.data)); break;
          case "events/list":
            if (!events) { fail(-32601, "Events are unavailable."); return; }
            if (params.cursor != null) { fail(-32602, "Invalid event catalog cursor."); return; }
            result = { events: publicMcpEventDefinitions }; break;
          case "events/subscribe": {
            if (!events) { fail(-32601, "Events are unavailable."); return; }
            // The broker supplies its original access proof only for hosted subscriptions.
            // It is validated against the fixed Cloud origin before being retained encrypted.
            const authority = z.object({ token: z.string().max(24000), expiresAt: z.number() }).safeParse(meta["ai.paperclip/cloudAuthority"]);
            result = await events.subscribe(principal!, params, authority.success ? authority.data : undefined); break;
          }
          case "events/unsubscribe":
            if (!events) { fail(-32601, "Events are unavailable."); return; }
            result = await events.unsubscribe(principal!, params); break;
          default: fail(-32601, "Method not found."); return;
        }
        res.json({ jsonrpc: "2.0", id: envelope.data.id, result: { ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": { name: "paperclip", version: "0.1.0" } } } });
      } catch (error) {
        if (error instanceof McpEventError) fail(error.code, error.message, error.reason ? { reason: error.reason } : undefined);
        else if (error instanceof z.ZodError || error instanceof McpApiError || error instanceof McpOAuthError) fail(-32602, "Invalid arguments or unavailable authority.");
        else fail(-32603, "Paperclip could not complete the request.");
      }
      return;
    }
    const server = new Server({ name: "paperclip", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, listTools);
    server.setRequestHandler(CallToolRequestSchema, callTool);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  router.use(oauthErrors);
  return router;
}

export function publicMcpManagementRoutes(oauth: PublicMcpOAuth) {
  const router = Router();
  const realUser: RequestHandler = (req, _res, next) => {
    if (req.actor.type !== "board" || !req.actor.userId || !["session", "cloud_tenant"].includes(req.actor.source ?? "")) {
      throw new McpOAuthError("access_denied", "Sign in to manage assistant connections.", 401);
    }
    next();
  };
  const sameOrigin: RequestHandler = (req, _res, next) => {
    const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : "");
    if (origin !== oauth.config.origin) throw new McpOAuthError("access_denied", "Connection changes require the Paperclip browser origin.", 403);
    next();
  };
  router.use("/mcp", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/mcp/requests/:id", async (req, res) => {
    let setupUrl: string | null = null;
    if (process.env.PAPERCLIP_CLOUD_API_ORIGIN) {
      const base = new URL(process.env.PAPERCLIP_CLOUD_API_ORIGIN);
      if (base.protocol === "https:") setupUrl = new URL("/orgs/new", base).toString();
    }
    res.json(await oauth.describeRequest(String(req.params.id), req.actor, setupUrl));
  });
  router.post("/mcp/requests/:id/consent", realUser, sameOrigin, async (req, res) => {
    const parsed = mcpConsentSchema.safeParse(req.body);
    if (!parsed.success) throw new McpOAuthError("invalid_request", "Choose a company and the requested access.");
    res.json(await oauth.consent(String(req.params.id), req.actor, parsed.data));
  });
  router.get("/mcp/connections", realUser, async (req, res) => res.json(await oauth.listConnections(req.actor.userId!)));
  router.delete("/mcp/connections/:id", realUser, sameOrigin, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) throw new McpOAuthError("invalid_request", "Invalid connection ID.");
    await oauth.revokeConnection(String(req.params.id), req.actor.userId!); res.status(204).end();
  });
  router.use("/mcp", oauthErrors);
  return router;
}
