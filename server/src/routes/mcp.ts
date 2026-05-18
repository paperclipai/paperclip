import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PaperclipApiClient, createToolDefinitions } from "@paperclipai/mcp-server";
import type { PaperclipMcpConfig } from "@paperclipai/mcp-server";
import type { Db } from "@paperclipai/db";
import { boardApiKeys } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { boardApiKeyExpiresAt, createBoardApiToken, hashBearerToken } from "../services/board-auth.js";

// ─── MCP Streamable HTTP route ──────────────────────────────────────────────

export function mcpRoutes(opts: { serverPort: number }) {
  const router = Router();

  function buildMcpServer(apiKey: string): McpServer {
    const config: PaperclipMcpConfig = {
      apiUrl: `http://127.0.0.1:${opts.serverPort}/api`,
      apiKey,
      companyId: null,
      agentId: null,
      runId: null,
    };
    const server = new McpServer({ name: "paperclip", version: "0.1.0" });
    const client = new PaperclipApiClient(config);
    for (const tool of createToolDefinitions(client)) {
      server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
    }
    return server;
  }

  async function handleMcp(req: Request, res: Response) {
    const authHeader = req.headers.authorization;
    const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (!apiKey) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    try {
      const server = buildMcpServer(apiKey);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "MCP request failed");
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal MCP error" });
      }
    }
  }

  router.post("/", handleMcp);
  router.get("/", handleMcp);
  router.delete("/", handleMcp);
  return router;
}

// ─── OAuth 2.0 Authorization Code + PKCE (for claude.ai connectors) ─────────

interface PendingAuthCode {
  userId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  expiresAt: number;
}

/** In-memory store for pending auth codes. Short-lived (10 min), one-time use. */
const pendingCodes = new Map<string, PendingAuthCode>();

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const CODE_CLEANUP_INTERVAL_MS = 60 * 1000;

// Periodic cleanup of expired codes
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pendingCodes) {
    if (entry.expiresAt <= now) pendingCodes.delete(code);
  }
}, CODE_CLEANUP_INTERVAL_MS).unref();

function generateAuthCode(): string {
  return randomBytes(32).toString("hex");
}

function verifyPkce(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method !== "S256") return false;
  const hash = createHash("sha256").update(codeVerifier).digest("base64url");
  return hash === codeChallenge;
}

export interface McpOAuthDeps {
  publicUrl: string;
  db: Db;
  resolveSession: (req: Request) => Promise<{ userId: string; userName?: string } | null>;
}

export function mcpOAuthRoutes(opts: McpOAuthDeps) {
  const router = Router();
  const issuer = opts.publicUrl.replace(/\/+$/, "");

  // ── Discovery endpoints ──

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      grant_types_supported: ["authorization_code"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      service_documentation: `${issuer}/api/health`,
    });
  });

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${issuer}/api/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    });
  });

  // ── Dynamic Client Registration (RFC 7591) ──
  // claude.ai may auto-register before starting the auth flow.
  // We accept any registration and echo back a client_id.

  router.post("/oauth/register", (req, res) => {
    const clientName = req.body?.client_name ?? "mcp-client";
    const redirectUris = req.body?.redirect_uris ?? [];
    const clientId = `mcp_${randomBytes(16).toString("hex")}`;
    res.status(201).json({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // ── Authorization endpoint ──

  router.get("/authorize", async (req, res) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
    } = req.query as Record<string, string | undefined>;

    if (response_type !== "code" || !redirect_uri || !code_challenge) {
      res.status(400).send("Invalid authorization request");
      return;
    }

    // Check if user is logged in via session cookie
    const session = await opts.resolveSession(req);
    if (!session) {
      // Not logged in — redirect to Paperclip login, then back here
      const returnUrl = `${issuer}${req.originalUrl}`;
      res.redirect(`${issuer}/login?returnTo=${encodeURIComponent(returnUrl)}`);
      return;
    }

    // Render a minimal consent page
    const userName = session.userName ?? session.userId;
    res.setHeader("Content-Type", "text/html");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Paperclip</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; background: #f5f5f5; color: #1a1a1a; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
            padding: 2.5rem; max-width: 420px; width: 100%; }
    h1 { font-size: 1.25rem; margin-bottom: .5rem; }
    p { color: #555; font-size: .9rem; margin-bottom: 1.5rem; line-height: 1.5; }
    .user { font-weight: 600; color: #1a1a1a; }
    .actions { display: flex; gap: .75rem; }
    button { flex: 1; padding: .75rem 1rem; border-radius: 8px; font-size: .9rem;
             cursor: pointer; border: 1px solid #ddd; background: #fff; }
    button[type="submit"] { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
    button[type="submit"]:hover { background: #333; }
    .deny { color: #666; }
    .deny:hover { background: #f0f0f0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Claude</h1>
    <p>
      Allow <strong>${escapeHtml(String(client_id ?? "Claude"))}</strong> to access
      your Paperclip account as <span class="user">${escapeHtml(userName)}</span>?
    </p>
    <p>This will grant read and write access to your issues, agents, projects, and approvals.</p>
    <form method="POST" action="${issuer}/authorize">
      <input type="hidden" name="response_type" value="${escapeAttr(response_type ?? "")}" />
      <input type="hidden" name="client_id" value="${escapeAttr(client_id ?? "")}" />
      <input type="hidden" name="redirect_uri" value="${escapeAttr(redirect_uri ?? "")}" />
      <input type="hidden" name="code_challenge" value="${escapeAttr(code_challenge ?? "")}" />
      <input type="hidden" name="code_challenge_method" value="${escapeAttr(code_challenge_method ?? "")}" />
      <input type="hidden" name="state" value="${escapeAttr(state ?? "")}" />
      <div class="actions">
        <a href="${escapeAttr(redirect_uri)}?error=access_denied&state=${encodeURIComponent(state ?? "")}">
          <button type="button" class="deny">Deny</button>
        </a>
        <button type="submit">Authorize</button>
      </div>
    </form>
  </div>
</body>
</html>`);
  });

  // Handle consent form submission
  router.post("/authorize", async (req, res) => {
    const {
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
    } = req.body as Record<string, string | undefined>;

    if (!redirect_uri || !code_challenge) {
      res.status(400).send("Invalid authorization request");
      return;
    }

    const session = await opts.resolveSession(req);
    if (!session) {
      res.status(401).send("Session expired — please try again");
      return;
    }

    // Generate auth code and store it
    const code = generateAuthCode();
    pendingCodes.set(code, {
      userId: session.userId,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method ?? "S256",
      redirectUri: redirect_uri,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    // Redirect back to claude.ai with the code
    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  // ── Token endpoint ──

  router.post("/oauth/token", async (req, res) => {
    const grantType = req.body?.grant_type;

    if (grantType === "authorization_code") {
      const code = req.body?.code as string | undefined;
      const codeVerifier = req.body?.code_verifier as string | undefined;
      const redirectUri = req.body?.redirect_uri as string | undefined;

      if (!code || !codeVerifier) {
        res.status(400).json({ error: "invalid_request", error_description: "code and code_verifier are required" });
        return;
      }

      const pending = pendingCodes.get(code);
      if (!pending || pending.expiresAt <= Date.now()) {
        pendingCodes.delete(code!);
        res.status(400).json({ error: "invalid_grant", error_description: "Authorization code is invalid or expired" });
        return;
      }

      // One-time use
      pendingCodes.delete(code);

      // Validate redirect_uri matches
      if (redirectUri && redirectUri !== pending.redirectUri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }

      // Validate PKCE
      if (!verifyPkce(codeVerifier, pending.codeChallenge, pending.codeChallengeMethod)) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }

      // Create a board API key for the user
      try {
        const token = createBoardApiToken();
        const keyHash = hashBearerToken(token);
        await opts.db.insert(boardApiKeys).values({
          userId: pending.userId,
          name: "claude-ai-connector",
          keyHash,
          expiresAt: boardApiKeyExpiresAt(),
        });

        res.json({
          access_token: token,
          token_type: "Bearer",
          expires_in: 30 * 24 * 60 * 60, // 30 days (board key TTL)
        });
      } catch (err) {
        logger.error({ err }, "Failed to create board API key during OAuth exchange");
        res.status(500).json({ error: "server_error", error_description: "Failed to create access token" });
      }
      return;
    }

    // Fallback: client_credentials (for non-browser MCP clients)
    if (grantType === "client_credentials") {
      const clientSecret = req.body?.client_secret as string | undefined;
      if (!clientSecret?.trim()) {
        res.status(400).json({ error: "invalid_request", error_description: "client_secret is required" });
        return;
      }
      res.json({
        access_token: clientSecret.trim(),
        token_type: "Bearer",
        expires_in: 86400,
      });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  return router;
}

// ── HTML helpers ──

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
