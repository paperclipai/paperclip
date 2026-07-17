// Helpers for talking to remote MCP servers over the Streamable HTTP transport.
//
// The MCP Streamable HTTP spec requires the client to advertise that it accepts
// BOTH a single JSON response and an SSE stream on every POST:
//
//   Accept: application/json, text/event-stream
//
// Spec-compliant servers reject requests missing this header with 406 Not
// Acceptable, and when the header is present they are free to answer with an
// SSE stream (`event: message\ndata: {…}`) instead of a bare JSON body. So any
// code path that POSTs JSON-RPC to a remote `/mcp` endpoint must (a) send the
// Accept header and (b) be able to read an SSE-framed response.

/** The Accept header value required by the MCP Streamable HTTP transport. */
export const MCP_HTTP_ACCEPT = "application/json, text/event-stream";

/**
 * Default headers for an MCP Streamable HTTP JSON-RPC POST. Caller-supplied
 * headers (e.g. resolved credentials) are preserved, while the required
 * Streamable HTTP Accept value is kept authoritative.
 */
export function mcpHttpRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    ...extra,
    accept: MCP_HTTP_ACCEPT,
  };
}

/**
 * MCP protocol revision advertised in the `initialize` handshake. Servers
 * negotiate down to a version they support, so advertising a version we speak
 * is safe.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** HTTP response header a stateful server uses to hand back its session id. */
const MCP_SESSION_ID_HEADER = "mcp-session-id";

/**
 * Open a session with a remote MCP server over the Streamable HTTP transport by
 * performing the `initialize` handshake, returning the session id the server
 * assigned (or `null` if it did not assign one).
 *
 * The MCP spec requires `initialize` to be the client's very first message.
 * Stateful servers (the `@modelcontextprotocol/sdk` default) answer it with an
 * `Mcp-Session-Id` response header and then reject every subsequent request that
 * omits it with `400 Bad Request: Server not initialized`; stateless servers
 * simply don't set the header. Callers must therefore run this before any other
 * request and echo the returned id — when present — on those requests.
 *
 * This is best-effort: it returns `null` both for stateless servers and for any
 * failed handshake (including OAuth-guarded 401s and network errors), leaving
 * the caller's follow-up request as the single authoritative error path.
 */
export async function initializeMcpSession(
  endpoint: string | URL,
  headers?: Record<string, string>,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: mcpHttpRequestHeaders(headers),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "paperclip-mcp-initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "paperclip", version: "1.0.0" },
        },
      }),
    });
  } catch {
    // Network failure — let the caller's follow-up request surface it.
    return null;
  }
  if (!response.ok) {
    // Includes OAuth-guarded 401s; the caller's follow-up request owns the
    // authoritative error handling (OAuth discovery, etc.).
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const sessionId = response.headers.get(MCP_SESSION_ID_HEADER);
  await response.text().catch(() => undefined);
  if (sessionId) {
    // Complete the handshake. Required by the spec for stateful servers and
    // harmlessly ignored by stateless ones; failures here are non-fatal.
    await fetch(endpoint, {
      method: "POST",
      headers: { ...mcpHttpRequestHeaders(headers), [MCP_SESSION_ID_HEADER]: sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => undefined);
  }
  return sessionId;
}

/**
 * Best-effort teardown of a session opened by {@link initializeMcpSession}.
 *
 * The MCP spec says a client SHOULD `DELETE` the session once it is no longer
 * needed; without this, stateful servers accumulate a dead session for every
 * catalog refresh / connection check. Failures — including servers that don't
 * support explicit termination and answer `405` — are ignored, since the
 * session will expire server-side regardless.
 */
export async function closeMcpSession(
  endpoint: string | URL,
  headers: Record<string, string> | undefined,
  sessionId: string,
): Promise<void> {
  try {
    const response = await fetch(endpoint, {
      method: "DELETE",
      headers: { ...mcpHttpRequestHeaders(headers), [MCP_SESSION_ID_HEADER]: sessionId },
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Teardown is best-effort.
  }
}

function looksLikeJsonRpcMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "result" in record || "error" in record || "method" in record || "id" in record;
}

/**
 * Parse the body of an MCP Streamable HTTP response into its JSON-RPC payload.
 *
 * Handles both response shapes the transport allows:
 *  - `application/json`: the body is the JSON-RPC message directly.
 *  - `text/event-stream`: one or more SSE events; we return the JSON payload of
 *    the first `data:` event that parses as a JSON-RPC message.
 *
 * Falls back to a plain JSON parse when the content type is unknown so we stay
 * compatible with non-compliant servers that ignore the Accept header.
 */
export function parseMcpHttpResponseBody(bodyText: string, contentType: string | null): unknown {
  const isEventStream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (!isEventStream) {
    return JSON.parse(bodyText) as unknown;
  }

  // Split the SSE stream into events on blank lines, then collect each event's
  // `data:` lines (which may span multiple lines per the SSE spec).
  const events = bodyText.replace(/\r\n/g, "\n").split(/\n\n+/);
  let lastError: unknown = null;
  let firstParsed: unknown;
  let sawData = false;
  for (const event of events) {
    const dataLines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!sawData) {
      firstParsed = parsed;
      sawData = true;
    }
    if (looksLikeJsonRpcMessage(parsed)) {
      return parsed;
    }
  }
  if (sawData) return firstParsed;
  if (lastError) throw lastError;
  throw new SyntaxError("MCP SSE response contained no data events");
}
