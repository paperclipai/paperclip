import {
  MCP_CONNECTOR_MAX_REQUEST_BODY_BYTES,
  MCP_CONNECTOR_MAX_RESPONSE_BODY_BYTES,
  MCP_CONNECTOR_RESPONSE_HEADER_ALLOWLIST,
  isRelayableMcpConnectorRequestHeader,
  type McpConnectorErrorFrame,
  type McpConnectorRequestFrame,
  type McpConnectorResponseFrame,
} from "@paperclipai/shared/mcp-connector-protocol";
import type { UpstreamConfig } from "./config.js";

export type RelayResult = McpConnectorResponseFrame | McpConnectorErrorFrame;

export interface RelayOptions {
  fetch?: typeof fetch;
  maxResponseBytes?: number;
}

function errorFrame(id: string, code: McpConnectorErrorFrame["code"], message: string): McpConnectorErrorFrame {
  return { type: "error", id, code, message };
}

/** Does this SSE event carry the JSON-RPC response for `rpcId`? */
function eventAnswers(event: string, rpcId: string | number): boolean {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return false;
  try {
    const message = JSON.parse(data) as Record<string, unknown>;
    return message?.id === rpcId && ("result" in message || "error" in message);
  } catch {
    return false;
  }
}

/**
 * Read an upstream response body with a hard byte limit. An SSE stream is
 * read only until the JSON-RPC response for the request arrives, so a server
 * that keeps the stream open does not hold the relay until the timeout.
 */
async function readBody(
  response: Response,
  rpcId: string | number | null,
  maxBytes: number,
): Promise<string | "too_large"> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const isStream = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  const decoder = new TextDecoder();
  let body = "";
  let scanned = 0;
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        if (bytes > maxBytes) return "too_large";
        body += decoder.decode(value, { stream: true });
      }
      if (done) break;
      if (isStream && rpcId !== null) {
        const normalized = body.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = normalized.indexOf("\n\n", scanned)) >= 0) {
          const event = normalized.slice(scanned, boundary);
          scanned = boundary + 2;
          if (eventAnswers(event, rpcId)) return normalized.slice(0, scanned);
        }
      }
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Relay one request frame to a LOCALLY configured upstream.
 *
 * `upstreams` comes only from the connector's own config. The frame names an
 * upstream; it can never supply a URL, host, port or path. Unknown names are
 * refused before any network activity.
 */
export async function relayRequest(
  frame: McpConnectorRequestFrame,
  upstreams: ReadonlyMap<string, UpstreamConfig>,
  signal: AbortSignal,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const upstream = upstreams.get(frame.upstream);
  if (!upstream) return errorFrame(frame.id, "upstream_unknown", "Unknown upstream");
  if (frame.body !== null && Buffer.byteLength(frame.body, "utf8") > MCP_CONNECTOR_MAX_REQUEST_BODY_BYTES) {
    return errorFrame(frame.id, "request_too_large", "Request body exceeds the connector limit");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(frame.headers)) {
    if (isRelayableMcpConnectorRequestHeader(name) && !/[\r\n\0]/.test(value)) headers[name.toLowerCase()] = value;
  }
  // Locally configured headers win: credentials defined on the connector are authoritative.
  Object.assign(headers, upstream.headers);
  const timeout = AbortSignal.timeout(frame.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(upstream.url, {
      method: frame.method,
      headers,
      body: frame.method === "POST" ? frame.body ?? undefined : undefined,
      // Redirects are not followed: the connector reaches only the configured URL.
      redirect: "manual",
      signal: combined,
    });
  } catch {
    return timeout.aborted
      ? errorFrame(frame.id, "upstream_timeout", "Upstream did not answer in time")
      : errorFrame(frame.id, "upstream_unreachable", "Upstream could not be reached");
  }
  let body: string | "too_large";
  try {
    body = await readBody(response, frame.rpcId, options.maxResponseBytes ?? MCP_CONNECTOR_MAX_RESPONSE_BODY_BYTES);
  } catch {
    return timeout.aborted
      ? errorFrame(frame.id, "upstream_timeout", "Upstream did not answer in time")
      : errorFrame(frame.id, "upstream_unreachable", "Upstream response could not be read");
  }
  if (body === "too_large") return errorFrame(frame.id, "response_too_large", "Upstream response exceeds the connector limit");
  const responseHeaders: Record<string, string> = {};
  for (const name of MCP_CONNECTOR_RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name);
    if (value !== null) responseHeaders[name] = value;
  }
  return { type: "response", id: frame.id, status: response.status, headers: responseHeaders, body };
}
