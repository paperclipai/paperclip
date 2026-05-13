import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { pgChannelForCompany } from "./channel.js";
import {
  buildEnvelope,
  type LiveEventFetcher,
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
  fetcher?: LiveEventFetcher;
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
  const fetcher = opts.fetcher;

  // companyId -> { unlisten, handlers }
  const subscriptions = new Map<
    string,
    {
      handlers: Set<TransportEventHandler>;
      // null while the LISTEN call is still in flight; populated once
      // postgres-js resolves the dedicated listener handle.
      unlisten: (() => Promise<void>) | null;
      // Resolves once initial LISTEN completes; used by callers that
      // want deterministic teardown (mostly tests).
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
      // A single malformed notify should not poison the channel. ioredis
      // had the same defensive try/catch for the same reason.
      return;
    }
    if (envelope.origin === originId) return; // own echo
    const entry = subscriptions.get(companyId);
    if (!entry) return;

    if (envelope.kind === "full") {
      deliver(entry.handlers, envelope.event);
      return;
    }

    // Ref envelope: payload exceeded the inline limit. Re-fetch out of
    // band. If no fetcher is configured, we have no recourse — emit a
    // warn so operators see oversized events are being dropped and can
    // either wire a fetcher or shrink the offending event type.
    if (!fetcher) {
      logger.warn(
        { companyId, eventId: envelope.event.id, type: envelope.event.type },
        "live-events pg transport: oversized envelope dropped (no fetcher configured)",
      );
      return;
    }
    fetcher(envelope.event.id)
      .then((event) => {
        if (event) deliver(entry.handlers, event);
      })
      .catch((err) => {
        logger.warn({ err, eventId: envelope.event.id }, "live-events pg transport: ref re-fetch failed");
      });
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
          const existing = subscriptions.get(companyId);
          if (existing?.unlisten) {
            logger.info({ companyId, channel }, "live-events pg transport: LISTEN reconnected");
          }
        },
      )
      .then((meta) => {
        const current = subscriptions.get(companyId);
        // The entry may have been deleted while LISTEN was in flight; if
        // so, unlisten immediately to avoid a leaked socket subscription.
        if (!current) {
          void meta.unlisten().catch(() => {});
          return;
        }
        current.unlisten = () => meta.unlisten();
      })
      .catch((err) => {
        logger.warn({ err, companyId, channel }, "live-events pg transport: LISTEN failed");
        // Roll back the seat so a retry can try again. Handlers stay
        // attached but will only get in-process events until something
        // re-subscribes successfully.
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
        logger.warn({ err, companyId }, "live-events pg transport: UNLISTEN failed");
      });
    }
  }

  function publish(event: LiveEvent) {
    const channel = pgChannelForCompany(event.companyId);
    const envelope = buildEnvelope(originId, event);
    const serialized = JSON.stringify(envelope);
    // NOTIFY is fire-and-forget. We attach a catch so a transient
    // database blip doesn't surface as an unhandled rejection.
    sql.notify(channel, serialized).catch((err) => {
      logger.warn({ err, channel, eventType: event.type }, "live-events pg transport: NOTIFY failed");
    });
  }

  async function close() {
    // Best-effort: unlisten everything we know about, then end the pool.
    const pending: Promise<unknown>[] = [];
    for (const [companyId, entry] of subscriptions) {
      subscriptions.delete(companyId);
      if (entry.unlisten) pending.push(entry.unlisten().catch(() => {}));
    }
    await Promise.allSettled(pending);
    await sql.end({ timeout: 5 }).catch(() => {});
  }

  return { originId, publish, subscribe, unsubscribe, close };
}
