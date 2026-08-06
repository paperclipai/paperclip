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
//
// Spec-compliant servers that keep a session also require an initialize
// handshake before tools/list or tools/call. The server may return an
// `mcp-session-id` response header; subsequent requests must echo it. The
// local stdio path in tool-gateway.ts already does initialize +
// notifications/initialized — openMcpHttpSession mirrors that for HTTP.
// Handshake failures are fail-soft: many real-world servers ignore sessions
// and already work without initialize, so a broken handshake must not block
// the subsequent tools/list or tools/call.

/** The Accept header value required by the MCP Streamable HTTP transport. */
export const MCP_HTTP_ACCEPT = "application/json, text/event-stream";

/** Session mechanics (mcp-session-id) arrived with the 2025-03-26 revision. */
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_CLIENT_NAME = "paperclip";
const DEFAULT_CLIENT_VERSION = "0.3.1";
/** Initialize responses are small; refuse oversized bodies fail-soft. */
const MAX_INITIALIZE_RESPONSE_BYTES = 64 * 1024;

export interface McpHttpSession {
  /** Value of the mcp-session-id header, or null when the server is session-less. */
  sessionId: string | null;
  /** Protocol version negotiated by the server (sent on later requests). */
  protocolVersion: string | null;
}

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
 * Attach session / negotiated protocol headers when present. Does not mutate input.
 */
export function withMcpSessionHeader(
  headers: Record<string, string>,
  sessionId: string | null,
  protocolVersion?: string | null,
): Record<string, string> {
  const next = { ...headers };
  if (sessionId) next["mcp-session-id"] = sessionId;
  if (protocolVersion) next["mcp-protocol-version"] = protocolVersion;
  return next;
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

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort; never let cleanup fail the handshake.
  }
}

/**
 * Read a response body up to `maxBytes`. Oversized or unreadable bodies return
 * null after discarding leftover bytes (fail-soft for initialize).
 */
async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string | null> {
  try {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > maxBytes) {
        await discardResponseBody(response);
        return null;
      }
    }
    if (!response.body) {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
      return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        return null;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  } catch {
    await discardResponseBody(response);
    return null;
  }
}

/**
 * Open an MCP Streamable HTTP session via the initialize handshake.
 *
 * Fail-soft: any HTTP error, redirect, network failure, or unparseable body
 * returns `{ sessionId: null, protocolVersion: null }` instead of throwing, so
 * session-less / non-compliant servers keep working exactly as before.
 *
 * Both handshake requests use `redirect: "manual"` so a remote 3xx cannot bypass
 * the caller's endpoint allowlist or leak credential headers cross-origin.
 */
export async function openMcpHttpSession(input: {
  endpoint: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  clientName?: string;
  clientVersion?: string;
}): Promise<McpHttpSession> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const clientName = input.clientName ?? DEFAULT_CLIENT_NAME;
  const clientVersion = input.clientVersion ?? DEFAULT_CLIENT_VERSION;

  try {
    const response = await fetchImpl(input.endpoint, {
      method: "POST",
      redirect: "manual",
      headers: mcpHttpRequestHeaders(input.headers),
      signal: input.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "paperclip-mcp-initialize",
        method: "initialize",
        params: {
          protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: clientName, version: clientVersion },
        },
      }),
    });

    // 3xx (and any non-2xx): do not follow; treat as session-less.
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      await discardResponseBody(response);
      return { sessionId: null, protocolVersion: null };
    }

    const sessionId = response.headers.get("mcp-session-id") || null;
    let protocolVersion: string | null = null;
    const bodyText = await readBoundedResponseText(response, MAX_INITIALIZE_RESPONSE_BYTES);
    if (bodyText) {
      try {
        const payload = parseMcpHttpResponseBody(bodyText, response.headers.get("content-type"));
        if (typeof payload === "object" && payload !== null) {
          const result = (payload as { result?: unknown }).result;
          if (typeof result === "object" && result !== null) {
            const version = (result as { protocolVersion?: unknown }).protocolVersion;
            if (typeof version === "string") protocolVersion = version;
          }
        }
      } catch {
        // Body parse failure is still fail-soft for the overall handshake, but
        // keep any session id the server already advertised on the response.
      }
    }

    if (sessionId) {
      // notifications/initialized is a notification (no `id`). Servers may
      // answer with 202 and an empty body — discard the response body.
      try {
        const notifyResponse = await fetchImpl(input.endpoint, {
          method: "POST",
          redirect: "manual",
          headers: mcpHttpRequestHeaders(
            withMcpSessionHeader(input.headers, sessionId, protocolVersion),
          ),
          signal: input.signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {},
          }),
        });
        await discardResponseBody(notifyResponse);
      } catch {
        // Notification delivery is best-effort; the session id is still usable.
      }
    }

    return { sessionId, protocolVersion };
  } catch {
    return { sessionId: null, protocolVersion: null };
  }
}

/**
 * Best-effort session teardown. Spec-compliant servers accept DELETE with
 * mcp-session-id. Never throws; never waits on a response body.
 */
export async function closeMcpHttpSession(input: {
  endpoint: string;
  headers: Record<string, string>;
  sessionId: string;
  protocolVersion?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    const response = await (input.fetchImpl ?? fetch)(input.endpoint, {
      method: "DELETE",
      redirect: "manual",
      headers: mcpHttpRequestHeaders(
        withMcpSessionHeader(input.headers, input.sessionId, input.protocolVersion),
      ),
      signal: input.signal,
    });
    await discardResponseBody(response);
  } catch {
    // Best-effort only.
  }
}
