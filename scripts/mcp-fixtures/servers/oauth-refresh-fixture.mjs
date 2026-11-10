#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** A loopback-only MCP + OAuth provider; no vendor account or fetch mock needed. */
export async function startOAuthRefreshFixture({
  port = 0,
  supportsOfflineAccess = true,
  grantTypes = ["authorization_code", "refresh_token"],
  challengeScope = true,
  resourceScopes = ["mcp:read"],
  accessTokenLifetimeSeconds = 3600,
} = {}) {
  const clients = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  // Diagnostics deliberately contain no credentials, codes, or PKCE verifiers.
  const events = [];
  let clockOffset = 0;
  let origin;
  const now = () => Date.now() + clockOffset;
  const issuer = () => `${origin}/identity/acme`;
  const resource = () => `${origin}/mcp`;
  const supportedScopes = () => ["mcp:read", "admin:all", ...(supportsOfflineAccess ? ["offline_access"] : [])];
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const fail = (res, error) => json(res, 400, { error });

  function issueTokens(grant) {
    const accessToken = `fixture-access-${randomUUID()}`;
    accessTokens.set(accessToken, { ...grant, expiresAt: now() + accessTokenLifetimeSeconds * 1000 });
    const refreshToken = grant.offline ? `fixture-refresh-${randomUUID()}` : null;
    if (refreshToken) refreshTokens.set(refreshToken, grant);
    return {
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      expires_in: accessTokenLifetimeSeconds,
      token_type: "Bearer",
      scope: grant.scopes.join(" "),
    };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const form = new URLSearchParams(rawBody);
      const path = url.pathname;

      if (path === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, { resource: resource(), authorization_servers: [issuer()], scopes_supported: resourceScopes });
      } else if (path === "/.well-known/oauth-authorization-server/identity/acme") {
        json(res, 200, {
          issuer: issuer(),
          authorization_endpoint: `${issuer()}/authorize`,
          token_endpoint: `${issuer()}/token`,
          registration_endpoint: `${issuer()}/register`,
          scopes_supported: supportedScopes(),
          grant_types_supported: grantTypes,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      } else if (path === "/identity/acme/register" && req.method === "POST") {
        const metadata = JSON.parse(rawBody);
        if (!Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.some((uri) => {
          const parsed = new URL(uri);
          return parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
        })) return fail(res, "invalid_redirect_uri");
        const requestedGrantTypes = metadata.grant_types ?? ["authorization_code"];
        if (!Array.isArray(requestedGrantTypes) || requestedGrantTypes.some((type) => !grantTypes.includes(type))) return fail(res, "invalid_client_metadata");
        metadata.grant_types = requestedGrantTypes;
        const clientId = `fixture-client-${randomUUID()}`;
        clients.set(clientId, metadata);
        events.push({ kind: "registration", grantTypes: metadata.grant_types });
        json(res, 201, { ...metadata, client_id: clientId });
      } else if (path === "/identity/acme/authorize") {
        const params = req.method === "POST" ? form : url.searchParams;
        const clientId = params.get("client_id");
        const client = clients.get(clientId);
        const redirectUri = params.get("redirect_uri");
        const scopes = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);
        if (!client || !client.redirect_uris.includes(redirectUri)) return fail(res, "invalid_client");
        if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256") return fail(res, "invalid_request");
        if (params.get("resource") !== resource()) return fail(res, "invalid_target");
        if (scopes.some((scope) => !supportedScopes().includes(scope))) return fail(res, "invalid_scope");
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
          res.end(`<!doctype html><html><title>Test MCP consent</title><h1>Connect the test MCP server</h1><p>Requested scopes: ${escape(scopes.join(" "))}</p><form method="post">${[...params].map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join("")}<button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form></html>`);
          return;
        }
        const callback = new URL(redirectUri);
        callback.searchParams.set("state", params.get("state") ?? "");
        callback.searchParams.set("iss", issuer());
        if (params.get("decision") !== "allow") callback.searchParams.set("error", "access_denied");
        else {
          const offline = grantTypes.includes("refresh_token") && scopes.includes("offline_access") && params.get("prompt")?.split(/\s+/).includes("consent") && client.grant_types.includes("refresh_token");
          const code = `fixture-code-${randomUUID()}`;
          codes.set(code, {
            clientId, redirectUri, resource: resource(), codeChallenge: params.get("code_challenge"),
            scopes: offline ? scopes : scopes.filter((scope) => scope !== "offline_access"), offline,
          });
          events.push({ kind: "authorization", scopes, prompt: params.get("prompt"), offline: Boolean(offline) });
          callback.searchParams.set("code", code);
        }
        res.writeHead(302, { Location: callback.toString() });
        res.end();
      } else if (path === "/identity/acme/token" && req.method === "POST") {
        const grantType = form.get("grant_type");
        if (!grantTypes.includes(grantType)) return fail(res, "unsupported_grant_type");
        let grant;
        if (grantType === "authorization_code") {
          const code = form.get("code");
          grant = codes.get(code);
          const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
          if (!grant || grant.clientId !== form.get("client_id") || grant.redirectUri !== form.get("redirect_uri") || grant.resource !== form.get("resource") || grant.codeChallenge !== challenge) return fail(res, "invalid_grant");
          codes.delete(code);
        } else if (grantType === "refresh_token") {
          const refreshToken = form.get("refresh_token");
          grant = refreshTokens.get(refreshToken);
          if (!grant || grant.clientId !== form.get("client_id") || grant.resource !== form.get("resource")) return fail(res, "invalid_grant");
          refreshTokens.delete(refreshToken); // Rotation: reuse must fail.
        } else return fail(res, "unsupported_grant_type");
        events.push({ kind: "token", grantType, resource: grant.resource, offline: Boolean(grant.offline) });
        json(res, 200, issueTokens(grant));
      } else if (path === "/mcp") {
        const token = accessTokens.get(req.headers.authorization?.replace(/^Bearer /, ""));
        if (!token || token.expiresAt <= now()) {
          events.push({ kind: "mcp_unauthorized" });
          res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${challengeScope ? ', scope="mcp:read"' : ""}` });
          res.end();
          return;
        }
        if (!token.scopes.includes("mcp:read")) { json(res, 403, { error: "insufficient_scope" }); return; }
        if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
        const rpc = JSON.parse(rawBody);
        events.push({ kind: "mcp", method: rpc.method });
        if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
        let result;
        if (rpc.method === "initialize") result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "offline-access-fixture", version: "1.0.0" } };
        else if (rpc.method === "tools/list") result = { tools: [{ name: "read_status", description: "Read the test server status", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] };
        else if (rpc.method === "tools/call" && rpc.params.name === "read_status") result = { content: [{ type: "text", text: "Authenticated MCP call succeeded" }] };
        else { json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }); return; }
        json(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
      } else { json(res, 404, { error: "not_found" }); }
    } catch {
      json(res, 400, { error: "invalid_request" });
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, mcpUrl: resource(), issuer: issuer(), events,
    /** Advance only provider time; callers can separately expire their cached token. */
    advanceTime(ms) { clockOffset += ms; },
    async close() {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startOAuthRefreshFixture({ port: Number(process.env.PORT ?? 0), accessTokenLifetimeSeconds: 120 });
  console.log(JSON.stringify({ event: "ready", mcpUrl: fixture.mcpUrl, accessTokenLifetimeSeconds: 120 }));
  const stop = async () => { await fixture.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
