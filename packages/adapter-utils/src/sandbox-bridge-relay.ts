/**
 * Credential-injecting relay routes for the sandbox callback bridge (TECH-8909).
 *
 * A relay route maps one fixed in-sandbox bridge path to one fixed Paperclip URL. The host adds
 * that route's credential, so the credential never enters the sandbox. Everything here is opt-in:
 * with no relay routes the bridge behaves exactly as before.
 *
 * The route registration is deliberately generic (`path`, `upstreamUrl`, `token`, `deadlineMs`) so
 * other relays (for example memory) can register their own routes on the same list.
 */
import type { SandboxCallbackBridgeRoutePolicy, SandboxCallbackBridgeRouteRule } from "./sandbox-callback-bridge.js";

export const SANDBOX_BRIDGE_RELAY_PATH_PREFIX = "/paperclip-relay/";

/** MCP session headers a relay forwards. Added to the header allowlists only when relay routes exist. */
export const SANDBOX_BRIDGE_RELAY_EXTRA_HEADERS = ["mcp-protocol-version", "mcp-session-id"] as const;

/** Env var the in-sandbox gateway reads for extra allowed header names (comma separated). Empty by default. */
export const SANDBOX_BRIDGE_EXTRA_HEADERS_ENV = "PAPERCLIP_BRIDGE_EXTRA_HEADERS";

const MAX_DEADLINE_MS = 10 * 60 * 1000;
// Upstream paths a relay may target: the Paperclip MCP endpoints only.
const ALLOWED_UPSTREAM_PATH = /^\/(?:api\/)?mcp\/[A-Za-z0-9_./-]+$/;
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", ...SANDBOX_BRIDGE_RELAY_EXTRA_HEADERS] as const;
const RELAY_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "allow"] as const;

export interface SandboxBridgeRelayRoute {
  /** The exact in-sandbox bridge path. Must start with {@link SANDBOX_BRIDGE_RELAY_PATH_PREFIX}. */
  path: string;
  /** The Paperclip URL the sandbox is meant to reach. Only its path is used; the origin is the host API. */
  upstreamUrl: string;
  /** The credential this route injects as a bearer token. Held on the host only. */
  token: string;
  /** The give-up deadline for one relayed request. */
  deadlineMs: number;
  /** Concurrent requests this route may run on the file bridge. Defaults to 4, its own lane. */
  maxConcurrent?: number;
  /** A short label for give-up messages. Never a credential. */
  label?: string;
}

/**
 * The file bridge route policies for relay routes. Each route gets its own lane and an in-pod response deadline
 * a margin above the relay's give-up deadline, so the relay's JSON-RPC 504 reaches the client before the host abort
 * (counted from when the host reads the request) or the in-pod gateway deadline (counted from enqueue).
 * The duplex (HTTP/2) transport ignores policies; the relay deadline alone applies there.
 */
export const SANDBOX_BRIDGE_RELAY_POLICY_MARGIN_MS = 5_000;
export function sandboxBridgeRelayRoutePolicies(
  routes: readonly SandboxBridgeRelayRoute[],
): SandboxCallbackBridgeRoutePolicy[] {
  return routes.map((route) => ({
    path: new RegExp(`^${route.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    deadlineMs: route.deadlineMs + SANDBOX_BRIDGE_RELAY_POLICY_MARGIN_MS,
    maxConcurrent: route.maxConcurrent ?? 4,
  }));
}

export interface SandboxBridgeRelayRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

export interface SandboxBridgeRelayResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function validateSandboxBridgeRelayRoutes(routes: readonly SandboxBridgeRelayRoute[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    if (!route.path.startsWith(SANDBOX_BRIDGE_RELAY_PATH_PREFIX) || !/^[A-Za-z0-9_./-]+$/.test(route.path) || route.path.includes("..")) {
      throw new Error("Invalid sandbox bridge relay path");
    }
    if (seen.has(route.path)) throw new Error("Duplicate sandbox bridge relay path");
    seen.add(route.path);
    if (!route.token || /[\r\n\0]/.test(route.token)) throw new Error("Invalid sandbox bridge relay credential");
    if (!Number.isFinite(route.deadlineMs) || route.deadlineMs <= 0 || route.deadlineMs > MAX_DEADLINE_MS) {
      throw new Error("Invalid sandbox bridge relay deadline");
    }
    let parsed: URL;
    try {
      parsed = new URL(route.upstreamUrl);
    } catch {
      throw new Error("Invalid sandbox bridge relay upstream URL");
    }
    if (!ALLOWED_UPSTREAM_PATH.test(parsed.pathname)) throw new Error("Invalid sandbox bridge relay upstream path");
  }
}

/** Route rules for the host route allowlists: GET, POST and DELETE on each relay path, nothing else. */
export function sandboxBridgeRelayRouteRules(
  routes: readonly SandboxBridgeRelayRoute[],
): SandboxCallbackBridgeRouteRule[] {
  return routes.flatMap((route) => {
    const path = new RegExp(`^${route.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    return ["GET", "POST", "DELETE"].map((method) => ({ method, path }));
  });
}

function jsonRpcIdOf(body: string | Buffer | undefined): { id: unknown; method: string | null } {
  try {
    const parsed = JSON.parse(typeof body === "string" ? body : (body ?? Buffer.alloc(0)).toString("utf8")) as {
      id?: unknown;
      method?: unknown;
    };
    return { id: parsed.id ?? null, method: typeof parsed.method === "string" ? parsed.method : null };
  } catch {
    return { id: null, method: null };
  }
}

/**
 * A relay give-up is a JSON-RPC error body on a 504, not the bridge's "indeterminate" 409/504 marker
 * that an MCP client reports as a bare transport error. A tool call that was already dispatched may have
 * completed upstream, so its error says so.
 */
export function buildSandboxBridgeRelayGiveUp(input: {
  label: string;
  reason: "deadline_exceeded" | "upstream_unreachable" | "aborted" | "response_unreadable";
  deadlineMs: number;
  request: Pick<SandboxBridgeRelayRequest, "body">;
}): SandboxBridgeRelayResponse {
  const { id, method } = jsonRpcIdOf(input.request.body);
  const callMayHaveCompleted = method === "tools/call";
  const what =
    input.reason === "deadline_exceeded"
      ? `the Paperclip bridge gave up after ${Math.round(input.deadlineMs / 1000)}s waiting for "${input.label}"`
      : input.reason === "aborted"
        ? `the Paperclip bridge stopped waiting for "${input.label}" because the request was cancelled`
        : input.reason === "response_unreadable"
          ? `the Paperclip bridge could not read the response from "${input.label}" (it was too large or the stream failed)`
          : `the Paperclip bridge could not reach "${input.label}"`;
  const message = `${what}${callMayHaveCompleted ? "; the tool call may or may not have completed" : ""}`;
  return {
    status: 504,
    headers: { "content-type": "application/json" },
    body: Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message,
          data: {
            source: "paperclip_bridge",
            reason: `bridge_${input.reason}`,
            deadlineMs: input.deadlineMs,
            ...(callMayHaveCompleted ? { outcome: "indeterminate" } : {}),
          },
        },
      }),
      "utf8",
    ),
  };
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Create the host-side relay handler. `handle` returns `null` for a path that is not a relay route, so the
 * caller falls through to its normal forward. Responses are fully buffered through the caller's `readBody`.
 */
export function createSandboxBridgeRelay(input: {
  routes: readonly SandboxBridgeRelayRoute[];
  /** The host API origin the upstream path is rebased onto (the in-process listen address). */
  hostApiUrl: string;
  runId: string;
  fetchImpl?: typeof fetch;
}): {
  handle(
    request: SandboxBridgeRelayRequest,
    options: { signal?: AbortSignal; readBody: (response: Response) => Promise<Buffer> },
  ): Promise<SandboxBridgeRelayResponse | null>;
} {
  validateSandboxBridgeRelayRoutes(input.routes);
  const byPath = new Map(input.routes.map((route) => [route.path, route]));
  const doFetch = input.fetchImpl ?? fetch;
  return {
    async handle(request, { signal, readBody }) {
      const route = byPath.get(request.path);
      if (!route) return null;
      const method = request.method.trim().toUpperCase();
      const label = route.label ?? "MCP server";
      if (method !== "POST") {
        // The gateway is stateless JSON: it issues no session id and has no event stream. GET (stream) and
        // DELETE (session close) are answered here with a 405 (Allow: POST, like the gateway's GET), never forwarded.
        return {
          status: 405,
          headers: { allow: "POST", "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: "Method not allowed; this MCP endpoint accepts POST only." }), "utf8"),
        };
      }
      const upstream = new URL(new URL(route.upstreamUrl).pathname, input.hostApiUrl);
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = headerValue(request.headers, name);
        if (value) headers.set(name, value);
      }
      headers.set("authorization", `Bearer ${route.token}`);
      headers.set("x-paperclip-run-id", input.runId);
      const timeoutSignal = AbortSignal.timeout(route.deadlineMs);
      const forwardSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      let response: Response;
      try {
        response = await doFetch(upstream, {
          method,
          headers,
          body: request.body as BodyInit | undefined,
          signal: forwardSignal,
          redirect: "manual",
        });
      } catch {
        const reason = timeoutSignal.aborted ? "deadline_exceeded" : signal?.aborted ? "aborted" : "upstream_unreachable";
        return buildSandboxBridgeRelayGiveUp({ label, reason, deadlineMs: route.deadlineMs, request });
      }
      let body: Buffer;
      try {
        body = await readBody(response);
      } catch (error) {
        // The upstream already received the request, and a relayed POST may be a tool call that ran. A capacity
        // denial is therefore not answered with the bridge's retryable 503 (a client retry could repeat the call);
        // every read failure becomes a give-up that says the outcome is unknown.
        void error;
        const reason = timeoutSignal.aborted ? "deadline_exceeded" : signal?.aborted ? "aborted" : "response_unreadable";
        return buildSandboxBridgeRelayGiveUp({ label, reason, deadlineMs: route.deadlineMs, request });
      }
      const outHeaders: Record<string, string> = {};
      for (const name of RELAY_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value && value.trim().length > 0) outHeaders[name] = value.trim();
      }
      return { status: response.status, headers: outHeaders, body };
    },
  };
}
