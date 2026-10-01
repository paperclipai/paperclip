import { createHash } from "node:crypto";
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
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export class McpHttpResponseError extends Error {
  constructor(readonly reason: "invalid_json" | "malformed_response" | "too_large", message: string) {
    super(message);
    this.name = "McpHttpResponseError";
  }
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

export class McpHttpInitializationError extends Error {
  constructor(
    message: string,
    readonly stage: "initialize" | "initialized_notification",
    readonly status: number | null,
    readonly response?: Response,
  ) {
    super(message);
    this.name = "McpHttpInitializationError";
  }
}

/**
 * Establish a Streamable HTTP session. Callers may retain protocol headers in
 * the in-memory cache scoped to the connection and effective credential identity.
 */
export async function initializeMcpHttpSession(input: {
  send: (init: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
  requestId: string;
}): Promise<Record<string, string>> {
  const initializeResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders(input.headers),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${input.requestId}-initialize`,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "paperclip", version: "1" },
      },
    }),
  });
  if (!initializeResponse.ok) {
    throw new McpHttpInitializationError(
      `Remote MCP initialization returned HTTP ${initializeResponse.status}`,
      "initialize",
      initializeResponse.status,
      initializeResponse,
    );
  }
  let payload: unknown;
  try {
    payload = await readMcpHttpResponse(initializeResponse, `${input.requestId}-initialize`);
  } catch {
    throw new McpHttpInitializationError("Remote MCP initialization returned an invalid response", "initialize", null);
  }
  const result = payload && typeof payload === "object" && "result" in payload
    ? (payload as { result?: unknown }).result
    : null;
  const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : null;
  if (!resultRecord) throw new McpHttpInitializationError("Remote MCP initialization failed", "initialize", null);
  const protocolVersion = typeof resultRecord?.protocolVersion === "string" && resultRecord.protocolVersion
    ? resultRecord.protocolVersion
    : MCP_PROTOCOL_VERSION;
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  const sessionHeaders: Record<string, string> = {
    ...(input.headers ?? {}),
    "MCP-Protocol-Version": protocolVersion,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
  const initializedResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders(sessionHeaders),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  if (!initializedResponse.ok) {
    throw new McpHttpInitializationError(
      `Remote MCP initialized notification returned HTTP ${initializedResponse.status}`,
      "initialized_notification",
      initializedResponse.status,
    );
  }
  return sessionHeaders;
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

/** Read until the response for this request arrives, without waiting for an SSE
 * connection to close. Notifications and responses for other IDs are ignored. */
export async function readMcpHttpResponse(
  response: Response,
  requestId: string | number,
  options: { maxBytes?: number; onRequest?: (message: Record<string, unknown>) => Promise<void> } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const isStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
  const reader = response.body?.getReader();
  // Injected HTTP transports can expose a buffered text response rather than a
  // Web ReadableStream. Keep the same size and message-ID checks for both forms.
  if (!reader) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new McpHttpResponseError("too_large", "MCP response exceeded the size limit");
    return readMcpHttpResponse(new Response(body, {
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    }), requestId, options);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const parse = (text: string): unknown => {
    try { return JSON.parse(text); }
    catch { throw new McpHttpResponseError("invalid_json", "MCP response contained invalid JSON"); }
  };
  const inspect = async (message: unknown): Promise<unknown | undefined> => {
    if (!message || typeof message !== "object") return undefined;
    const record = message as Record<string, unknown>;
    if (record.id === requestId && ("result" in record || "error" in record)) return record;
    if ("method" in record && "id" in record) await options.onRequest?.(record);
    return undefined;
  };
  const event = async (value: string) => {
    const data = value.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return undefined;
    return inspect(parse(data));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > maxBytes) throw new McpHttpResponseError("too_large", "MCP response exceeded the size limit");
      buffer += decoder.decode(value, { stream: !done });
      if (isStream) {
        // Normalize CRLF after concatenating chunks, including split CR/LF pairs.
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const result = await event(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (result !== undefined) return result;
        }
      }
      if (done) break;
    }
    const result = isStream ? await event(buffer) : await inspect(parse(buffer));
    if (result !== undefined) return result;
    throw new McpHttpResponseError("malformed_response", "MCP response did not contain the requested message ID");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const sessions = new Map<string, { headers: Record<string, string>; expiresAt: number }>();
const initializing = new Map<string, Promise<Record<string, string>>>();
const SESSION_TTL_MS = 30 * 60_000;

/** Cache only protocol headers; credential hashes and scope separate every
 * connection and effective identity. Never cache a tool call or replay a write. */
export async function getMcpHttpSession(input: Parameters<typeof initializeMcpHttpSession>[0] & { scope: string }) {
  const key = `${input.scope}:${createHash("sha256").update(JSON.stringify(Object.entries(input.headers ?? {}).sort())).digest("hex")}`;
  const cached = sessions.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...input.headers, ...cached.headers };
  const pending = initializing.get(key);
  if (pending) return pending;
  const promise = initializeMcpHttpSession(input).then((headers) => {
    if (initializing.get(key) !== promise) throw new Error("MCP connection changed while initializing; reconnect before calling tools");
    for (const [id, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(id);
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
    const protocolHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => ["mcp-session-id", "mcp-protocol-version"].includes(name.toLowerCase())));
    sessions.set(key, { headers: protocolHeaders, expiresAt: Date.now() + SESSION_TTL_MS });
    return headers;
  }).finally(() => { if (initializing.get(key) === promise) initializing.delete(key); });
  initializing.set(key, promise);
  return promise;
}

export function forgetMcpHttpSessions(connectionId: string) {
  for (const key of sessions.keys()) if (key.startsWith(`${connectionId}:`)) sessions.delete(key);
  for (const key of initializing.keys()) if (key.startsWith(`${connectionId}:`)) initializing.delete(key);
}
