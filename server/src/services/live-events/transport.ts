import type { LiveEvent } from "@paperclipai/shared";

/**
 * Cross-replica fan-out transport for live events.
 *
 * Implementations subscribe to per-company channels on demand: subscribers
 * call `subscribe(companyId, handler)` when the first WebSocket for a
 * company attaches on this replica, and `unsubscribe(companyId)` when the
 * last one detaches. This per-company channel design keeps multi-tenant
 * traffic isolated (operators can grep notifies by channel and confirm a
 * replica only sees companies it serves) and avoids the "broadcast to
 * everyone, filter locally" pattern that leaks metadata across tenants.
 *
 * `originId` is set per-process so a publisher can drop the echo of its
 * own NOTIFY when it comes back through the LISTEN socket.
 */
export interface LiveEventsTransport {
  /** Stable per-process id; receivers drop messages with a matching origin. */
  readonly originId: string;
  /** Best-effort fan-out. Errors are logged, not thrown — live events are best-effort. */
  publish(event: LiveEvent): void;
  /** Idempotent: multiple subscribes for the same companyId reuse the channel. */
  subscribe(companyId: string, handler: TransportEventHandler): void;
  /** Idempotent: drops the channel listener only when the refcount hits zero. */
  unsubscribe(companyId: string, handler: TransportEventHandler): void;
  /** Tear-down for tests and graceful shutdown. */
  close(): Promise<void>;
}

export type TransportEventHandler = (event: LiveEvent) => void;

/**
 * Wire-format envelope carried by NOTIFY / Redis PUBLISH. Two variants:
 *  - `full`: the LiveEvent travels inline. Fast path.
 *  - `ref`: only an id+metadata. The receiver re-fetches the full event
 *    from the DB via the configured fetcher. Used when the inline JSON
 *    would exceed the Postgres NOTIFY 8000-byte cap.
 */
export type TransportEnvelope =
  | { kind: "full"; origin: string; event: LiveEvent }
  | {
      kind: "ref";
      origin: string;
      event: { id: number; companyId: string; type: string; createdAt: string };
    };

/** Re-fetcher used when an envelope arrives as a ref (oversize payload). */
export type LiveEventFetcher = (id: number) => Promise<LiveEvent | null>;

/**
 * Postgres NOTIFY caps payloads at 8000 bytes (server-side default). We
 * truncate well below that to leave headroom for envelope framing and
 * UTF-8 expansion in case payload fields contain multibyte chars.
 */
export const PG_NOTIFY_INLINE_LIMIT = 7500;

export function buildEnvelope(originId: string, event: LiveEvent): TransportEnvelope {
  const full: TransportEnvelope = { kind: "full", origin: originId, event };
  const serialized = JSON.stringify(full);
  if (serialized.length <= PG_NOTIFY_INLINE_LIMIT) return full;
  return {
    kind: "ref",
    origin: originId,
    event: {
      id: event.id,
      companyId: event.companyId,
      type: event.type,
      createdAt: event.createdAt,
    },
  };
}
