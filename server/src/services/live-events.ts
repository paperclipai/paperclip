import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

// Optional Redis pub/sub for cross-replica event distribution.
//
// In a single-process deployment (the self-hosted default) this module
// just uses an in-memory EventEmitter, identical to previous behavior.
//
// When `PAPERCLIP_LIVE_EVENTS_REDIS_URL` is set (or the generic
// `PAPERCLIP_REDIS_URL` as a fallback), events are also published to a
// Redis channel so WebSocket clients connected to other replicas see
// them. Each process tags outgoing messages with a unique origin id
// and skips its own messages when they come back over the channel, so
// there is no double-emission.
//
// ioredis is imported dynamically so self-hosters without the env var
// set don't pay the dependency cost — and the type is intentionally
// kept loose so operators who want this feature install `ioredis`
// themselves without forcing a global dependency update.
type RedisEventClient = {
  on(event: string, cb: (...args: unknown[]) => void): void;
};
type PublishClient = RedisEventClient & {
  publish(channel: string, message: string): Promise<unknown>;
};
type SubscribeClient = RedisEventClient & {
  subscribe(channel: string): Promise<unknown>;
};

const CHANNEL = "paperclip:live-events";
const originId = `${process.pid}-${randomUUID()}`;

let redisPub: PublishClient | null = null;
let redisSub: SubscribeClient | null = null;
let redisInit: Promise<void> | null = null;

function resolveRedisUrl(): string | null {
  const explicit = process.env.PAPERCLIP_LIVE_EVENTS_REDIS_URL?.trim();
  if (explicit) return explicit;
  const shared = process.env.PAPERCLIP_REDIS_URL?.trim();
  return shared || null;
}

function attachErrorLogger(client: RedisEventClient, role: "publisher" | "subscriber") {
  // ioredis extends EventEmitter and emits `error` on its own schedule (network
  // blip, auth expiry, redis restart). Without a listener, node promotes that
  // to an uncaught exception and crashes the server — which would defeat the
  // whole "best-effort, fall back to local-only" contract of this transport.
  // A single warn-level log is enough; ioredis will auto-reconnect.
  client.on("error", (err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(`[paperclip] live-events: redis ${role} error`, err);
  });
}

async function initRedis(): Promise<void> {
  const url = resolveRedisUrl();
  if (!url) return;
  // @ts-expect-error ioredis is an optional runtime dependency
  const ioredis = await import("ioredis");
  const Redis = (ioredis as { default?: unknown }).default ?? ioredis;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pub = new (Redis as any)(url) as PublishClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = new (Redis as any)(url) as SubscribeClient;
  attachErrorLogger(pub, "publisher");
  attachErrorLogger(sub, "subscriber");
  // Install the message listener and complete the subscription BEFORE
  // publishing anything. If we assigned redisPub first, the publisher
  // could race the subscribe(): events published in that narrow window
  // land in Redis on a channel this replica isn't yet listening to,
  // and if subscribe() then throws, redisPub stays non-null until the
  // outer .catch() runs — more events go to Redis with no local sub.
  sub.on("message", (_channel: unknown, message: unknown) => {
    try {
      const envelope = JSON.parse(message as string) as {
        origin: string;
        event: LiveEvent;
      };
      if (envelope.origin === originId) return;
      // Mirror the routing in publishLiveEvent / publishGlobalLiveEvent:
      // global events go to "*" listeners; company-scoped events go only
      // to that company's listeners.
      if (envelope.event.companyId === "*") {
        emitter.emit("*", envelope.event);
      } else {
        emitter.emit(envelope.event.companyId, envelope.event);
      }
    } catch {
      // A single malformed message shouldn't take down cross-replica
      // delivery for everyone else.
    }
  });
  await sub.subscribe(CHANNEL);
  // Only expose the publisher once we're actually receiving from the
  // channel. If subscribe() threw above we would never reach this line
  // and redisPub would stay null — the outer .catch() handles the log.
  redisPub = pub;
  redisSub = sub;
}

// Non-blocking best-effort init on module load. If ioredis isn't
// installed or the server fails to connect we surface a single warning
// and fall back to local-only delivery so the misconfiguration is
// visible instead of silently degrading.
if (resolveRedisUrl()) {
  redisInit = initRedis();
  redisInit.catch((err) => {
    redisPub = null;
    redisSub = null;
    // eslint-disable-next-line no-console
    console.warn(
      "[paperclip] live-events: Redis transport init failed, falling back to " +
        "single-replica delivery. Install `ioredis` and verify the redis URL " +
        "(PAPERCLIP_LIVE_EVENTS_REDIS_URL / PAPERCLIP_REDIS_URL).",
      err,
    );
  });
}

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

function publishToRedis(event: LiveEvent) {
  if (!redisPub) return;
  const envelope = JSON.stringify({ origin: originId, event });
  redisPub.publish(CHANNEL, envelope).catch(() => {
    /* best-effort cross-replica delivery */
  });
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
  publishToRedis(event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitter.emit("*", event);
  publishToRedis(event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}
