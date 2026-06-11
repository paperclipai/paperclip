import { randomUUID } from "node:crypto";
import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { redisChannelForCompany } from "./channel.js";
import {
  envelopeToEvents,
  packEnvelopes,
  REDIS_PUBSUB_INLINE_LIMIT,
  type LiveEventsTransport,
  type TransportEnvelope,
  type TransportEventHandler,
} from "./transport.js";

/**
 * ioredis is intentionally NOT a hard dependency. Operators who pick
 * the redis transport install it themselves; everyone else avoids
 * pulling the client into their node_modules. The types below stay
 * loose for the same reason.
 */
type RedisEventClient = {
  on(event: string, cb: (...args: unknown[]) => void): void;
  quit(): Promise<unknown>;
};
type PublishClient = RedisEventClient & {
  publish(channel: string, message: string): Promise<unknown>;
};
type SubscribeClient = RedisEventClient & {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
};

/** Test seam: swap in a fake ioredis without touching the env. */
export type RedisClientFactory = (url: string) => {
  publisher: PublishClient;
  subscriber: SubscribeClient;
};

export interface RedisTransportOptions {
  redisUrl: string;
  /** Defaults to the real ioredis dynamic import. */
  clientFactory?: RedisClientFactory;
}

async function defaultClientFactory(
  url: string,
): Promise<{ publisher: PublishClient; subscriber: SubscribeClient }> {
  // Dynamic import so projects that never set transport=redis don't
  // need ioredis installed. The type assertion keeps this compiling
  // when the optional dep is absent at type-check time.
  // @ts-expect-error ioredis is an optional runtime dependency
  const ioredis = await import("ioredis");
  const Redis = (ioredis as { default?: unknown }).default ?? ioredis;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const publisher = new (Redis as any)(url) as PublishClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subscriber = new (Redis as any)(url) as SubscribeClient;
  return { publisher, subscriber };
}

function attachErrorLogger(client: RedisEventClient, role: "publisher" | "subscriber") {
  // ioredis EventEmitter emits `error` on network blips, auth expiry,
  // redis restarts. Without a listener node promotes it to an uncaught
  // exception — which defeats the best-effort contract of this transport.
  client.on("error", (err: unknown) => {
    logger.warn({ err, role }, "live-events redis transport: client error");
  });
}

/**
 * Redis pub/sub transport — opt-in alternative when the operator already
 * runs Redis and prefers it for live-event fan-out. Per-company channels
 * mirror the Postgres design so multi-tenant traffic stays isolated.
 *
 * The ctor returns a transport immediately; client init runs in the
 * background. Publishes issued before the publisher socket is open are
 * dropped silently — live events are best-effort UI hints, not state
 * signals, and the boot window where this is possible is in the low
 * milliseconds. Subscribes, by contrast, are queued in
 * `pendingRedisSubscribes` and flushed on connect so a WebSocket that
 * attaches during boot still receives subsequent events once init
 * completes.
 */
export function createRedisLiveEventsTransport(opts: RedisTransportOptions): LiveEventsTransport {
  const originId = `${process.pid}-${randomUUID()}`;
  const factory: RedisClientFactory | undefined = opts.clientFactory;

  let publisher: PublishClient | null = null;
  let subscriber: SubscribeClient | null = null;
  const subscriptions = new Map<string, Set<TransportEventHandler>>();
  // Pending subscribes we've recorded but haven't yet pushed to redis,
  // either because the client is still initialising or because
  // subscribe() is in flight.
  const pendingRedisSubscribes = new Set<string>();

  function deliver(handlers: Set<TransportEventHandler>, event: LiveEvent) {
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (err) {
        logger.warn({ err }, "live-events redis transport: handler threw");
      }
    }
  }

  function handleMessage(channel: string, raw: string) {
    let envelope: TransportEnvelope;
    try {
      envelope = JSON.parse(raw) as TransportEnvelope;
    } catch {
      return;
    }
    if (typeof envelope !== "object" || envelope === null) return;
    if (envelope.origin === originId) return;
    // Guard malformed payloads: valid JSON that doesn't carry the fields
    // its `kind` promises would otherwise throw out of the ioredis
    // "message" callback (no try-catch upstream), unlike the PG transport
    // where deliver() absorbs it.
    const companyId =
      envelope.kind === "full"
        ? envelope.event?.companyId
        : envelope.kind === "batch"
          ? envelope.events?.[0]?.companyId
          : envelope.kind === "resync"
            ? envelope.companyId
            : undefined;
    if (!companyId) return;
    if (redisChannelForCompany(companyId) !== channel) return;
    const handlers = subscriptions.get(companyId);
    if (!handlers) return;
    for (const event of envelopeToEvents(companyId, envelope)) {
      deliver(handlers, event);
    }
  }

  async function flushPendingSubscribes() {
    if (!subscriber) return;
    for (const companyId of [...pendingRedisSubscribes]) {
      const channel = redisChannelForCompany(companyId);
      try {
        await subscriber.subscribe(channel);
        pendingRedisSubscribes.delete(companyId);
      } catch (err) {
        logger.warn({ err, companyId, channel }, "live-events redis transport: SUBSCRIBE failed");
      }
    }
  }

  const init = (async () => {
    const built = await (factory ? factory(opts.redisUrl) : defaultClientFactory(opts.redisUrl));
    publisher = built.publisher;
    subscriber = built.subscriber;
    attachErrorLogger(publisher, "publisher");
    attachErrorLogger(subscriber, "subscriber");

    // ioredis exposes "message" with (channel, message). Cast to our
    // loose RedisEventClient shape; the same listener mechanism works
    // for the mock factories used in tests.
    subscriber.on("message", (channel: unknown, message: unknown) => {
      if (typeof channel !== "string" || typeof message !== "string") return;
      handleMessage(channel, message);
    });

    await flushPendingSubscribes();
  })().catch((err) => {
    logger.warn(
      { err },
      "live-events redis transport: init failed; cross-replica fan-out disabled. " +
        "Install `ioredis` and check PAPERCLIP_LIVE_EVENTS_REDIS_URL.",
    );
    publisher = null;
    subscriber = null;
  });

  function subscribe(companyId: string, handler: TransportEventHandler) {
    let handlers = subscriptions.get(companyId);
    if (!handlers) {
      handlers = new Set();
      subscriptions.set(companyId, handlers);
      pendingRedisSubscribes.add(companyId);
      // Kick the in-flight subscribe; if init isn't done yet,
      // flushPendingSubscribes will pick it up.
      void init.then(() => flushPendingSubscribes());
    }
    handlers.add(handler);
  }

  function unsubscribe(companyId: string, handler: TransportEventHandler) {
    const handlers = subscriptions.get(companyId);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size > 0) return;
    subscriptions.delete(companyId);
    pendingRedisSubscribes.delete(companyId);
    if (!subscriber) return;
    subscriber
      .unsubscribe(redisChannelForCompany(companyId))
      .catch((err) => {
        logger.warn({ err, companyId }, "live-events redis transport: UNSUBSCRIBE failed");
      });
  }

  // No debounce here: Redis PUBLISH has no commit-lock serialization
  // problem, so each event goes out immediately in its own envelope.
  function publish(event: LiveEvent) {
    if (!publisher) return;
    const client = publisher;
    const channel = redisChannelForCompany(event.companyId);
    for (const envelope of packEnvelopes(originId, [event], REDIS_PUBSUB_INLINE_LIMIT)) {
      if (envelope.kind === "resync") {
        logger.warn(
          { companyId: event.companyId, eventType: envelope.type, limit: REDIS_PUBSUB_INLINE_LIMIT },
          "live-events redis transport: oversized event downgraded to resync marker",
        );
      }
      client.publish(channel, JSON.stringify(envelope)).catch((err) => {
        logger.warn({ err, channel }, "live-events redis transport: PUBLISH failed");
      });
    }
  }

  async function close() {
    await init.catch(() => {});
    try {
      await publisher?.quit();
    } catch {
      /* ignore */
    }
    try {
      await subscriber?.quit();
    } catch {
      /* ignore */
    }
  }

  return {
    originId,
    publish,
    subscribe,
    unsubscribe,
    close,
    // Subscribes queue in pendingRedisSubscribes until client init
    // finishes; "established" means init settled and this company's
    // SUBSCRIBE (if any was pending) has been pushed to redis.
    whenSubscribed: async (companyId) => {
      await init;
      if (pendingRedisSubscribes.has(companyId)) await flushPendingSubscribes();
    },
  };
}
