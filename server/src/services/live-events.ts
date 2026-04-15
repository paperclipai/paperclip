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
// kept loose so ioredis can be an optionalDependency.
type PublishClient = { publish(channel: string, message: string): Promise<unknown> };
type SubscribeClient = {
  subscribe(channel: string): Promise<unknown>;
  on(event: string, cb: (...args: unknown[]) => void): void;
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

async function initRedis(): Promise<void> {
  const url = resolveRedisUrl();
  if (!url) return;
  try {
    const ioredis = await import("ioredis");
    const Redis = (ioredis as { default?: unknown }).default ?? ioredis;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisPub = new (Redis as any)(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisSub = new (Redis as any)(url);
    await redisSub!.subscribe(CHANNEL);
    redisSub!.on("message", (_channel: unknown, message: unknown) => {
      try {
        const envelope = JSON.parse(message as string) as {
          origin: string;
          event: LiveEvent;
        };
        if (envelope.origin === originId) return;
        emitter.emit(envelope.event.companyId, envelope.event);
        emitter.emit("*", envelope.event);
      } catch {
        // ignore malformed messages — a single bad payload shouldn't
        // take down cross-replica delivery for everyone else
      }
    });
  } catch {
    // ioredis not installed or connection failed — fall back to
    // local-only events without surfacing an error: live events are
    // best-effort.
    redisPub = null;
    redisSub = null;
  }
}

// Non-blocking best-effort init on module load.
if (resolveRedisUrl()) {
  redisInit = initRedis();
  redisInit.catch(() => {
    /* logged indirectly via failed subscribe */
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
