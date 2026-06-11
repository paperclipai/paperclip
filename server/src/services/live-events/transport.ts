import type { LiveEvent, LiveEventType } from "@paperclipai/shared";

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
  /** Optional transport-level diagnostics. */
  stats?: () => Promise<{ notificationQueueUsage?: number }>;
  /** Resolves once the channel subscription for companyId is established. Tests/tools; no-op for transports without async subscription setup. */
  whenSubscribed?: (companyId: string) => Promise<void>;
}

export type TransportEventHandler = (event: LiveEvent) => void;

/**
 * Wire-format envelope carried by NOTIFY / Redis PUBLISH.
 *  - `full`  — one LiveEvent inline.
 *  - `batch` — several LiveEvents coalesced into one frame. Postgres NOTIFY
 *    takes a global AccessExclusiveLock at commit that serializes all
 *    NOTIFY-ing commits, so bursty publishers must coalesce rather than
 *    issue one NOTIFY per event.
 *  - `resync` — a payload-free marker for an event whose serialized form
 *    exceeds the transport cap. The receiver synthesizes a LiveEvent of the
 *    original type with payload { __resync: true }; consumers refetch.
 *    The originating replica still emits the full event locally — remote
 *    replicas degrade to a refetch hint instead of the event being dropped.
 */
export type TransportEnvelope =
  | { kind: "full"; origin: string; event: LiveEvent }
  | { kind: "batch"; origin: string; events: LiveEvent[] }
  | { kind: "resync"; origin: string; companyId: string; type: LiveEventType };

/**
 * Postgres NOTIFY caps payloads at 8000 bytes (server-side default).
 * Envelope size is measured exactly via Buffer.byteLength of the envelope
 * JSON; 7500 is a safety margin against non-default server configs.
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
 * Size-aware packing: greedily coalesce events into `batch` envelopes whose
 * serialized UTF-8 size stays ≤ maxBytes; an event that cannot fit alone
 * degrades to a `resync` marker. Envelope order matches event order — the
 * pending batch is flushed before a resync marker is pushed, so a marker
 * never overtakes earlier inline events. A batch of one is emitted as
 * `full`.
 */
export function packEnvelopes(
  originId: string,
  events: LiveEvent[],
  maxBytes: number,
): TransportEnvelope[] {
  const out: TransportEnvelope[] = [];
  let batch: LiveEvent[] = [];
  const flushBatch = () => {
    if (batch.length === 0) return;
    out.push(
      batch.length === 1
        ? { kind: "full", origin: originId, event: batch[0] }
        : { kind: "batch", origin: originId, events: batch },
    );
    batch = [];
  };
  for (const event of events) {
    const single: TransportEnvelope = { kind: "full", origin: originId, event };
    if (Buffer.byteLength(JSON.stringify(single), "utf8") > maxBytes) {
      flushBatch(); // keep envelope order aligned with event order
      out.push({ kind: "resync", origin: originId, companyId: event.companyId, type: event.type });
      continue;
    }
    if (batch.length > 0) {
      const candidate: TransportEnvelope = { kind: "batch", origin: originId, events: [...batch, event] };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) flushBatch();
    }
    batch.push(event);
  }
  flushBatch();
  return out;
}

/**
 * Decode an inbound envelope into the LiveEvents to deliver locally.
 *
 * Total against wire input: unknown `kind`s and shape mismatches decode to
 * `[]` instead of throwing — a malformed frame must never propagate an
 * exception into a transport's notify callback. Decoded events are also
 * filtered to the receiving channel's companyId so a frame can never
 * deliver another tenant's events (channels for "*" carry events with
 * companyId === "*", so global routing is unaffected).
 *
 * Resync markers become synthetic events with payload { __resync: true };
 * id 0 marks receiver-synthesized events (ids are per-process ordering
 * hints, never compared across replicas).
 */
export function envelopeToEvents(companyId: string, envelope: TransportEnvelope): LiveEvent[] {
  if (typeof envelope !== "object" || envelope === null) return [];
  const raw = envelope as Partial<Record<"kind" | "event" | "events" | "companyId" | "type", unknown>>;
  // Rolling deploy: pre-hardening replicas send { origin, event } with no kind.
  const kind = raw.kind ?? (raw.event !== undefined ? "full" : undefined);
  switch (kind) {
    case "full": {
      const event = raw.event as LiveEvent | null | undefined;
      if (typeof event !== "object" || event === null) return [];
      return event.companyId === companyId ? [event] : [];
    }
    case "batch": {
      if (!Array.isArray(raw.events)) return [];
      return (raw.events as LiveEvent[]).filter((e) => e?.companyId === companyId);
    }
    case "resync": {
      if (raw.companyId !== companyId) return [];
      if (typeof raw.type !== "string") return [];
      return [
        {
          id: 0,
          companyId,
          type: raw.type as LiveEventType,
          createdAt: new Date().toISOString(),
          payload: { __resync: true },
        },
      ];
    }
    default:
      return [];
  }
}
