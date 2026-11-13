import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, toolConnections } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { MCP_APPS_CLIENT_CAPABILITY, MCP_APPS_EXTENSION_ID, MCP_SKILLS_CLIENT_CAPABILITY, MCP_SKILLS_EXTENSION_ID } from "@paperclipai/shared";
import {
  encodeMcpHeaderValue,
  forgetMcpHttpSessions,
  initializeMcpHttpSession,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  McpHttpInitializationError,
  mcpCacheHint,
  mcpHttpRequestInit,
  mcpInputRequired,
  mcpModernErrorOf,
  McpResultCache,
  mcpResultType,
  mcpToolHeaderParameters,
  readMcpModernError,
  selectMcpProtocolVersion,
} from "../services/mcp-http.js";
import { mcpInputRequiredPending } from "../services/tool-gateway.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessService } from "../services/tool-access.js";
import { saveMcpNegotiation } from "../services/tool-access/mcp-protocol-config.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";

type Recorded = { method: string; headers: Headers; body: Record<string, any> };

const tool = (name: string, inputSchema: Record<string, unknown> = { type: "object", properties: {} }) =>
  ({ name, description: name, inputSchema, annotations: { readOnlyHint: true } });

/**
 * A stateless (2026-07-28) server: it validates headers against the body,
 * rejects anything without per-request metadata, and has no handshake.
 */
function modernServer(options: { ttlMs?: number; tools?: unknown[]; onList?: () => Promise<void> } = {}) {
  const requests: Recorded[] = [];
  let rejectNextCall = false;
  // The provider tracks an out-of-band step itself, as URL elicitation requires.
  let consentCompleted = false;
  const respond = (id: unknown, result: Record<string, unknown>) =>
    Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern", version: "1" } } } });
  const fail = (status: number, id: unknown, code: number, message: string, data?: unknown) =>
    Response.json({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }, { status });
  const handle = async (_url: string, init: RequestInit): Promise<Response> => {
    if ((init.method ?? "GET").toUpperCase() !== "POST") return new Response(null, { status: 404 });
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    requests.push({ method: body.method, headers, body });
    const meta = body.params?._meta ?? {};
    const version = meta[META_VERSION];
    if (!version || headers.get("mcp-protocol-version") !== version || headers.get("mcp-method") !== body.method) {
      return fail(400, body.id, -32020, "Header mismatch or missing request metadata");
    }
    if (version !== MCP_MODERN_PROTOCOL_VERSION) return fail(400, body.id, -32022, "Unsupported protocol version", { supported: [MCP_MODERN_PROTOCOL_VERSION], requested: version });
    if (body.method === "tools/call" && headers.get("mcp-name") !== body.params.name) return fail(400, body.id, -32020, "Mcp-Name does not match");
    if (body.method === "tools/call" && rejectNextCall) {
      rejectNextCall = false;
      return new Response(null, { status: 503 });
    }
    switch (body.method) {
      case "server/discover":
        return respond(body.id, { supportedVersions: ["2099-01-01", MCP_MODERN_PROTOCOL_VERSION], capabilities: { tools: {} }, ttlMs: 60_000, cacheScope: "public" });
      case "tools/list":
        await options.onList?.();
        return respond(body.id, { tools: options.tools ?? [tool("lookup"), tool("authorize_then_run"), tool("busy_then_run"), tool("needs_form")], ttlMs: options.ttlMs ?? 300_000, cacheScope: "private" });
      case "tools/call": {
        const { name, requestState } = body.params;
        if (name === "busy_then_run" && requestState !== "busy-1") {
          return respond(body.id, { resultType: "input_required", requestState: "busy-1" });
        }
        if (name === "authorize_then_run" && !consentCompleted) {
          return respond(body.id, {
            resultType: "input_required",
            inputRequests: { consent: { method: "elicitation/create", params: { mode: "url", message: "Approve access in Example", url: "https://auth.example.com/consent?flow=1" } } },
            requestState: "state-1",
          });
        }
        if (name === "needs_form") {
          return respond(body.id, {
            resultType: "input_required",
            inputRequests: { login: { method: "elicitation/create", params: { mode: "form", message: "Username?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } } } },
          });
        }
        return respond(body.id, { content: [{ type: "text", text: `${name} ok` }], isError: false });
      }
      default:
        return fail(404, body.id, -32601, "Method not found");
    }
  };
  return { requests, handle, methods: () => requests.map((request) => request.method), rejectNextCall: () => { rejectNextCall = true; }, completeConsent: () => { consentCompleted = true; } };
}

/** A 2025-11-25 server with a session: no `server/discover`, no per-request metadata. */
function legacyServer(options: { answerModernWithSupported?: string[] } = {}) {
  const requests: Recorded[] = [];
  let sessions = 0;
  const handle = async (_url: string, init: RequestInit): Promise<Response> => {
    if ((init.method ?? "GET").toUpperCase() !== "POST") return new Response(null, { status: 404 });
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    requests.push({ method: body.method, headers, body });
    if (options.answerModernWithSupported && body.params?._meta?.["io.modelcontextprotocol/protocolVersion"]) {
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: options.answerModernWithSupported } } }, { status: 400 });
    }
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } } },
        { headers: { "Mcp-Session-Id": `legacy-${++sessions}` } });
    }
    // Like common SDK servers: anything before the handshake is a bad request.
    if (!headers.get("mcp-session-id")) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } }, { status: 400 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [tool("lookup")] } });
    if (body.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "legacy ok" }] } });
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  };
  return { requests, handle, methods: () => requests.map((request) => request.method) };
}

describe("MCP protocol negotiation (Streamable HTTP)", () => {
  it("talks to a stateless server without a handshake or session", async () => {
    const server = modernServer();
    const headers = await initializeMcpHttpSession({ requestId: "probe", headers: { Authorization: "Bearer t" }, send: (init) => server.handle("", init) });
    expect(server.methods()).toEqual(["server/discover"]);
    expect(headers).toEqual({ Authorization: "Bearer t", "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION });
    const discover = server.requests[0]!;
    expect(discover.headers.get("mcp-method")).toBe("server/discover");
    expect(discover.body.params._meta[META_CAPABILITIES].extensions[MCP_APPS_EXTENSION_ID]).toEqual({ mimeTypes: ["text/html;profile=mcp-app"] });
    expect(discover.body.params._meta[META_CLIENT]).toEqual({ name: "paperclip", version: "1" });
  });

  it("falls back to the initialize handshake for a legacy server and advertises MCP Apps there", async () => {
    const server = legacyServer();
    const headers = await initializeMcpHttpSession({ requestId: "probe", send: (init) => server.handle("", init) });
    expect(server.methods()).toEqual(["server/discover", "initialize", "notifications/initialized"]);
    expect(headers).toMatchObject({ "Mcp-Session-Id": "legacy-1", "MCP-Protocol-Version": "2025-06-18" });
    const initialize = server.requests[1]!.body;
    expect(initialize.params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(initialize.params.capabilities.extensions[MCP_APPS_EXTENSION_ID]).toEqual({ mimeTypes: ["text/html;profile=mcp-app"] });
    expect(initialize.params._meta).toBeUndefined();
  });

  it("advertises MCP Apps in every request and handshake, and Skills on every stateless request", async () => {
    const modern = modernServer();
    const modernHeaders = await initializeMcpHttpSession({ requestId: "apps-modern", send: (init) => modern.handle("", init) });
    const call = mcpHttpRequestInit(modernHeaders, { id: 1, method: "tools/call", params: { name: "lookup", arguments: {} } });
    expect(modern.requests[0]!.body.params._meta[META_CAPABILITIES].extensions).toEqual({ ...MCP_APPS_CLIENT_CAPABILITY, ...MCP_SKILLS_CLIENT_CAPABILITY });
    expect(JSON.parse(call.body).params._meta[META_CAPABILITIES].extensions).toEqual({ ...MCP_APPS_CLIENT_CAPABILITY, ...MCP_SKILLS_CLIENT_CAPABILITY });
    const legacy = legacyServer();
    await initializeMcpHttpSession({ requestId: "apps-legacy", send: (init) => legacy.handle("", init) });
    const initialize = legacy.requests.find((request) => request.method === "initialize")!;
    expect(initialize.body.params.capabilities.extensions).toEqual(MCP_APPS_CLIENT_CAPABILITY);
  });

  it("remembers the era per server so a later session needs no probe", async () => {
    const server = legacyServer();
    const eraKey = `era-test-${randomUUID()}:era:https://legacy.example/mcp`;
    await initializeMcpHttpSession({ requestId: "a", eraKey, send: (init) => server.handle("", init) });
    await initializeMcpHttpSession({ requestId: "b", eraKey, send: (init) => server.handle("", init) });
    expect(server.methods().filter((method) => method === "server/discover")).toHaveLength(1);
  });

  it("uses a version from an UnsupportedProtocolVersion answer instead of falling back", async () => {
    const send = vi.fn(async (init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32022, message: "Unsupported", data: { supported: ["2099-01-01", MCP_MODERN_PROTOCOL_VERSION] } } }, { status: 400 });
    });
    expect(await initializeMcpHttpSession({ requestId: "x", send })).toEqual({ "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION });
    expect(send).toHaveBeenCalledOnce();
    const unknown = vi.fn(async (init: RequestInit) => Response.json({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, error: { code: -32022, message: "Unsupported", data: { supported: ["2099-01-01"] } } }, { status: 400 }));
    await expect(initializeMcpHttpSession({ requestId: "y", send: unknown })).rejects.toBeInstanceOf(McpHttpInitializationError);
  });

  it("keeps a sign-in challenge from the probe for OAuth discovery", async () => {
    const challenge = new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"' } });
    const send = vi.fn(async () => challenge);
    const failure = await initializeMcpHttpSession({ requestId: "z", send }).catch((error) => error);
    expect(failure).toBeInstanceOf(McpHttpInitializationError);
    expect(failure.response).toBe(challenge);
    expect(send).toHaveBeenCalledOnce();
  });

  it("selects the newest mutually supported version", () => {
    expect(selectMcpProtocolVersion(["2025-06-18", "2026-07-28", "2099-01-01"])).toBe("2026-07-28");
    expect(selectMcpProtocolVersion(["2025-06-18", "2025-11-25"])).toBe("2025-11-25");
    expect(selectMcpProtocolVersion(["1900-01-01"])).toBeNull();
  });
});

describe("MCP request envelope", () => {
  it("adds per-request metadata and mirrored headers for a stateless server", () => {
    const init = mcpHttpRequestInit({ "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION, "Mcp-Session-Id": "stale", "mcp-name": "spoofed" }, {
      id: 1, method: "tools/call", params: { name: "execute_sql", arguments: { region: "us-west1", query: "select 1", nested: { tenant: "Grüße" } } },
    }, { toolInputSchema: { type: "object", properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      nested: { type: "object", properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } } },
    } } });
    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body);
    expect(headers.get("mcp-method")).toBe("tools/call");
    expect(headers.get("mcp-name")).toBe("execute_sql");
    expect(headers.get("mcp-param-region")).toBe("us-west1");
    expect(headers.get("mcp-param-tenant")).toBe(`=?base64?${Buffer.from("Grüße").toString("base64")}?=`);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(body.params._meta).toMatchObject({ [META_VERSION]: MCP_MODERN_PROTOCOL_VERSION, [META_CLIENT]: { name: "paperclip", version: "1" } });
    expect(body.params._meta[META_CAPABILITIES]).toEqual({ elicitation: { url: {} }, extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ["text/html;profile=mcp-app"] }, [MCP_SKILLS_EXTENSION_ID]: {} } });
  });

  it("mirrors the method and resource URI for every request, without metadata for a legacy session", () => {
    const init = mcpHttpRequestInit({ "MCP-Protocol-Version": "2025-06-18", "Mcp-Session-Id": "s" }, { id: 2, method: "resources/read", params: { uri: "ui://app/view.html" } });
    const headers = new Headers(init.headers);
    expect(headers.get("mcp-method")).toBe("resources/read");
    expect(headers.get("mcp-name")).toBe("ui://app/view.html");
    expect(JSON.parse(init.body).params._meta).toBeUndefined();
  });

  it("encodes header values that are not plain ASCII or look like the sentinel", () => {
    expect(encodeMcpHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeMcpHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(encodeMcpHeaderValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
    expect(encodeMcpHeaderValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
  });

  it("never drops a tool for a large enum", () => {
    const values = Array.from({ length: 20_000 }, (_, index) => `value-${index}`);
    expect(mcpToolHeaderParameters({ type: "object", properties: { pick: { type: "string", enum: values } } })).toEqual({ ok: true, parameters: [] });
    expect(mcpToolHeaderParameters({ type: "object", properties: {
      pick: { type: "string", enum: values },
      region: { type: "string", "x-mcp-header": "Region" },
    } })).toEqual({ ok: true, parameters: [{ header: "Region", path: ["region"] }] });
  });

  it("rejects x-mcp-header annotations outside plain property paths", () => {
    expect(mcpToolHeaderParameters({ type: "object", properties: { a: { type: "string", "x-mcp-header": "A" } } }).ok).toBe(true);
    expect(mcpToolHeaderParameters({ type: "object", properties: { a: { type: "number", "x-mcp-header": "A" } } }).ok).toBe(false);
    expect(mcpToolHeaderParameters({ type: "object", properties: { a: { type: "array", items: { type: "string", "x-mcp-header": "A" } } } }).ok).toBe(false);
    expect(mcpToolHeaderParameters({ type: "object", properties: { a: { type: "string", "x-mcp-header": "A" }, b: { type: "string", "x-mcp-header": "a" } } }).ok).toBe(false);
    expect(mcpToolHeaderParameters({ type: "object", properties: { a: { type: "string", "x-mcp-header": "Bad Header" } } }).ok).toBe(false);
    expect(mcpToolHeaderParameters({ oneOf: [{ type: "object", properties: { a: { type: "string", "x-mcp-header": "A" } } }] }).ok).toBe(false);
  });
});

describe("MCP results", () => {
  it("treats a result without resultType as complete", () => {
    expect(mcpResultType({ content: [] })).toBe("complete");
    expect(mcpInputRequired({ content: [] })).toBeNull();
  });

  it("honors freshness hints only on complete results", () => {
    expect(mcpCacheHint({ resultType: "complete", ttlMs: 5_000, cacheScope: "public" })).toEqual({ ttlMs: 5_000, scope: "public" });
    expect(mcpCacheHint({ tools: [], ttlMs: 5_000 })).toEqual({ ttlMs: 5_000, scope: "private" });
    expect(mcpCacheHint({ resultType: "complete", ttlMs: 0 })).toBeNull();
    expect(mcpCacheHint({ resultType: "complete", ttlMs: -1 })).toBeNull();
    expect(mcpCacheHint({ resultType: "input_required", ttlMs: 5_000 })).toBeNull();
    expect(mcpCacheHint({ tools: [] })).toBeNull();
    expect(mcpCacheHint({ ttlMs: 7 * 24 * 3600_000 })!.ttlMs).toBe(10 * 60_000);
  });

  it("bounds cached provider results by size, not only by count", () => {
    const cache = new McpResultCache<string>(500, Date.now, 1_000, 400);
    cache.set("huge", "x".repeat(10_000), 60_000);
    expect(cache.get("huge")).toBeUndefined();
    for (let index = 0; index < 10; index += 1) cache.set(`entry-${index}`, "y".repeat(300), 60_000);
    expect(cache.bytes).toBeLessThanOrEqual(1_000);
    expect(cache.get("entry-9")).toBeDefined();
    expect(cache.get("entry-0")).toBeUndefined();
    cache.deletePrefix("entry-");
    expect(cache.bytes).toBe(0);
  });

  it("turns a URL input request into a sign-in link and a form request into a needs-input stop", () => {
    const url = mcpInputRequired({ resultType: "input_required", requestState: "s", inputRequests: {
      consent: { method: "elicitation/create", params: { mode: "url", message: "Approve", url: "https://auth.example.com/consent" } },
    } })!;
    // No user answer is ever produced: the link is shown and nothing is asserted.
    expect(mcpInputRequiredPending(url)).toEqual({
      answerable: true,
      upstreamPending: { kind: "authorization", links: [{ url: "https://auth.example.com/consent", host: "auth.example.com" }], message: "Approve" },
    });
    const form = mcpInputRequired({ resultType: "input_required", inputRequests: { name: { method: "elicitation/create", params: { mode: "form", message: "Name?" } } } })!;
    expect(mcpInputRequiredPending(form)).toEqual({ answerable: false });
    expect(mcpInputRequiredPending(mcpInputRequired({ resultType: "input_required", requestState: "retry" })!)).toEqual({ answerable: true, retryState: "retry" });
  });

  it("stops instead of answering for links the user cannot see", () => {
    const many = (count: number) => mcpInputRequired({ resultType: "input_required", requestState: "s", inputRequests: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`step-${index}`, { method: "elicitation/create", params: { mode: "url", message: "Approve", url: `https://auth.example.com/step/${index}` } }]),
    ) })!;
    expect(Object.keys(many(20).inputRequests)).toHaveLength(20);
    expect(mcpInputRequiredPending(many(8))).toMatchObject({ answerable: true, upstreamPending: { links: expect.any(Array) } });
    expect(mcpInputRequiredPending(many(8)).upstreamPending!.links).toHaveLength(8);
    expect(mcpInputRequiredPending(many(9))).toEqual({ answerable: false });
  });

  it("reads a large rejected error body without stalling the caller's copy", async () => {
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x".repeat(512 * 1024) } });
    const response = new Response(new ReadableStream({
      start(controller) { for (let index = 0; index < huge.length; index += 4096) controller.enqueue(new TextEncoder().encode(huge.slice(index, index + 4096))); controller.close(); },
    }), { status: 400, headers: { "content-type": "application/json" } });
    const outcome = await Promise.race([
      readMcpModernError(response).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 2_000)),
    ]);
    expect(outcome).toBe("returned");
    expect((await response.text()).length).toBe(huge.length);
  });

  it("recognizes modern errors, including resource not found's legacy and modern codes as ordinary errors", () => {
    expect(mcpModernErrorOf({ error: { code: -32022, message: "x", data: { supported: ["2026-07-28"] } } })).toMatchObject({ code: -32022, supported: ["2026-07-28"] });
    expect(mcpModernErrorOf({ error: { code: -32602, message: "Resource not found" } })).toBeNull();
    expect(mcpModernErrorOf({ error: { code: -32000, message: "Bad Request" } })).toBeNull();
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("MCP protocol versions end to end", () => {
  const actor = { actorType: "user" as const, actorId: "mcp-protocol-user", actorSource: "local_implicit" as const };
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;
  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "mcp-protocol-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    fixture = await startEmbeddedPostgresTestDatabase("mcp-protocol-versions-");
    db = createDb(fixture.connectionString);
  }, 30_000);
  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  async function connect(handle: (url: string, init: RequestInit) => Promise<Response>, link: string) {
    const [org] = await db.insert(companies).values({ name: `MCP ${randomUUID()}`, issuePrefix: `V${randomUUID().slice(0, 5)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: org.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agent] = await db.insert(agents).values({ companyId: org.id, name: "Protocol agent", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    const options = { deploymentMode: "local_trusted" as const, deploymentExposure: "private" as const,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }], remoteHttpRequest: handle };
    const service = toolAccessService(db, options);
    const connected = await service.connectGalleryApp(org.id, { link, name: "Protocol fixture" }, actor);
    await service.finishGalleryAppConnection(org.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents",
    }, actor);
    const gateway = createToolGatewayService(db, { ...options, toolActionSigningSecret: "protocol-signing-key" });
    const call = (toolName: string, parameters: Record<string, unknown> = {}) => gateway.executeTestCall({
      companyId: org.id, connectionId: connected.connectionId, agentId: agent.id, userId: actor.actorId, toolName, parameters,
    });
    const savedConfig = async () => (await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId)))[0]!.config;
    return { org, service, connected, call, savedConfig };
  }

  it("lists and calls a 2026-07-28 server statelessly, saves the version, and reuses a fresh tool list", async () => {
    const server = modernServer();
    const { service, connected, call, savedConfig } = await connect(server.handle, "https://modern.example.com/mcp");
    expect(connected.catalog.map((entry) => entry.toolName).sort()).toEqual(["authorize_then_run", "busy_then_run", "lookup", "needs_form"]);
    expect(server.methods()).toEqual(["server/discover", "tools/list"]);
    expect(server.requests.every((request) => !request.headers.has("mcp-session-id"))).toBe(true);
    expect(await savedConfig()).toMatchObject({ mcpProtocolVersion: MCP_MODERN_PROTOCOL_VERSION });
    expect(await savedConfig()).not.toHaveProperty("mcpSessionRequired");

    // A refresh inside the server's ttlMs does not list again.
    await service.refreshCatalog(connected.connectionId, actor);
    expect(server.methods()).toEqual(["server/discover", "tools/list"]);

    // After a restart the saved version is used: the call is the only request.
    forgetMcpHttpSessions(connected.connectionId);
    const before = server.requests.length;
    expect(await call("lookup", { q: "x" })).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    const sent = server.requests.slice(before);
    expect(sent.map((request) => request.method)).toEqual(["tools/call"]);
    expect(sent[0]!.headers.get("mcp-name")).toBe("lookup");
    expect(sent[0]!.body.params._meta[META_CAPABILITIES].extensions[MCP_APPS_EXTENSION_ID]).toBeTruthy();
  });

  it("keeps an operator's config edit made while the provider was answering", async () => {
    const link = "https://modern-edit.example.com/mcp";
    const server = modernServer({ onList: async () => {
      await db.update(toolConnections).set({ config: sql`${toolConnections.config} || '{"operatorNote":"kept"}'::jsonb` })
        .where(sql`${toolConnections.config}->>'url' = ${link}`);
    } });
    const { savedConfig } = await connect(server.handle, link);
    expect(await savedConfig()).toMatchObject({ operatorNote: "kept", mcpProtocolVersion: MCP_MODERN_PROTOCOL_VERSION });
  });

  it("does not save a negotiated version once the connection points at another URL", async () => {
    const server = modernServer();
    const { connected, savedConfig } = await connect(server.handle, "https://modern-moved.example.com/mcp");
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    await db.update(toolConnections).set({ config: { ...row!.config, url: "https://elsewhere.example.com/mcp", mcpProtocolVersion: null } })
      .where(eq(toolConnections.id, connected.connectionId));
    expect(await saveMcpNegotiation(db, row!, { mcpProtocolVersion: MCP_MODERN_PROTOCOL_VERSION })).toBeNull();
    expect(await savedConfig()).toMatchObject({ url: "https://elsewhere.example.com/mcp", mcpProtocolVersion: null });
  });

  it("reaches the server for a health check even while the tool list is fresh", async () => {
    const server = modernServer();
    const { service, connected } = await connect(server.handle, "https://modern-health.example.com/mcp");
    const lists = () => server.methods().filter((method) => method === "tools/list").length;
    expect(lists()).toBe(1);
    await service.refreshCatalog(connected.connectionId, actor);
    expect(lists()).toBe(1);
    const health = await service.checkHealth(connected.connectionId, actor);
    expect(health.connection.healthStatus).toBe("ok");
    expect(lists()).toBe(2);
  });

  it("saves the version a refresh actually used when a saved legacy server moved to 2026-07-28", async () => {
    let modern = false;
    const legacy = legacyServer();
    const upgraded = modernServer();
    const { service, savedConfig, connected } = await connect((url, init) => (modern ? upgraded : legacy).handle(url, init), "https://upgrading-refresh.example.com/mcp");
    expect(await savedConfig()).toMatchObject({ mcpProtocolVersion: MCP_PROTOCOL_VERSION });
    modern = true;
    forgetMcpHttpSessions(connected.connectionId);
    await service.refreshCatalog(connected.connectionId, actor);
    expect(upgraded.methods()).toContain("tools/list");
    expect(await savedConfig()).toMatchObject({ mcpProtocolVersion: MCP_MODERN_PROTOCOL_VERSION });
  });

  it("shows a URL input request as a provider link and never claims the person's consent", async () => {
    const server = modernServer();
    const { call } = await connect(server.handle, "https://modern-mrtr.example.com/mcp");
    const first = await call("authorize_then_run", { item: 1 });
    expect(first).toMatchObject({ error: { reasonCode: "provider_interaction_required" }, upstreamPending: { links: [{ url: "https://auth.example.com/consent?flow=1" }] } });
    // An agent retry before the person finishes is asked again; nothing is accepted for them.
    expect(await call("authorize_then_run", { item: 1 })).toMatchObject({ error: { reasonCode: "provider_interaction_required" } });
    server.completeConsent();
    expect(await call("authorize_then_run", { item: 1 })).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    const calls = server.requests.filter((request) => request.method === "tools/call");
    expect(calls).toHaveLength(3);
    for (const request of calls) {
      expect(request.body.params).not.toHaveProperty("inputResponses");
      expect(request.body.params).not.toHaveProperty("requestState");
    }
    expect(new Set(calls.map((request) => request.body.id)).size).toBe(3);
  });

  it("returns a server's try-again state on the retry, and keeps it through a rejected attempt", async () => {
    const server = modernServer();
    const { call } = await connect(server.handle, "https://modern-busy.example.com/mcp");
    expect(await call("busy_then_run", { item: 2 })).toMatchObject({ error: { reasonCode: "provider_retry_requested" } });
    server.rejectNextCall();
    expect(await call("busy_then_run", { item: 2 })).toMatchObject({ error: { reasonCode: "mcp_remote_status" } });
    expect(await call("busy_then_run", { item: 2 })).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    const calls = server.requests.filter((request) => request.method === "tools/call");
    expect(calls[0]!.body.params).not.toHaveProperty("requestState");
    expect(calls[2]!.body.params).toMatchObject({ requestState: "busy-1" });
    expect(calls[2]!.body.params).not.toHaveProperty("inputResponses");
  });

  it("stops with a clear needs-input error for a form input request", async () => {
    const server = modernServer();
    const { call } = await connect(server.handle, "https://modern-form.example.com/mcp");
    expect(await call("needs_form")).toMatchObject({ error: { reasonCode: "provider_input_required" } });
  });

  it("keeps the legacy session flow for an older server", async () => {
    const server = legacyServer();
    const { call, savedConfig } = await connect(server.handle, "https://legacy.example.com/mcp");
    // Probed once; the plain listing is refused, so the handshake follows.
    expect(server.methods().slice(0, 5)).toEqual(["server/discover", "tools/list", "initialize", "notifications/initialized", "tools/list"]);
    expect(server.methods().filter((method) => method === "server/discover")).toHaveLength(1);
    expect(await savedConfig()).toMatchObject({ mcpProtocolVersion: MCP_PROTOCOL_VERSION, mcpSessionRequired: true });
    expect(await call("lookup")).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    const toolCall = server.requests.find((request) => request.method === "tools/call")!;
    expect(toolCall.headers.get("mcp-session-id")).toMatch(/^legacy-/);
    expect(toolCall.headers.get("mcp-method")).toBe("tools/call");
    expect(toolCall.body.params._meta).toBeUndefined();
  });

  it("repairs a saved stateless connection whose server rolled back, without replaying the call", async () => {
    let rolledBack = false;
    const modern = modernServer();
    const legacy = legacyServer();
    const { call, savedConfig, connected } = await connect((url, init) => (rolledBack ? legacy : modern).handle(url, init), "https://rollback.example.com/mcp");
    expect(await savedConfig()).toMatchObject({ mcpProtocolVersion: MCP_MODERN_PROTOCOL_VERSION });
    rolledBack = true;
    forgetMcpHttpSessions(connected.connectionId);
    // A plain 400 does not prove the tool never ran: this call is not sent again,
    // but the saved version is repaired so the next call uses the handshake.
    expect(await call("lookup")).toMatchObject({ error: { reasonCode: "mcp_remote_status" } });
    expect(legacy.methods()).toEqual(["tools/call", "server/discover"]);
    expect(await savedConfig()).toMatchObject({ mcpProtocolVersion: MCP_PROTOCOL_VERSION, mcpSessionRequired: true });
    expect(await call("lookup")).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    expect(legacy.methods()).toEqual(["tools/call", "server/discover", "initialize", "notifications/initialized", "tools/call"]);
    expect(legacy.methods().filter((method) => method === "tools/call")).toHaveLength(2);
  });

  it("uses the handshake when a stateless request is answered with only an older supported version", async () => {
    let rolledBack = false;
    const modern = modernServer();
    const legacy = legacyServer({ answerModernWithSupported: ["2025-06-18"] });
    const { call, savedConfig, connected } = await connect((url, init) => (rolledBack ? legacy : modern).handle(url, init), "https://rollback-32022.example.com/mcp");
    rolledBack = true;
    forgetMcpHttpSessions(connected.connectionId);
    expect(await call("lookup")).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    expect(legacy.methods()).toEqual(["tools/call", "initialize", "notifications/initialized", "tools/call"]);
    expect(await savedConfig()).toMatchObject({ mcpProtocolVersion: "2025-06-18" });
  });

  it("recovers a saved legacy connection whose server moved to 2026-07-28", async () => {
    let modern = false;
    const legacy = legacyServer();
    const upgraded = modernServer();
    const { call, savedConfig, connected } = await connect((url, init) => (modern ? upgraded : legacy).handle(url, init), "https://upgrading.example.com/mcp");
    modern = true;
    forgetMcpHttpSessions(connected.connectionId);
    expect(await call("lookup")).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    // The remembered handshake is refused, the server is probed again, and the call goes through.
    expect(upgraded.methods()).toEqual(["initialize", "server/discover", "tools/call"]);
    expect(await savedConfig()).toMatchObject({ mcpProtocolVersion: MCP_MODERN_PROTOCOL_VERSION });
  });
});
