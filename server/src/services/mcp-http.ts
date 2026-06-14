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
 * headers (e.g. resolved credentials) are spread last so they can override.
 */
export function mcpHttpRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: MCP_HTTP_ACCEPT,
    ...extra,
  };
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
