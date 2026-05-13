import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { createPgLiveEventsTransport } from "./live-events/pg-transport.js";
import { createRedisLiveEventsTransport } from "./live-events/redis-transport.js";
import {
  buildEnvelope,
  OVERSIZED_EVENT,
  type LiveEventsTransport,
  type TransportEventHandler,
} from "./live-events/transport.js";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

/**
 * In-process pub/sub. The cross-replica transport (Postgres LISTEN/NOTIFY
 * by default, Redis pub/sub opt-in) fans events out to other replicas
 * and pumps remote events back into this same emitter, so existing
 * call-sites that just do subscribe/publish observe both local and
 * cross-replica events through a single API.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

// ── Transport plumbing ─────────────────────────────────────────────────
//
// The transport is installed lazily by the server on startup
// (`configureLiveEventsTransport`). Single-replica deployments leave it
// unset and the in-process emitter is the whole story, matching the
// behaviour before any cross-replica work existed.

let transport: LiveEventsTransport | null = null;

/** Refcounts per companyId so we only LISTEN once across many WS clients. */
const transportRefcounts = new Map<string, number>();
/** Per-company handler we hand to the transport. Kept stable for unsubscribe. */
const transportHandlers = new Map<string, TransportEventHandler>();

function makeTransportHandler(companyId: string): TransportEventHandler {
  // Route the inbound event back into the local emitter using the same
  // routing the publish* functions use: global ("*") -> global listeners,
  // company-scoped -> that company's listeners only. Without this,
  // company events would be delivered to global subscribers and vice
  // versa, leaking metadata across tenants.
  return (event: LiveEvent) => {
    if (event.companyId === "*") {
      emitter.emit("*", event);
    } else if (event.companyId === companyId) {
      emitter.emit(companyId, event);
    }
  };
}

function attachTransportFor(companyId: string) {
  if (!transport) return;
  const current = transportRefcounts.get(companyId) ?? 0;
  transportRefcounts.set(companyId, current + 1);
  if (current > 0) return;
  const handler = makeTransportHandler(companyId);
  transportHandlers.set(companyId, handler);
  transport.subscribe(companyId, handler);
}

function detachTransportFor(companyId: string) {
  if (!transport) return;
  const current = transportRefcounts.get(companyId) ?? 0;
  if (current <= 1) {
    transportRefcounts.delete(companyId);
    const handler = transportHandlers.get(companyId);
    if (handler) {
      transport.unsubscribe(companyId, handler);
      transportHandlers.delete(companyId);
    }
  } else {
    transportRefcounts.set(companyId, current - 1);
  }
}

export type LiveEventsTransportMode = "postgres" | "redis" | "off";

export function resolveLiveEventsTransportMode(env: NodeJS.ProcessEnv = process.env): LiveEventsTransportMode {
  const raw = env.PAPERCLIP_LIVE_EVENTS_TRANSPORT?.trim().toLowerCase();
  if (!raw || raw === "postgres" || raw === "pg" || raw === "default") return "postgres";
  if (raw === "redis") return "redis";
  if (raw === "off" || raw === "none" || raw === "in-process") return "off";
  // Fall back to default rather than throwing — live events are
  // best-effort and an unknown value should not crash the server.
  logger.warn({ value: raw }, "live-events: unknown PAPERCLIP_LIVE_EVENTS_TRANSPORT, defaulting to postgres");
  return "postgres";
}

export function resolveLiveEventsRedisUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.PAPERCLIP_LIVE_EVENTS_REDIS_URL?.trim();
  if (explicit) return explicit;
  const shared = env.PAPERCLIP_REDIS_URL?.trim();
  return shared && shared.length > 0 ? shared : null;
}

export interface ConfigureLiveEventsTransportOptions {
  mode: LiveEventsTransportMode;
  databaseUrl?: string;
  redisUrl?: string | null;
}

/**
 * Install the cross-replica transport. Called from server startup once
 * the database connection details are known. Safe to call multiple
 * times in tests — the previous transport is closed first.
 */
export async function configureLiveEventsTransport(opts: ConfigureLiveEventsTransportOptions): Promise<LiveEventsTransport | null> {
  await teardownLiveEventsTransport();

  if (opts.mode === "off") {
    logger.warn(
      "live-events: cross-replica transport disabled (PAPERCLIP_LIVE_EVENTS_TRANSPORT=off). " +
        "Multi-replica deployments will see WS clients miss events that originate on a different replica.",
    );
    return null;
  }

  if (opts.mode === "postgres") {
    if (!opts.databaseUrl) {
      logger.warn(
        "live-events: postgres transport selected but no databaseUrl available; falling back to in-process only.",
      );
      return null;
    }
    transport = createPgLiveEventsTransport({ databaseUrl: opts.databaseUrl });
    logger.info("live-events: postgres LISTEN/NOTIFY transport active");
    rebindExistingSubscriptions();
    return transport;
  }

  // redis
  if (!opts.redisUrl) {
    logger.warn(
      "live-events: redis transport selected but neither PAPERCLIP_LIVE_EVENTS_REDIS_URL nor PAPERCLIP_REDIS_URL is set; falling back to in-process only.",
    );
    return null;
  }
  transport = createRedisLiveEventsTransport({ redisUrl: opts.redisUrl });
  logger.info("live-events: redis pub/sub transport active");
  rebindExistingSubscriptions();
  return transport;
}

function rebindExistingSubscriptions() {
  // If subscribers attached before the transport was installed (boot
  // race: a heartbeat tick fires before configureLiveEventsTransport
  // resolves), make sure the transport is now LISTENing for every
  // companyId we already have local subscribers for.
  if (!transport) return;
  for (const companyId of new Set([...transportRefcounts.keys()])) {
    const handler = transportHandlers.get(companyId);
    if (handler) transport.subscribe(companyId, handler);
  }
}

export async function teardownLiveEventsTransport(): Promise<void> {
  const previous = transport;
  transport = null;
  transportRefcounts.clear();
  transportHandlers.clear();
  if (previous) {
    await previous.close().catch((err) => {
      logger.warn({ err }, "live-events: transport close failed");
    });
  }
}

// ── Event factory ──────────────────────────────────────────────────────

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

// ── Public API (back-compat: pre-existing call-sites are unchanged) ───

/**
 * If a cross-replica transport is installed and the event is too large
 * to fit in a NOTIFY/PUBLISH payload, suppress local emission too so
 * the originating replica does not diverge from peers that drop the
 * event. Logging is handled by the transport's publish() so the
 * operator sees one error per oversized event regardless of caller.
 */
function shouldSuppressLocalEmit(event: LiveEvent): boolean {
  if (!transport) return false;
  return buildEnvelope(transport.originId, event) === OVERSIZED_EVENT;
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  if (shouldSuppressLocalEmit(event)) {
    transport?.publish(event); // logs the noisy drop
    return event;
  }
  emitter.emit(input.companyId, event);
  transport?.publish(event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  if (shouldSuppressLocalEmit(event)) {
    transport?.publish(event); // logs the noisy drop
    return event;
  }
  emitter.emit("*", event);
  transport?.publish(event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  attachTransportFor(companyId);
  return () => {
    emitter.off(companyId, listener);
    detachTransportFor(companyId);
  };
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  attachTransportFor("*");
  return () => {
    emitter.off("*", listener);
    detachTransportFor("*");
  };
}
