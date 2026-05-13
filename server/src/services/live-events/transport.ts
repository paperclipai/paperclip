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
  /**
   * Max UTF-8 byte size for the serialized envelope this transport will
   * carry. Used by both the transport itself (when deciding whether to
   * publish) and live-events.ts (when deciding whether to suppress local
   * emit for symmetric drop). Different transports have different wire
   * caps — see PG_NOTIFY_INLINE_LIMIT vs REDIS_PUBSUB_INLINE_LIMIT.
   */
  readonly maxEnvelopeBytes: number;
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
 * Wire-format envelope carried by NOTIFY / Redis PUBLISH. Only one variant:
 * `full` — the LiveEvent travels inline.
 *
 * We do not split oversized events; doing so requires a DB-backed event
 * store, which Paperclip's LiveEvent layer does not have. Live events
 * are best-effort UI hints, not state-machine signals — oversized events
 * are logged at error and dropped symmetrically across all replicas
 * (including the originating replica) so cross-replica behavior never
 * diverges silently.
 */
export type TransportEnvelope = { kind: "full"; origin: string; event: LiveEvent };

/**
 * Postgres NOTIFY caps payloads at 8000 bytes (server-side default). We
 * truncate well below that to leave headroom for envelope framing and
 * UTF-8 expansion in case payload fields contain multibyte chars.
 */
export const PG_NOTIFY_INLINE_LIMIT = 7500;

/**
 * Redis pub/sub has no wire-level cap that approaches Postgres's NOTIFY
 * limit — the default client-output-buffer-limit for pubsub subscribers
 * is 32MB hard / 8MB soft. We still apply a sanity cap (1MB) so a runaway
 * caller posting megabytes of payload gets a noisy drop instead of
 * silently filling Redis client buffers, but we do not impose the
 * Postgres-specific 7.5KB ceiling on operators who opt into Redis.
 */
export const REDIS_PUBSUB_INLINE_LIMIT = 1_000_000;

/**
 * Sentinel returned by {@link buildEnvelope} when the serialized envelope
 * exceeds the transport's max byte size. Callers MUST treat this as
 * "drop event symmetrically": skip cross-replica publish AND skip local
 * in-process emission, otherwise the originating replica sees the event
 * while every other replica does not — exactly the silent divergence
 * the noisy-drop policy is designed to prevent.
 */
export const OVERSIZED_EVENT: unique symbol = Symbol("live-events.oversized");
export type OversizedSentinel = typeof OVERSIZED_EVENT;

/**
 * Encode a LiveEvent for cross-replica fan-out, or return
 * {@link OVERSIZED_EVENT} if the serialized envelope exceeds `maxBytes`.
 * Length is measured in UTF-8 bytes (not JS string `.length`, which
 * counts UTF-16 code units) because Postgres enforces its NOTIFY limit
 * at the wire-encoded byte level and Redis client buffers count bytes.
 */
export function buildEnvelope(
  originId: string,
  event: LiveEvent,
  maxBytes: number,
): TransportEnvelope | OversizedSentinel {
  const full: TransportEnvelope = { kind: "full", origin: originId, event };
  const serialized = JSON.stringify(full);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return full;
  return OVERSIZED_EVENT;
}
