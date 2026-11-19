/**
 * Wire contract between the Paperclip server and the outbound MCP connector
 * (`@paperclipai/mcp-connector`). See `doc/connections/MCP-CONNECTOR.md`.
 *
 * The connector runs inside a private network, dials OUT to Paperclip over a
 * WebSocket, and relays governed MCP Streamable HTTP requests to upstream MCP
 * servers that are named in the connector's own local config. Paperclip only
 * ever addresses an upstream by name: the upstream URL is never sent by the
 * server, so the connector is not a generic proxy.
 *
 * This module is intentionally dependency-free so the standalone connector can
 * bundle it without pulling in the rest of `@paperclipai/shared`.
 */

export const MCP_CONNECTOR_PROTOCOL_VERSION = 1;

/** WebSocket endpoint the connector dials. Authenticated with the connector credential. */
export const MCP_CONNECTOR_WS_PATH = "/api/mcp-connectors/connect";
/** One-time enrollment: exchanges an enrollment token for a long-lived credential. */
export const MCP_CONNECTOR_ENROLL_PATH = "/api/mcp-connectors/enroll";
/** Connector-initiated credential rotation. Authenticated with the current credential. */
export const MCP_CONNECTOR_ROTATE_PATH = "/api/mcp-connectors/credential/rotate";

export const MCP_CONNECTOR_STATUSES = ["pending", "active", "revoked"] as const;
export type McpConnectorStatus = (typeof MCP_CONNECTOR_STATUSES)[number];

/** Enrollment tokens are short-lived; the default is one hour. */
export const MCP_CONNECTOR_ENROLLMENT_TTL_MS = 60 * 60_000;
export const MCP_CONNECTOR_ENROLLMENT_TOKEN_PREFIX = "pcmce_";
export const MCP_CONNECTOR_CREDENTIAL_PREFIX = "pcmcc_";

/** Size limits apply in both directions so neither side can exhaust the other. */
export const MCP_CONNECTOR_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const MCP_CONNECTOR_MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
/** Upper bound for a single WebSocket frame (response body plus JSON envelope). */
export const MCP_CONNECTOR_MAX_FRAME_BYTES = MCP_CONNECTOR_MAX_RESPONSE_BODY_BYTES + 256 * 1024;
export const MCP_CONNECTOR_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const MCP_CONNECTOR_MAX_REQUEST_TIMEOUT_MS = 10 * 60_000;
export const MCP_CONNECTOR_MAX_IN_FLIGHT_REQUESTS = 32;
export const MCP_CONNECTOR_MAX_UPSTREAMS = 64;
export const MCP_CONNECTOR_HELLO_TIMEOUT_MS = 10_000;

/** WebSocket close codes used by the server. */
export const MCP_CONNECTOR_CLOSE_CODES = {
  revoked: 4001,
  unauthorized: 4003,
  protocolError: 4002,
  replaced: 4004,
  helloTimeout: 4008,
} as const;

const UPSTREAM_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function isValidMcpConnectorUpstreamName(value: unknown): value is string {
  return typeof value === "string" && UPSTREAM_NAME_PATTERN.test(value);
}

/**
 * Request headers the server must never relay, and the connector must drop
 * again on its side: transport, hop-by-hop, cookie and proxy/browser headers.
 */
const FORBIDDEN_REQUEST_HEADER_NAMES = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "cookie",
  "expect",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

export function isRelayableMcpConnectorRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower)) return false;
  if (FORBIDDEN_REQUEST_HEADER_NAMES.has(lower)) return false;
  if (lower.startsWith("proxy-") || lower.startsWith("sec-")) return false;
  return true;
}

/** Response headers the connector relays back. Everything else is dropped. */
export const MCP_CONNECTOR_RESPONSE_HEADER_ALLOWLIST = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "www-authenticate",
  "retry-after",
  "x-request-id",
] as const;

export type McpConnectorHttpMethod = "POST" | "DELETE";

/** connector → server, first frame after the socket opens. */
export interface McpConnectorHelloFrame {
  type: "hello";
  protocolVersion: number;
  version: string;
  /** Upstream NAMES only. URLs stay on the connector. */
  upstreams: string[];
}

/** server → connector, answer to a valid hello. */
export interface McpConnectorWelcomeFrame {
  type: "welcome";
  connectorId: string;
  companyId: string;
  protocolVersion: number;
}

/** server → connector: relay one Streamable HTTP request to a named upstream. */
export interface McpConnectorRequestFrame {
  type: "request";
  id: string;
  upstream: string;
  method: McpConnectorHttpMethod;
  headers: Record<string, string>;
  body: string | null;
  /** JSON-RPC id carried by the body, so SSE responses can stop at the matching message. */
  rpcId: string | number | null;
  timeoutMs: number;
}

/** server → connector: abandon an in-flight request (timeout or revoke). */
export interface McpConnectorCancelFrame {
  type: "cancel";
  id: string;
}

/** connector → server: the upstream answered. */
export interface McpConnectorResponseFrame {
  type: "response";
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const MCP_CONNECTOR_ERROR_CODES = [
  "upstream_unknown",
  "upstream_unreachable",
  "upstream_timeout",
  "response_too_large",
  "request_too_large",
  "bad_request",
  "busy",
] as const;
export type McpConnectorErrorCode = (typeof MCP_CONNECTOR_ERROR_CODES)[number];

/** connector → server: the request could not be relayed. */
export interface McpConnectorErrorFrame {
  type: "error";
  id: string;
  code: McpConnectorErrorCode;
  message: string;
}

export type McpConnectorServerFrame =
  | McpConnectorWelcomeFrame
  | McpConnectorRequestFrame
  | McpConnectorCancelFrame;
export type McpConnectorClientFrame =
  | McpConnectorHelloFrame
  | McpConnectorResponseFrame
  | McpConnectorErrorFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isFrameId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** Strict parser for frames the SERVER receives. Returns null for anything malformed. */
export function parseMcpConnectorClientFrame(raw: string): McpConnectorClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "hello": {
      if (typeof value.protocolVersion !== "number") return null;
      if (typeof value.version !== "string" || value.version.length > 64) return null;
      if (!Array.isArray(value.upstreams) || value.upstreams.length > MCP_CONNECTOR_MAX_UPSTREAMS) return null;
      if (!value.upstreams.every(isValidMcpConnectorUpstreamName)) return null;
      return {
        type: "hello",
        protocolVersion: value.protocolVersion,
        version: value.version,
        upstreams: [...new Set(value.upstreams as string[])].sort(),
      };
    }
    case "response": {
      if (!isFrameId(value.id)) return null;
      if (typeof value.status !== "number" || !Number.isInteger(value.status) || value.status < 100 || value.status > 599) return null;
      if (!isStringRecord(value.headers) || typeof value.body !== "string") return null;
      return { type: "response", id: value.id, status: value.status, headers: value.headers, body: value.body };
    }
    case "error": {
      if (!isFrameId(value.id)) return null;
      const code = (MCP_CONNECTOR_ERROR_CODES as readonly string[]).includes(String(value.code))
        ? (value.code as McpConnectorErrorCode)
        : "upstream_unreachable";
      const message = typeof value.message === "string" ? value.message.slice(0, 300) : "Connector request failed";
      return { type: "error", id: value.id, code, message };
    }
    default:
      return null;
  }
}

/** Strict parser for frames the CONNECTOR receives. Returns null for anything malformed. */
export function parseMcpConnectorServerFrame(raw: string): McpConnectorServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "welcome":
      if (typeof value.connectorId !== "string" || typeof value.companyId !== "string") return null;
      return {
        type: "welcome",
        connectorId: value.connectorId,
        companyId: value.companyId,
        protocolVersion: typeof value.protocolVersion === "number" ? value.protocolVersion : 0,
      };
    case "cancel":
      return isFrameId(value.id) ? { type: "cancel", id: value.id } : null;
    case "request": {
      if (!isFrameId(value.id)) return null;
      // The upstream is a NAME. Anything shaped like a URL fails this check.
      if (!isValidMcpConnectorUpstreamName(value.upstream)) return null;
      if (value.method !== "POST" && value.method !== "DELETE") return null;
      if (!isStringRecord(value.headers)) return null;
      if (value.body !== null && typeof value.body !== "string") return null;
      const rpcId = typeof value.rpcId === "string" || typeof value.rpcId === "number" ? value.rpcId : null;
      const timeoutMs = typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
        ? Math.min(Math.max(value.timeoutMs, 1_000), MCP_CONNECTOR_MAX_REQUEST_TIMEOUT_MS)
        : MCP_CONNECTOR_DEFAULT_REQUEST_TIMEOUT_MS;
      return {
        type: "request",
        id: value.id,
        upstream: value.upstream,
        method: value.method,
        headers: value.headers,
        body: value.body as string | null,
        rpcId,
        timeoutMs,
      };
    }
    default:
      return null;
  }
}

/** `<prefix><connectorId>.<secret>`; the id lets the server find the row, the secret is compared by hash. */
export function parseMcpConnectorToken(
  token: string,
  prefix: typeof MCP_CONNECTOR_ENROLLMENT_TOKEN_PREFIX | typeof MCP_CONNECTOR_CREDENTIAL_PREFIX,
): { connectorId: string; secret: string } | null {
  if (typeof token !== "string" || !token.startsWith(prefix) || token.length > 256) return null;
  const rest = token.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const connectorId = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(connectorId) || !/^[A-Za-z0-9_-]{32,}$/.test(secret)) return null;
  return { connectorId, secret };
}
