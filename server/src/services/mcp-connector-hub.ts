import { randomUUID } from "node:crypto";
import {
  MCP_CONNECTOR_CLOSE_CODES,
  MCP_CONNECTOR_DEFAULT_REQUEST_TIMEOUT_MS,
  MCP_CONNECTOR_MAX_IN_FLIGHT_REQUESTS,
  MCP_CONNECTOR_MAX_REQUEST_BODY_BYTES,
  MCP_CONNECTOR_MAX_REQUEST_TIMEOUT_MS,
  MCP_CONNECTOR_MAX_RESPONSE_BODY_BYTES,
  MCP_CONNECTOR_RESPONSE_HEADER_ALLOWLIST,
  isRelayableMcpConnectorRequestHeader,
  isValidMcpConnectorUpstreamName,
  type McpConnectorClientFrame,
  type McpConnectorErrorCode,
  type McpConnectorRequestFrame,
} from "@paperclipai/shared";

/**
 * Relay failures surfaced to the gateway. Messages are fixed strings: nothing
 * from the connector or the upstream is echoed, so no upstream content or
 * credential can leak into health messages, activity or API errors.
 */
export type McpConnectorRelayErrorCode =
  | "connector_offline"
  | "connector_revoked"
  | "connector_not_found"
  | "connector_upstream_unknown"
  | "connector_upstream_unreachable"
  | "connector_timeout"
  | "connector_response_too_large"
  | "connector_request_too_large"
  | "connector_busy"
  | "connector_protocol_error";

const RELAY_ERROR_MESSAGES: Record<McpConnectorRelayErrorCode, { status: number; message: string }> = {
  connector_offline: { status: 503, message: "The MCP connector for this connection is offline." },
  connector_revoked: { status: 503, message: "The MCP connector for this connection was revoked." },
  connector_not_found: { status: 422, message: "The MCP connector for this connection does not exist in this company." },
  connector_upstream_unknown: { status: 422, message: "The MCP connector does not publish this upstream." },
  connector_upstream_unreachable: { status: 502, message: "The MCP connector could not reach its upstream MCP server." },
  connector_timeout: { status: 504, message: "The MCP connector did not answer in time." },
  connector_response_too_large: { status: 502, message: "The upstream response exceeded the MCP connector size limit." },
  connector_request_too_large: { status: 413, message: "The request exceeded the MCP connector size limit." },
  connector_busy: { status: 503, message: "The MCP connector has too many requests in flight." },
  connector_protocol_error: { status: 502, message: "The MCP connector sent an invalid response." },
};

export class McpConnectorRelayError extends Error {
  readonly status: number;
  constructor(readonly code: McpConnectorRelayErrorCode) {
    super(RELAY_ERROR_MESSAGES[code].message);
    this.name = "McpConnectorRelayError";
    this.status = RELAY_ERROR_MESSAGES[code].status;
  }
}

function relayErrorFromConnector(code: McpConnectorErrorCode): McpConnectorRelayError {
  switch (code) {
    case "upstream_unknown":
      return new McpConnectorRelayError("connector_upstream_unknown");
    case "upstream_timeout":
      return new McpConnectorRelayError("connector_timeout");
    case "response_too_large":
      return new McpConnectorRelayError("connector_response_too_large");
    case "request_too_large":
      return new McpConnectorRelayError("connector_request_too_large");
    case "busy":
      return new McpConnectorRelayError("connector_busy");
    default:
      return new McpConnectorRelayError("connector_upstream_unreachable");
  }
}

/** Minimal socket surface the hub needs; the `ws` WebSocket satisfies it. */
export interface McpConnectorSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export interface McpConnectorSession {
  readonly connectorId: string;
  readonly companyId: string;
  readonly socket: McpConnectorSocket;
  readonly version: string;
  readonly upstreams: ReadonlySet<string>;
  readonly credential?: string;
  readonly connectedAt: Date;
  readonly pending: Map<string, PendingRequest>;
}

/**
 * Re-validates a connector against the database before every relayed request:
 * it must still exist, belong to `companyId`, be active, and match the session credential.
 * The WS layer installs the database-backed implementation.
 */
export type McpConnectorVerifier = (input: {
  connectorId: string;
  companyId: string;
  credential?: string;
}) => Promise<"active" | "revoked" | "not_found">;

export interface McpConnectorRelayInput {
  companyId: string;
  connectorId: string;
  upstream: string;
  init: RequestInit;
  timeoutMs?: number;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  new Headers(headers).forEach((value, name) => {
    if (isRelayableMcpConnectorRequestHeader(name)) record[name] = value;
  });
  return record;
}

function jsonRpcId(body: string | null): string | number | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed?.id === "string" || typeof parsed?.id === "number" ? parsed.id : null;
  } catch {
    return null;
  }
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export class McpConnectorHub {
  private readonly sessions = new Map<string, McpConnectorSession>();
  private verifier: McpConnectorVerifier | null = null;

  setVerifier(verifier: McpConnectorVerifier | null) {
    this.verifier = verifier;
  }

  /** Register an authenticated session. A newer session for the same connector replaces the older one. */
  attach(session: Omit<McpConnectorSession, "pending" | "connectedAt">): McpConnectorSession {
    const previous = this.sessions.get(session.connectorId);
    if (previous) this.closeSession(previous, MCP_CONNECTOR_CLOSE_CODES.replaced, "replaced", "connector_offline");
    const attached: McpConnectorSession = { ...session, pending: new Map(), connectedAt: new Date() };
    this.sessions.set(session.connectorId, attached);
    return attached;
  }

  /** Called when the socket closes. Only removes the session if it is still the current one. */
  detach(session: McpConnectorSession) {
    if (this.sessions.get(session.connectorId) === session) this.sessions.delete(session.connectorId);
    this.failPending(session, "connector_offline");
  }

  isOnline(connectorId: string): boolean {
    return this.sessions.has(connectorId);
  }

  session(connectorId: string): McpConnectorSession | null {
    return this.sessions.get(connectorId) ?? null;
  }

  /** Revocation or credential reset: close the socket now and fail in-flight calls cleanly. */
  disconnect(
    connectorId: string,
    reason: "revoked" | "reenrolled" = "revoked",
    targetSession?: McpConnectorSession,
  ) {
    const current = this.sessions.get(connectorId);
    const sessionToClose = targetSession ?? current;
    if (!sessionToClose) return;
    if (current === sessionToClose) {
      this.sessions.delete(connectorId);
    }
    this.closeSession(sessionToClose, MCP_CONNECTOR_CLOSE_CODES.revoked, reason, "connector_revoked");
  }

  /** Close every session (server shutdown, tests). */
  disconnectAll() {
    for (const session of [...this.sessions.values()]) {
      this.sessions.delete(session.connectorId);
      this.closeSession(session, 1001, "shutdown", "connector_offline");
    }
  }

  private closeSession(
    session: McpConnectorSession,
    code: number,
    reason: string,
    pendingCode: McpConnectorRelayErrorCode,
  ) {
    this.failPending(session, pendingCode);
    try {
      session.socket.close(code, reason);
    } catch {
      // The socket may already be gone; the pending calls were failed above.
    }
  }

  private failPending(session: McpConnectorSession, code: McpConnectorRelayErrorCode) {
    for (const [id, pending] of session.pending) {
      session.pending.delete(id);
      pending.cleanup();
      pending.reject(new McpConnectorRelayError(code));
    }
  }

  /**
   * Handle a frame received on `session`. Responses are matched only against
   * requests this exact session was sent, so a connector can never answer a
   * request that was dispatched to another connector (or another company).
   */
  handleFrame(session: McpConnectorSession, frame: McpConnectorClientFrame) {
    if (frame.type === "hello") return;
    const pending = session.pending.get(frame.id);
    if (!pending) return;
    session.pending.delete(frame.id);
    pending.cleanup();
    if (frame.type === "error") {
      pending.reject(relayErrorFromConnector(frame.code));
      return;
    }
    if (Buffer.byteLength(frame.body, "utf8") > MCP_CONNECTOR_MAX_RESPONSE_BODY_BYTES) {
      pending.reject(new McpConnectorRelayError("connector_response_too_large"));
      return;
    }
    if (frame.status < 200) {
      pending.reject(new McpConnectorRelayError("connector_protocol_error"));
      return;
    }
    const headers = new Headers();
    for (const name of MCP_CONNECTOR_RESPONSE_HEADER_ALLOWLIST) {
      const value = Object.entries(frame.headers).find(([key]) => key.toLowerCase() === name)?.[1];
      if (value !== undefined && !/[\r\n]/.test(value)) headers.set(name, value.slice(0, 2048));
    }
    try {
      pending.resolve(new Response(NULL_BODY_STATUSES.has(frame.status) ? null : frame.body, {
        status: frame.status,
        headers,
      }));
    } catch {
      pending.reject(new McpConnectorRelayError("connector_protocol_error"));
    }
  }

  /**
   * Relay one MCP Streamable HTTP request to a named upstream behind a
   * connector. Returns a regular `Response` so the existing MCP client code
   * (sessions, SSE parsing, size limits) runs unchanged on top of it.
   */
  async request(input: McpConnectorRelayInput): Promise<Response> {
    if (!isValidMcpConnectorUpstreamName(input.upstream)) {
      throw new McpConnectorRelayError("connector_upstream_unknown");
    }

    let activeSession: McpConnectorSession | undefined;
    while (true) {
      const session = this.sessions.get(input.connectorId);

      if (this.verifier) {
        const state = await this.verifier({
          connectorId: input.connectorId,
          companyId: input.companyId,
          credential: session?.credential,
        });
        if (state === "not_found") throw new McpConnectorRelayError("connector_not_found");
        if (state === "revoked") {
          if (session) this.disconnect(input.connectorId, "revoked", session);
          throw new McpConnectorRelayError("connector_revoked");
        }
      }
      activeSession = this.sessions.get(input.connectorId);
      if (!activeSession) throw new McpConnectorRelayError("connector_offline");
      if (this.verifier && activeSession.credential !== session?.credential) {
        continue;
      }
      break;
    }

    // Company boundary, checked per request against the authenticated session.
    if (activeSession.companyId !== input.companyId) throw new McpConnectorRelayError("connector_not_found");
    if (!activeSession.upstreams.has(input.upstream)) throw new McpConnectorRelayError("connector_upstream_unknown");
    if (activeSession.pending.size >= MCP_CONNECTOR_MAX_IN_FLIGHT_REQUESTS) throw new McpConnectorRelayError("connector_busy");

    const method = (input.init.method ?? "POST").toUpperCase();
    if (method !== "POST" && method !== "DELETE") throw new McpConnectorRelayError("connector_protocol_error");
    const body = input.init.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new McpConnectorRelayError("connector_protocol_error");
    }
    const bodyText = typeof body === "string" ? body : null;
    if (bodyText && Buffer.byteLength(bodyText, "utf8") > MCP_CONNECTOR_MAX_REQUEST_BODY_BYTES) {
      throw new McpConnectorRelayError("connector_request_too_large");
    }
    const signal = input.init.signal ?? null;
    if (signal?.aborted) throw abortError();
    const timeoutMs = Math.min(
      Math.max(input.timeoutMs ?? MCP_CONNECTOR_DEFAULT_REQUEST_TIMEOUT_MS, 1_000),
      MCP_CONNECTOR_MAX_REQUEST_TIMEOUT_MS,
    );
    const frame: McpConnectorRequestFrame = {
      type: "request",
      id: randomUUID(),
      upstream: input.upstream,
      method,
      headers: normalizeHeaders(input.init.headers),
      body: bodyText,
      rpcId: jsonRpcId(bodyText),
      timeoutMs,
    };
    return new Promise<Response>((resolve, reject) => {
      const cancel = () => {
        try {
          activeSession.socket.send(JSON.stringify({ type: "cancel", id: frame.id }));
        } catch {
          // Best effort: the connector also enforces the request timeout.
        }
      };
      const onAbort = () => {
        if (!activeSession.pending.delete(frame.id)) return;
        pendingEntry.cleanup();
        cancel();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (!activeSession.pending.delete(frame.id)) return;
        pendingEntry.cleanup();
        cancel();
        reject(new McpConnectorRelayError("connector_timeout"));
      }, timeoutMs + 1_000);
      timer.unref?.();
      const pendingEntry: PendingRequest = {
        resolve,
        reject,
        timer,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      activeSession.pending.set(frame.id, pendingEntry);
      try {
        activeSession.socket.send(JSON.stringify(frame));
      } catch {
        activeSession.pending.delete(frame.id);
        pendingEntry.cleanup();
        reject(new McpConnectorRelayError("connector_offline"));
      }
    });
  }
}

/** Process-wide hub shared by the WS endpoint, tool access and the tool gateway. */
export const mcpConnectorHub = new McpConnectorHub();

/** Read `{ connectorId, upstream }` from a `transport: "connector"` connection config. */
export function connectorTarget(config: Record<string, unknown> | null | undefined): {
  connectorId: string;
  upstream: string;
} {
  const connectorId = typeof config?.connectorId === "string" ? config.connectorId : "";
  const upstream = typeof config?.upstream === "string" ? config.upstream : "";
  if (!/^[0-9a-f-]{36}$/i.test(connectorId)) throw new McpConnectorRelayError("connector_not_found");
  if (!isValidMcpConnectorUpstreamName(upstream)) throw new McpConnectorRelayError("connector_upstream_unknown");
  return { connectorId, upstream };
}

/** Stable, non-network label used where the MCP client code expects an endpoint string (cache scopes, audit). */
export function connectorEndpointLabel(config: Record<string, unknown> | null | undefined): string {
  const { connectorId, upstream } = connectorTarget(config);
  return `connector://${connectorId}/${upstream}`;
}
