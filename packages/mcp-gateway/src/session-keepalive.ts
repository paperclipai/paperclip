/**
 * MCP session-keepalive primitives.
 *
 * Streamable HTTP MCP (proto 2025-03-26) is stateful: client and server
 * agree on a session id (`Mcp-Session-Id` header) at `initialize`.
 * Subsequent calls must carry the same id; if the server has GC'd the
 * session (idle timeout, restart, etc.) it returns 404 with body
 * `{ error: "Session not found" }`. Claude Code's MCP client doesn't
 * auto-retry on this — the next tool call surfaces the 404 to the user.
 *
 * This module owns the gateway-side fix: when the upstream returns
 * 404 Session-not-found, we replay the cached `initialize` request,
 * parse the new upstream session id from the response, update our
 * client→upstream id mapping, and replay the original failing call
 * with the fresh upstream id. The client never sees the 404 and keeps
 * its own session id stable across upstream rotations.
 *
 * The mapping is purely in-memory in the gateway pod. If the gateway
 * pod restarts, all client sessions across all upstreams are lost —
 * the client's *next* `initialize` call will simply mint a fresh
 * upstream session, so the failure mode is graceful.
 */

import { randomUUID } from "node:crypto";

export interface SessionRecord {
  /** Stable session id we expose to the client. */
  clientSessionId: string;
  /** Current upstream session id; rotates when we replay initialize. */
  upstreamSessionId: string;
  /** Cached request body of the original `initialize` call, replayed on session-not-found. */
  initializePayload: Buffer | null;
  /** Timestamp of last successful forward; used for sweeping abandoned sessions. */
  lastSeenMs: number;
}

export interface SessionStoreOpts {
  /** Sessions idle longer than this are GC'd. Default 1 hour. */
  idleTtlMs?: number;
  /** Hard cap on session count to bound memory; oldest evicted first. Default 4096. */
  maxSessions?: number;
}

/**
 * In-memory map of clientSessionId → SessionRecord, scoped per upstream.
 * Two clients hitting different upstreams (e.g. /figma + /linear) will
 * use the same client session id format but their records live in
 * separate maps so a 404 from figma doesn't accidentally rotate
 * linear's session.
 */
export class SessionStore {
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  private readonly records = new Map<string, SessionRecord>();

  constructor(opts: SessionStoreOpts = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? 60 * 60 * 1000;
    this.maxSessions = opts.maxSessions ?? 4096;
  }

  get(clientSessionId: string): SessionRecord | undefined {
    const record = this.records.get(clientSessionId);
    if (!record) return undefined;
    if (this.isExpired(record)) {
      this.records.delete(clientSessionId);
      return undefined;
    }
    record.lastSeenMs = Date.now();
    return record;
  }

  /** Create a fresh session record for a brand-new initialize. */
  createInitialized(args: {
    clientSessionId?: string;
    upstreamSessionId: string;
    initializePayload: Buffer;
  }): SessionRecord {
    const id = args.clientSessionId ?? randomUUID();
    const record: SessionRecord = {
      clientSessionId: id,
      upstreamSessionId: args.upstreamSessionId,
      initializePayload: args.initializePayload,
      lastSeenMs: Date.now(),
    };
    this.records.set(id, record);
    this.evictIfNeeded();
    return record;
  }

  /** After replaying initialize, swap to the new upstream session id. */
  rotateUpstream(clientSessionId: string, upstreamSessionId: string): SessionRecord | undefined {
    const record = this.records.get(clientSessionId);
    if (!record) return undefined;
    record.upstreamSessionId = upstreamSessionId;
    record.lastSeenMs = Date.now();
    return record;
  }

  delete(clientSessionId: string): void {
    this.records.delete(clientSessionId);
  }

  size(): number {
    return this.records.size;
  }

  /** Visible-for-testing iterator. */
  *all(): IterableIterator<SessionRecord> {
    for (const r of this.records.values()) yield r;
  }

  private isExpired(record: SessionRecord): boolean {
    return Date.now() - record.lastSeenMs > this.idleTtlMs;
  }

  private evictIfNeeded(): void {
    if (this.records.size <= this.maxSessions) return;
    // Drop the oldest by lastSeenMs.
    let oldestId: string | null = null;
    let oldestSeen = Infinity;
    for (const [id, r] of this.records.entries()) {
      if (r.lastSeenMs < oldestSeen) {
        oldestSeen = r.lastSeenMs;
        oldestId = id;
      }
    }
    if (oldestId) this.records.delete(oldestId);
  }
}

/**
 * Detect "Session not found" from upstream. The MCP spec (2025-03-26)
 * specifies status 404 with a JSON body whose `error` is the string
 * `Session not found` (case sensitive in the SDK reference, but we
 * match case-insensitively for resilience).
 *
 * Some servers return 410 Gone with the same body when they explicitly
 * GC'd the session — we treat that as session-not-found too.
 */
export function isSessionNotFoundResponse(statusCode: number, bodyText: string): boolean {
  if (statusCode !== 404 && statusCode !== 410) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes("session not found") || lower.includes("session expired");
}

export const MCP_SESSION_HEADER = "mcp-session-id";

export const DEFAULT_MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * Compatibility init for clients that call a tool before this gateway
 * has seen their initialize request. The response is never exposed to
 * the client; it only creates a valid upstream session to carry the
 * original request.
 */
export function buildDefaultInitializePayload(
  protocolVersion = DEFAULT_MCP_PROTOCOL_VERSION,
): Buffer {
  return Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: {
        name: "paperclip-mcp-gateway",
        version: "0",
      },
    },
  }));
}

export function buildInitializedNotificationPayload(): Buffer {
  return Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }));
}

/**
 * MCP `initialize` requests are JSON-RPC messages with `method:"initialize"`.
 * We need to recognize them in the request body so we can decide whether
 * a request can be forwarded as the first upstream lifecycle message.
 */
export function looksLikeInitializeRequest(bodyText: string): boolean {
  if (bodyText.length === 0) return false;
  try {
    const message = JSON.parse(bodyText) as unknown;
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    return (message as { method?: unknown }).method === "initialize";
  } catch {
    return false;
  }
}

/**
 * Extract the upstream session id the server allocated. The server's
 * response to an initialize request carries `Mcp-Session-Id` as a
 * response header (the protocol's primary mechanism). Some servers
 * additionally carry it in a JSON-RPC `result.sessionId` field; we
 * accept either to be defensive.
 */
export function extractUpstreamSessionId(headers: Headers, bodyText: string): string | null {
  const fromHeader = headers.get(MCP_SESSION_HEADER);
  if (fromHeader && fromHeader.length > 0) return fromHeader;
  // Body fallback — best-effort regex; if it doesn't match, the upstream
  // is non-conformant and we can't cache.
  const match = bodyText.match(/"sessionId"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}
