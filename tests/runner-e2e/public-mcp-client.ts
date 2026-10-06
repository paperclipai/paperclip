import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";

const require = createRequire(path.resolve(import.meta.dirname, "../../server/package.json"));
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));
export const origin = `http://127.0.0.1:${process.env.PAPERCLIP_RUNNER_E2E_PORT ?? process.env.PAPERCLIP_PUBLIC_MCP_EVAL_PORT ?? 3298}`;
export const resource = origin + "/mcp/paperclip";
export interface Team { id: string; name: string; issuePrefix: string }
export interface Agent { id: string; name: string; status: string }
export interface Task { id: string; companyId: string; title: string; status: string; assigneeAgentId: string | null }
export interface Run { id: string; agentId: string; status: string }
export interface Document { body: string; createdByAgentId: string | null; latestRevisionId: string }
export interface Comment { id: string; body: string; authorUserId: string | null; authorAgentId: string | null }
export interface Tokens { access_token: string; refresh_token: string; expires_in: number; scope: string }
export interface ToolResult { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> }

export async function api<T>(context: BrowserContext, method: string, route: string, data?: unknown): Promise<T> {
  const response = await context.request.fetch(origin + route, { method, data, headers: { Origin: origin } });
  // Never include response bodies, cookies or OAuth codes in diagnostic errors.
  if (!response.ok()) throw new Error(`Public API ${method} ${route.split("?")[0]} returned HTTP ${response.status()}`);
  return response.status() === 204 ? undefined as T : await response.json() as T;
}
export async function oauthPost(route: string, body: unknown) {
  return fetch(origin + "/mcp/oauth/" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export async function beginConnection(write = true, redirect = origin + "/eval-client-callback") {
  const registration = await oauthPost("register", { client_name: "Paperclip acceptance client", redirect_uris: [redirect] });
  expect(registration.status, "public client registration").toBe(201);
  const { client_id: clientId } = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", resource, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state, scope: `paperclip:read ${write ? "paperclip:write " : ""}offline_access` });
  const response = await fetch(origin + "/mcp/oauth/authorize?" + params, { redirect: "manual" });
  expect(response.status, "authorization request").toBe(303);
  const consentUrl = response.headers.get("location")!;
  return { clientId, verifier, state, redirect, params, consentUrl, requestId: new URL(consentUrl).pathname.split("/").at(-1)! };
}

export async function connect(context: BrowserContext, team: Team, write = true, page?: Page, secrets: string[] = []) {
  // A real assistant callback has its own origin. A same-origin fake callback
  // would be intercepted by Paperclip's service worker and render the board.
  const callbackServer = page ? createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); res.end("<h1>Assistant connected</h1>"); }) : undefined;
  if (callbackServer) { callbackServer.listen(0, "127.0.0.1"); await once(callbackServer, "listening"); }
  const address = callbackServer?.address();
  const redirect = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}/callback` : undefined;
  try {
  const request = await beginConnection(write, redirect);
  let redirectUrl: string;
  if (page) {
    await page.goto(request.consentUrl);
    await expect(page.getByRole("heading", { name: /^Connect .+ to Paperclip$/ })).toBeVisible();
    await page.getByRole("radio", { name: team.name, exact: true }).check();
    if (write) await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Connect organization", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Assistant connected" })).toBeVisible();
    redirectUrl = page.url();
    // Leave the secret-bearing callback before any later assertions/evidence.
    await page.goto(origin + "/assistant-connections");
  } else {
    ({ redirectUrl } = await api<{ redirectUrl: string }>(context, "POST", `/api/mcp/requests/${request.requestId}/consent`, { decision: "approve", companyId: team.id, allowWrites: write }));
  }
  const callback = new URL(redirectUrl);
  secrets.push(request.verifier, callback.searchParams.get("code") ?? "");
  expect(callback.searchParams.get("state") === request.state, "OAuth state returned intact").toBe(true);
  const exchange = { grant_type: "authorization_code", client_id: request.clientId, redirect_uri: request.redirect, resource, code: callback.searchParams.get("code"), code_verifier: request.verifier };
  const tokenResponse = await oauthPost("token", exchange);
  expect(tokenResponse.status, "code exchange").toBe(200);
  const tokens = await tokenResponse.json() as Tokens;
  secrets.push(tokens.access_token, tokens.refresh_token);
  return { ...request, tokens, exchange };
  } finally {
    if (callbackServer) { callbackServer.closeAllConnections(); await new Promise<void>(resolve => callbackServer.close(() => resolve())); }
  }
}

export async function mcp(tokens: Tokens) {
  const client = new Client({ name: "paperclip-product-eval", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  return {
    list: async () => await client.listTools() as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean } }> },
    call: async (name: string, args: Record<string, unknown> = {}) => await client.callTool({ name, arguments: args }) as ToolResult,
    close: async () => { await client.close(); },
  };
}
export function content<T>(result: ToolResult): T {
  expect(result.isError === true, "MCP operation succeeded").toBe(false);
  expect(result.structuredContent, "MCP returned structured outcome").toBeTruthy();
  return result.structuredContent as T;
}


/** Host-owned Events transport. Models never see callback signing or OAuth material. */
export async function mcpEventRpc(tokens: Tokens, method: string, args: Record<string, unknown> = {}) {
  const response = await fetch(resource, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }) });
  const body = await response.json() as { result?: Record<string, unknown>; error?: { code: number; data?: { reason?: string } } };
  if (!response.ok || body.error || !body.result) throw new Error(`MCP Events ${method} failed: HTTP ${response.status}, code ${body.error?.code ?? "missing_result"}, reason ${body.error?.data?.reason ?? "unavailable"}; details withheld`);
  return body.result;
}

export interface ReceivedTaskEvent { eventId: string; name: string; timestamp: string; data: { companyId: string; taskId: string; status?: string }; cursor: null }
interface EventReceiver {
  url: string; secret: string; events: ReceivedTaskEvent[]; readonly verified: number;
  readonly duplicateCount: number; startupAttempts: number; startupFailures: string[]; close: () => Promise<void>;
}
export async function eventReceiver(secrets: string[], startupFailures: string[] = []): Promise<EventReceiver> {
  const key = randomBytes(32);
  const secret = "whsec_" + key.toString("base64");
  const path = "/events/" + randomUUID();
  const readinessNonce = randomUUID();
  const events: ReceivedTaskEvent[] = [];
  const seen = new Set<string>();
  let verified = 0;
  let duplicateCount = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === path && req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ nonce: readinessNonce })); return; }
      if (req.url !== path || req.method !== "POST") { res.writeHead(404); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 262144) throw new Error(); chunks.push(Buffer.from(chunk)); }
      const raw = Buffer.concat(chunks).toString();
      const id = req.headers["webhook-id"];
      const timestamp = req.headers["webhook-timestamp"];
      const signature = req.headers["webhook-signature"];
      if (typeof id !== "string" || typeof timestamp !== "string" || typeof signature !== "string" || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error();
      const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest();
      const valid = signature.split(" ").some(part => { const [version, encoded] = part.split(","); const actual = Buffer.from(encoded ?? "", "base64"); return version === "v1" && actual.length === expected.length && timingSafeEqual(actual, expected); });
      if (!valid) throw new Error();
      const body = JSON.parse(raw);
      if (body.type === "verification" && typeof body.challenge === "string") {
        verified++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ challenge: body.challenge })); return;
      }
      if (body.eventId !== id || !body.data || body.type) throw new Error();
      if (seen.has(id)) duplicateCount++; else { seen.add(id); events.push(body); }
      res.writeHead(204); res.end();
    } catch { res.writeHead(400); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Event receiver did not start");
  const tunnel = spawn(process.env.PAPERCLIP_EVAL_CLOUDFLARED ?? "cloudflared", ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${address.port}`], { stdio: ["ignore", "pipe", "pipe"] });
  const close = async () => {
    if (tunnel.pid && tunnel.exitCode === null && tunnel.signalCode === null) {
      const exited = once(tunnel, "exit").catch(() => {});
      tunnel.kill("SIGTERM");
      const timer = setTimeout(() => tunnel.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  };
  secrets.push(secret);
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => { reject(new Error("HTTPS event tunnel startup timed out")); }, 60_000);
      const finish = (error?: Error, url?: string) => { clearTimeout(timer); if (error) reject(error); else resolve(url!); };
      tunnel.once("error", () => finish(new Error("cloudflared is required for the live HTTPS event receiver")));
      tunnel.once("exit", () => finish(new Error("HTTPS event tunnel exited before startup")));
      const read = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32768); const url = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0]; if (url && output.includes("Registered tunnel connection")) finish(undefined, url); };
      tunnel.stdout!.on("data", read); tunnel.stderr!.on("data", read);
    });
    secrets.push(origin + path);
    // A registered tunnel connection can precede public DNS/edge readiness.
    // Prove that this exact fixture receiver is reachable before paying for work.
    const readyBy = Date.now() + 60_000;
    let ready = false;
    let lastFailure = "unreachable";
    while (Date.now() < readyBy) {
      try {
        const response = await fetch(origin + path, { redirect: "error", signal: AbortSignal.timeout(5000) });
        if (response.ok && (await response.json() as { nonce?: string }).nonce === readinessNonce) { ready = true; break; }
        lastFailure = `http_${response.status}`;
        await response.body?.cancel();
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        lastFailure = cause === "ENOTFOUND" ? "dns_not_found" : "network_unavailable";
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error(`HTTPS event receiver did not become publicly reachable (${lastFailure})`);
    return { url: origin + path, secret, events, startupAttempts: startupFailures.length + 1, startupFailures, get verified() { return verified; }, get duplicateCount() { return duplicateCount; }, close };
  } catch (error) {
    await close();
    const reason = error instanceof Error && error.message.includes("dns_not_found") ? "dns_not_found" : "tunnel_startup_unavailable";
    const failures = [...startupFailures, reason];
    if (failures.length < 3) return eventReceiver(secrets, failures);
    throw new Error(`HTTPS event receiver failed after ${failures.length} setup attempts (${reason}); no model call started`);
  }
}
