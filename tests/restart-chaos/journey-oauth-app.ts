/**
 * Q3: a harness-owned OAuth 2.1 + MCP app on loopback, so no real third-party
 * account is involved. It supports discovery, dynamic client registration, PKCE
 * authorization codes and rotating refresh tokens, and serves one write tool,
 * `create_page`. It records every token exchange and tool call for the oracle.
 *
 * Access tokens last one hour, a common provider default. A shared connection
 * renews its token only once it has (nearly) expired, so routine use during the
 * test does not renew it. Once the harness moves the saved expiry back 61 minutes,
 * the next use (the board's connection check) refreshes it.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TOOL_NAME = "create_page";
export const ACCESS_TOKEN_SECONDS = 60 * 60;

export interface OAuthAppRecord {
  registrations: number;
  codeExchanges: number;
  /** Authorization codes refused: unknown, reused, or a missing or wrong PKCE verifier. */
  rejectedCodes: number;
  /** Epoch ms of each successful refresh-token exchange. */
  refreshes: number[];
  rejectedRefreshes: number;
  toolCalls: Array<{ at: number; title: unknown }>;
}

export interface OAuthApp {
  origin: string;
  mcpUrl: string;
  /** Only the provider's tool result carries this; an agent that reports it saw the real result. */
  receipt: string;
  record: OAuthAppRecord;
  close(): Promise<void>;
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

export async function startOAuthApp(options: { host?: string } = {}): Promise<OAuthApp> {
  const host = options.host ?? "127.0.0.1";
  const receipt = `receipt-${randomUUID()}`;
  const record: OAuthAppRecord = { registrations: 0, codeExchanges: 0, rejectedCodes: 0, refreshes: [], rejectedRefreshes: 0, toolCalls: [] };
  const codes = new Map<string, { redirectUri: string; challenge: string }>();
  let generation = 0;
  let accessToken = "";
  let refreshToken = "";
  let origin = "";
  const issue = () => {
    generation += 1;
    accessToken = `chaos-access-${generation}-${randomUUID()}`;
    refreshToken = `chaos-refresh-${generation}-${randomUUID()}`;
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: ACCESS_TOKEN_SECONDS,
      token_type: "Bearer", scope: "pages.write offline_access" };
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", origin);
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["pages.write", "offline_access"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"], response_types_supported: ["code"],
        scopes_supported: ["pages.write", "offline_access"], grant_types_supported: ["authorization_code", "refresh_token"] });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      record.registrations += 1;
      return json({ ...(JSON.parse(body || "{}") as Record<string, unknown>), client_id: "chaos-client", token_endpoint_auth_method: "none" }, 201);
    }
    if (url.pathname === "/authorize") {
      // The person consents at once: send the browser back with a code.
      const redirectUri = url.searchParams.get("redirect_uri");
      const challenge = url.searchParams.get("code_challenge");
      if (!redirectUri || !challenge || url.searchParams.get("code_challenge_method") !== "S256") return json({ error: "invalid_request" }, 400);
      const code = `chaos-code-${randomUUID()}`;
      codes.set(code, { redirectUri, challenge });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("iss", origin);
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== refreshToken) { record.rejectedRefreshes += 1; return json({ error: "invalid_grant" }, 400); }
        record.refreshes.push(Date.now());
        return json(issue());
      }
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code") ?? "";
        const saved = codes.get(code);
        codes.delete(code);
        // PKCE S256: the verifier must hash to the challenge sent with the authorization request.
        const verifier = form.get("code_verifier") ?? "";
        if (!saved || !verifier || pkceChallenge(verifier) !== saved.challenge
          || (form.has("redirect_uri") && form.get("redirect_uri") !== saved.redirectUri)) {
          record.rejectedCodes += 1;
          return json({ error: "invalid_grant" }, 400);
        }
        record.codeExchanges += 1;
        return json(issue());
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (url.pathname === "/mcp") {
      if (!accessToken || req.headers.authorization !== `Bearer ${accessToken}`) {
        res.setHeader("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
        return json({ error: "invalid_token" }, 401);
      }
      if (req.method !== "POST") return json({}, 405);
      const rpc = JSON.parse(body || "{}") as { id?: unknown; method?: string; params?: { arguments?: { title?: unknown } } };
      if (rpc.method?.startsWith("notifications/")) { res.writeHead(202).end(); return; }
      if (rpc.method === "initialize") {
        return json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} },
          serverInfo: { name: "chaos-pages", version: "1" } } });
      }
      if (rpc.method === "tools/list") {
        return json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: TOOL_NAME, description: "Create a page in the chaos workspace",
          inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
          annotations: { readOnlyHint: false, destructiveHint: false } }] } });
      }
      if (rpc.method === "tools/call") {
        const title = rpc.params?.arguments?.title;
        record.toolCalls.push({ at: Date.now(), title });
        return json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `Created page ${String(title)}. ${receipt}` }] } });
      }
      return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
    }
    json({ error: "not_found" }, 404);
  };
  const server = createServer((req, res) => { handle(req, res).catch(error => { res.writeHead(500).end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, host, resolve));
  origin = `http://${host}:${(server.address() as AddressInfo).port}`;
  return {
    origin, mcpUrl: `${origin}/mcp`, receipt, record,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
