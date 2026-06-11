import { randomUUID } from "node:crypto";
// `postgres` (postgres-js) is re-exported by @paperclipai/db so the server
// doesn't need to declare its own copy of the dependency.
import { postgres } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { pgChannelForCompany } from "./channel.js";
import {
  envelopeToEvents,
  packEnvelopes,
  PG_NOTIFY_INLINE_LIMIT,
  type LiveEventsTransport,
  type TransportEnvelope,
  type TransportEventHandler,
} from "./transport.js";

/**
 * Postgres LISTEN/NOTIFY transport.
 *
 * Why this is the default:
 *  - No new infra dep — the server already needs Postgres.
 *  - postgres-js manages a dedicated socket internally for LISTEN (the
 *    pool socket can't be used because LISTEN occupies the connection),
 *    and reconnects with backoff on transient blips.
 *  - Per-company channels keep multi-tenant traffic naturally segregated:
 *    a replica only LISTENs on the channels for companies it currently
 *    serves WebSockets for, so other tenants' NOTIFYs never touch this
 *    process's socket buffer.
 *
 * The lifecycle is refcounted: the first subscribe(companyId) issues a
 * LISTEN, further subscribes for the same company just attach more
 * in-process handlers, and the last unsubscribe issues UNLISTEN.
 */
export function createPgLiveEventsTransport(opts: {
  databaseUrl: string;
}): LiveEventsTransport {
  // Dedicated client. `max: 1` keeps the pool tiny — we only need a
  // single connection to issue NOTIFY queries; postgres-js spins up a
  // separate dedicated socket for LISTEN under the hood.
  const sql = postgres(opts.databaseUrl, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "paperclip-live-events" },
  });
  const originId = `${process.pid}-${randomUUID()}`;
  // Set by close(); demotes expected teardown noise (UNLISTEN/NOTIFY on a
  // destroyed connection) from warn to debug and drops late publishes.
  let closed = false;

  // companyId -> { unlisten, handlers }
  const subscriptions = new Map<
    string,
    {
      handlers: Set<TransportEventHandler>;
      // null while the LISTEN call is still in flight; populated once
      // postgres-js resolves the dedicated listener handle.
      unlisten: (() => Promise<void>) | null;
      // Settles once the initial LISTEN completes (or fails); consumed by
      // whenSubscribed so tests/tools get a deterministic readiness signal.
      ready: Promise<void>;
    }
  >();

  function deliver(handlers: Set<TransportEventHandler>, event: LiveEvent) {
    // Snapshot handlers so an unsubscribe during delivery doesn't skew
    // iteration. The cost is tiny — handler counts are bounded by the
    // active WebSocket fan-out, not by traffic volume.
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (err) {
        logger.warn({ err }, "live-events pg transport: handler threw");
      }
    }
  }

  function handleNotify(companyId: string, raw: string) {
    let envelope: TransportEnvelope;
    try {
      envelope = JSON.parse(raw) as TransportEnvelope;
    } catch {
      // A malformed frame must not poison the channel or kill the LISTEN
      // connection; drop it and keep listening.
      return;
    }
    if (envelope.origin === originId) return; // own echo
    const entry = subscriptions.get(companyId);
    if (!entry) return;
    for (const event of envelopeToEvents(companyId, envelope)) {
      deliver(entry.handlers, event);
    }
  }

  function subscribe(companyId: string, handler: TransportEventHandler) {
    let entry = subscriptions.get(companyId);
    if (entry) {
      entry.handlers.add(handler);
      return;
    }
    const channel = pgChannelForCompany(companyId);
    const handlers = new Set<TransportEventHandler>([handler]);
    // We must seat the subscription record BEFORE awaiting LISTEN so a
    // racing unsubscribe sees consistent state. The unlisten slot is
    // filled in once postgres-js resolves.
    const ready = sql
      .listen(
        channel,
        (raw) => handleNotify(companyId, raw),
        () => {
          // onlisten fires on initial LISTEN and on each auto-reconnect.
          // We log reconnects (after the first connect) so operators
          // have a signal in the logs when the dedicated socket flaps.
          // LISTEN/NOTIFY is at-most-once: anything NOTIFYed while the
          // socket was down is gone, so we deliver a synthetic
          // transport.resync event telling consumers to refetch.
          const existing = subscriptions.get(companyId);
          if (existing?.unlisten) {
            logger.info({ companyId, channel }, "live-events pg transport: LISTEN reconnected");
            deliver(existing.handlers, {
              id: 0,
              companyId,
              type: "transport.resync",
              createdAt: new Date().toISOString(),
              payload: { __resync: true },
            });
          }
        },
      )
      .then((meta) => {
        const current = subscriptions.get(companyId);
        // The entry may have been deleted while LISTEN was in flight, or
        // replaced by a newer subscribe after an unsubscribe (identity
        // check on `handlers`). Either way this LISTEN is stale: unlisten
        // immediately to avoid a leaked socket subscription / duplicate
        // delivery.
        if (!current || current.handlers !== handlers) {
          void meta.unlisten().catch(() => {});
          return;
        }
        current.unlisten = () => meta.unlisten();
      })
      .catch((err) => {
        logger.warn({ err, companyId, channel }, "live-events pg transport: LISTEN failed");
        // Drop the seat so a later subscribe() can retry the LISTEN. Note
        // that live-events.ts keeps its per-company handler registered, so
        // cross-replica delivery for this company stays dead until the
        // transport is reconfigured; only in-process events flow.
        const current = subscriptions.get(companyId);
        if (current && current.handlers === handlers) {
          subscriptions.delete(companyId);
        }
      });
    entry = { handlers, unlisten: null, ready };
    subscriptions.set(companyId, entry);
  }

  function unsubscribe(companyId: string, handler: TransportEventHandler) {
    const entry = subscriptions.get(companyId);
    if (!entry) return;
    entry.handlers.delete(handler);
    if (entry.handlers.size > 0) return;
    subscriptions.delete(companyId);
    // If LISTEN hasn't resolved yet, the post-listen ready handler will
    // see the missing entry and unlisten itself.
    if (entry.unlisten) {
      void entry.unlisten().catch((err) => {
        // During shutdown the dedicated socket may already be gone;
        // that's expected, not warn-worthy.
        logger[closed ? "debug" : "warn"]({ err, companyId }, "live-events pg transport: UNLISTEN failed");
      });
    }
  }

  /**
   * NOTIFY takes a global AccessExclusiveLock at commit, serializing all
   * NOTIFY-ing commits cluster-wide. Coalescing a burst into one frame per
   * company per window keeps Paperclip's event traffic off that lock's
   * hot path. 25ms adds imperceptible UI latency.
   */
  const FLUSH_WINDOW_MS = 25;
  const pendingByCompany = new Map<string, LiveEvent[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPending() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const [companyId, events] of pendingByCompany) {
      pendingByCompany.delete(companyId);
      const channel = pgChannelForCompany(companyId);
      for (const envelope of packEnvelopes(originId, events, PG_NOTIFY_INLINE_LIMIT)) {
        if (envelope.kind === "resync") {
          logger.warn(
            { companyId, eventType: envelope.type, limit: PG_NOTIFY_INLINE_LIMIT },
            "live-events pg transport: oversized event downgraded to resync marker",
          );
        }
        // NOTIFY is fire-and-forget. We attach a catch so a transient
        // database blip doesn't surface as an unhandled rejection.
        sql.notify(channel, JSON.stringify(envelope)).catch((err) => {
          logger[closed ? "debug" : "warn"]({ err, channel }, "live-events pg transport: NOTIFY failed");
        });
      }
    }
  }

  function publish(event: LiveEvent) {
    if (closed) return;
    const pending = pendingByCompany.get(event.companyId);
    if (pending) {
      pending.push(event);
    } else {
      pendingByCompany.set(event.companyId, [event]);
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flushPending, FLUSH_WINDOW_MS);
      flushTimer.unref?.();
    }
  }

  async function close() {
    flushPending();
    closed = true;
    // Best-effort: unlisten everything we know about, then end the pool.
    const pending: Promise<unknown>[] = [];
    for (const [companyId, entry] of subscriptions) {
      subscriptions.delete(companyId);
      if (entry.unlisten) pending.push(entry.unlisten().catch(() => {}));
    }
    await Promise.allSettled(pending);
    await sql.end({ timeout: 5 }).catch(() => {});
  }

  async function stats() {
    const rows = await sql`SELECT pg_notification_queue_usage()::float8 AS usage`;
    return { notificationQueueUsage: Number(rows[0]?.usage ?? 0) };
  }

  return {
    originId,
    publish,
    subscribe,
    unsubscribe,
    close,
    stats,
    whenSubscribed: (companyId) => subscriptions.get(companyId)?.ready ?? Promise.resolve(),
  };
}
