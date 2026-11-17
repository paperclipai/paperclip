import { describe, expect, it, vi } from "vitest";
import { BridgeProcessCapacityError } from "./http2-bridge-server.js";
import {
  buildSandboxBridgeRelayGiveUp,
  createSandboxBridgeRelay,
  sandboxBridgeRelayRouteRules,
  sandboxBridgeRelayRoutePolicies,
  SANDBOX_BRIDGE_RELAY_EXTRA_HEADERS,
  validateSandboxBridgeRelayRoutes,
  type SandboxBridgeRelayRoute,
} from "./sandbox-bridge-relay.js";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  buildSandboxCallbackBridgeEnv,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
  getSandboxCallbackBridgeServerSource,
  sanitizeSandboxCallbackBridgeHeaders,
} from "./sandbox-callback-bridge.js";

const MCP_TOKEN = "mcp-token-SENTINEL-8909";
const route: SandboxBridgeRelayRoute = {
  path: "/paperclip-relay/mcp/gateway",
  upstreamUrl: "https://public.example/mcp/gateways/g1?x=1",
  token: MCP_TOKEN,
  deadlineMs: 65_000,
  label: "Gateway",
};
const readBody = async (response: Response) => Buffer.from(await response.arrayBuffer());
const toolCall = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "t" } });

describe("sandbox bridge relay", () => {
  it("allows the MCP session headers only when relay routes opt in", () => {
    const headers = { "mcp-protocol-version": "2025-06-18", "mcp-session-id": "s1", authorization: "Bearer x", accept: "application/json" };
    expect(Object.keys(sanitizeSandboxCallbackBridgeHeaders(headers))).toEqual(["accept"]);
    const extended = sanitizeSandboxCallbackBridgeHeaders(headers, [
      ...DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
      ...SANDBOX_BRIDGE_RELAY_EXTRA_HEADERS,
    ]);
    expect(Object.keys(extended).sort()).toEqual(["accept", "mcp-protocol-version", "mcp-session-id"]);
  });

  it("keeps the sandbox gateway header allowlist and env empty unless opted in", () => {
    expect(buildSandboxCallbackBridgeEnv({ queueDir: "/q", bridgeToken: "t" })).not.toHaveProperty("PAPERCLIP_BRIDGE_EXTRA_HEADERS");
    expect(
      buildSandboxCallbackBridgeEnv({ queueDir: "/q", bridgeToken: "t", extraHeaders: ["mcp-session-id"] }).PAPERCLIP_BRIDGE_EXTRA_HEADERS,
    ).toBe("mcp-session-id");
    expect(getSandboxCallbackBridgeServerSource()).toContain("process.env.PAPERCLIP_BRIDGE_EXTRA_HEADERS");
  });

  it("admits GET, POST and DELETE on a relay path, and 403s other methods and paths", () => {
    const rules = [...DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST, ...sandboxBridgeRelayRouteRules([route])];
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method, path: route.path }, rules)).toBeNull();
    }
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method: "PUT", path: route.path }, rules)).toMatch(/not allowed/);
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method: "POST", path: `${route.path}/x` }, rules)).toMatch(/not allowed/);
    // Without relay routes the path stays denied (Pi and Claude unchanged).
    expect(
      authorizeSandboxCallbackBridgeRequestWithRoutes({ method: "GET", path: route.path }, DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST),
    ).toMatch(/not allowed/);
  });

  it("rejects relay routes outside the allowed path and upstream shapes", () => {
    expect(() => validateSandboxBridgeRelayRoutes([{ ...route, path: "/api/agents/me" }])).toThrow();
    expect(() => validateSandboxBridgeRelayRoutes([{ ...route, upstreamUrl: "https://x.example/api/agents/me" }])).toThrow();
    expect(() => validateSandboxBridgeRelayRoutes([{ ...route, deadlineMs: 0 }])).toThrow();
    expect(() => validateSandboxBridgeRelayRoutes([route, route])).toThrow();
  });

  it("injects the route credential, rebases onto the host API, and forwards only MCP headers", async () => {
    const fetchImpl = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      new Response('{"jsonrpc":"2.0","id":7,"result":{}}', { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s9", "set-cookie": "a=b" } }),
    );
    const relay = createSandboxBridgeRelay({ routes: [route], hostApiUrl: "http://127.0.0.1:3100", runId: "run-1", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await relay.handle(
      { method: "POST", path: route.path, body: toolCall, headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18", "mcp-session-id": "s1", authorization: "Bearer bridge", cookie: "c" } },
      { readBody },
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:3100/mcp/gateways/g1");
    const sent = init!.headers as Headers;
    expect(sent.get("authorization")).toBe(`Bearer ${MCP_TOKEN}`);
    expect(sent.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(sent.get("mcp-session-id")).toBe("s1");
    expect(sent.get("cookie")).toBeNull();
    expect(init!.redirect).toBe("manual");
    expect(response?.status).toBe(200);
    expect(response?.headers["mcp-session-id"]).toBe("s9");
    expect(response?.headers).not.toHaveProperty("set-cookie");
    expect(JSON.stringify(response)).not.toContain(MCP_TOKEN);
  });

  it("answers the client's GET stream and DELETE session close with 405, never forwarding them", async () => {
    const fetchImpl = vi.fn();
    const relay = createSandboxBridgeRelay({ routes: [route], hostApiUrl: "http://127.0.0.1:3100", runId: "r", fetchImpl: fetchImpl as unknown as typeof fetch });
    for (const method of ["GET", "DELETE"]) {
      const response = await relay.handle({ method, path: route.path, headers: { "mcp-session-id": "s1" } }, { readBody });
      expect(response?.status).toBe(405);
      expect(response?.headers.allow).toBe("POST");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await relay.handle({ method: "POST", path: "/api/agents/me", headers: {} }, { readBody })).toBeNull();
  });

  it("uses each route's own deadline and gives up with a JSON-RPC error, not an indeterminate 409", async () => {
    const seenDeadlines: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      seenDeadlines.push(ms);
      return AbortSignal.abort(new DOMException("timeout", "TimeoutError"));
    });
    const hang = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("{}");
    });
    const slow = { ...route, deadlineMs: 65_000 };
    const quick = { ...route, path: "/paperclip-relay/mcp/projects", upstreamUrl: "https://public.example/api/mcp/project-tools", deadlineMs: 30_000 };
    const relay = createSandboxBridgeRelay({ routes: [slow, quick], hostApiUrl: "http://127.0.0.1:3100", runId: "r", fetchImpl: hang as unknown as typeof fetch });
    const a = await relay.handle({ method: "POST", path: slow.path, body: toolCall, headers: {} }, { readBody });
    await relay.handle({ method: "POST", path: quick.path, body: toolCall, headers: {} }, { readBody });
    spy.mockRestore();
    expect(seenDeadlines).toEqual([65_000, 30_000]);
    expect(a?.status).toBe(504);
    expect(a?.headers).not.toHaveProperty("x-paperclip-bridge-outcome");
    const body = JSON.parse(a!.body.toString("utf8"));
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32603, data: { reason: "bridge_deadline_exceeded", outcome: "indeterminate" } } });
    expect(body.error.message).toContain("gave up after 65s");
    expect(JSON.stringify(body)).not.toContain(MCP_TOKEN);
  });

  it("builds clear give-ups for cancelled and unreachable upstreams without a completion claim on list calls", () => {
    const list = JSON.stringify({ jsonrpc: "2.0", id: "a", method: "tools/list" });
    const out = buildSandboxBridgeRelayGiveUp({ label: "Gateway", reason: "upstream_unreachable", deadlineMs: 1000, request: { body: list } });
    const parsed = JSON.parse(out.body.toString("utf8"));
    expect(parsed.id).toBe("a");
    expect(parsed.error.message).not.toContain("may or may not");
    expect(parsed.error.data).not.toHaveProperty("outcome");
  });

  it("answers an unreadable or over-capacity response with an indeterminate give-up, never a retryable 503", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const relay = createSandboxBridgeRelay({ routes: [route], hostApiUrl: "http://127.0.0.1:3100", runId: "r", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await relay.handle(
      { method: "POST", path: route.path, body: toolCall, headers: {} },
      { readBody: async () => { throw new BridgeProcessCapacityError(); } },
    );
    expect(response?.status).toBe(504);
    expect(JSON.parse(response!.body.toString("utf8")).error.data).toMatchObject({ reason: "bridge_response_unreadable", outcome: "indeterminate" });
  });

  it("registers each relay route as its own file-bridge lane with a deadline above the relay give-up", () => {
    const other = { ...route, path: "/paperclip-relay/mcp/projects", deadlineMs: 30_000, maxConcurrent: 2 };
    const policies = sandboxBridgeRelayRoutePolicies([route, other]);
    expect(policies.map((p) => [p.deadlineMs, p.maxConcurrent])).toEqual([[70_000, 4], [35_000, 2]]);
    expect(policies[0]!.path.test(route.path)).toBe(true);
    expect(policies[0]!.path.test(other.path)).toBe(false);
    expect(policies[0]!.path.test(`${route.path}/x`)).toBe(false);
    expect(sandboxBridgeRelayRoutePolicies([])).toEqual([]);
  });
});
