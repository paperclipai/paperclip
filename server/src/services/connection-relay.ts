import { and, desc, eq, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, connectionTriggerDeliveries, connectionTriggers, issues, pluginCompanySettings, plugins, routines as routinesTable, toolConnections } from "@paperclipai/db";
import {
  ConnectProtocolError,
  relayEnvelopeSchema,
  verifyRelaySignature,
  type RelayEnvelope,
} from "@paperclipai/connect-protocol";
import { secretService } from "./secrets.js";
import { routineService } from "./routines.js";
import { heartbeatService } from "./heartbeat.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export type RelayTrigger = {
  id: string;
  companyId: string;
  destinationType: "routine" | "issue_wake" | "plugin_worker";
  destinationId: string;
  config?: Record<string, unknown>;
};

// How long a claimed delivery may stay in an in-progress state (`received`/`forwarded`)
// before a later attempt is allowed to reclaim it. This must comfortably exceed the time
// a healthy worker needs to dispatch every trigger, so an active worker is never raced;
// per-trigger idempotency keys are the correctness backstop if a slow worker overruns it.
export const RELAY_DELIVERY_LEASE_MS = 5 * 60 * 1000;

export type ConnectionRelayStore = {
  findConnectionByPublicRef(publicRef: string): Promise<{ id: string; companyId: string; enabled: boolean } | null>;
  claimDelivery(input: { companyId: string; connectionId: string; envelope: RelayEnvelope; triggerSnapshot: RelayTrigger[]; now?: Date }): Promise<{ claimed: boolean; completedTriggerIds: string[]; triggerSnapshot: RelayTrigger[] | null }>;
  listEnabledTriggers(connectionId: string): Promise<RelayTrigger[]>;
  updateDelivery?(input: { connectionId: string; deliveryId: string; status: "forwarded" | "delivered" | "failed" | "dead_letter"; error?: string | null; now?: Date }): Promise<void>;
  markTriggerCompleted?(input: { connectionId: string; deliveryId: string; triggerId: string; now?: Date }): Promise<void>;
};

type RelayConnectionConfig = { relay?: { publicRef?: string; secretId?: string; secretVersion?: string } };

export function connectionRelayStore(db: Db): ConnectionRelayStore {
  return {
    async findConnectionByPublicRef(publicRef) {
      // Containment lookup (GIN-indexed) instead of scanning every connection into memory: inbound
      // relay webhooks run this before auth, so a full-table scan would be a pre-auth DoS vector.
      const rows = await db.select({ id: toolConnections.id, companyId: toolConnections.companyId, enabled: toolConnections.enabled }).from(toolConnections).where(sql`${toolConnections.config} @> ${JSON.stringify({ relay: { publicRef } })}::jsonb`).limit(1);
      return rows[0] ?? null;
    },
    async claimDelivery({ companyId, connectionId, envelope, triggerSnapshot, now = new Date() }) {
      const leaseExpiresAt = new Date(now.getTime() + RELAY_DELIVERY_LEASE_MS);
      // The trigger snapshot is written in the INSERT branch only, so it is persisted atomically
      // with the row's creation — there is no window where a delivery exists without its snapshot.
      // The reclaim `set` deliberately omits `triggerSnapshot`, so retries and crash recovery reuse
      // the set captured at first claim and never rebuild it from current configuration.
      const rows = await db.insert(connectionTriggerDeliveries).values({ companyId, connectionId, deliveryId: envelope.deliveryId, providerSlug: envelope.providerSlug, attempt: envelope.attempt, envelope, triggerSnapshot, receivedAt: new Date(envelope.receivedAt), leaseExpiresAt }).onConflictDoUpdate({
        target: [connectionTriggerDeliveries.connectionId, connectionTriggerDeliveries.deliveryId],
        set: { attempt: envelope.attempt, envelope, status: "received", lastError: null, leaseExpiresAt, updatedAt: now },
        // Reclaim either an explicitly failed delivery on a strictly newer attempt, or an
        // in-progress (`received`/`forwarded`) delivery whose lease has expired — the latter
        // is how an abandoned handoff from a crashed worker is safely recovered without
        // racing a worker that still holds a live lease.
        setWhere: or(
          and(eq(connectionTriggerDeliveries.status, "failed"), lt(connectionTriggerDeliveries.attempt, envelope.attempt)),
          and(
            inArray(connectionTriggerDeliveries.status, ["received", "forwarded"]),
            isNotNull(connectionTriggerDeliveries.leaseExpiresAt),
            lt(connectionTriggerDeliveries.leaseExpiresAt, now),
            lte(connectionTriggerDeliveries.attempt, envelope.attempt),
          ),
        ),
      }).returning({ completedTriggerIds: connectionTriggerDeliveries.completedTriggerIds, triggerSnapshot: connectionTriggerDeliveries.triggerSnapshot });
      return { claimed: rows.length === 1, completedTriggerIds: rows[0]?.completedTriggerIds ?? [], triggerSnapshot: rows[0]?.triggerSnapshot ?? null };
    },
    async listEnabledTriggers(connectionId) {
      return db.select({ id: connectionTriggers.id, companyId: connectionTriggers.companyId, destinationType: connectionTriggers.destinationType, destinationId: connectionTriggers.destinationId, config: connectionTriggers.config }).from(connectionTriggers).where(and(eq(connectionTriggers.connectionId, connectionId), eq(connectionTriggers.enabled, true)));
    },
    async updateDelivery({ connectionId, deliveryId, status, error, now = new Date() }) {
      await db.update(connectionTriggerDeliveries).set({
        status,
        forwardedAt: status === "forwarded" ? now : undefined,
        deliveredAt: status === "delivered" ? now : undefined,
        // Renew the lease while the handoff is actively in flight; clear it on terminal
        // states so a delivered/dead-letter row can never be mistaken for an abandoned one.
        leaseExpiresAt: status === "forwarded" ? new Date(now.getTime() + RELAY_DELIVERY_LEASE_MS) : status === "delivered" || status === "dead_letter" ? null : undefined,
        lastError: error ?? null,
        updatedAt: now,
      }).where(and(eq(connectionTriggerDeliveries.connectionId, connectionId), eq(connectionTriggerDeliveries.deliveryId, deliveryId)));
    },
    async markTriggerCompleted({ connectionId, deliveryId, triggerId, now = new Date() }) {
      await db.update(connectionTriggerDeliveries).set({
        completedTriggerIds: sql`coalesce(${connectionTriggerDeliveries.completedTriggerIds}, '[]'::jsonb) || ${JSON.stringify([triggerId])}::jsonb`,
        updatedAt: now,
      }).where(and(eq(connectionTriggerDeliveries.connectionId, connectionId), eq(connectionTriggerDeliveries.deliveryId, deliveryId), sql`not (${connectionTriggerDeliveries.completedTriggerIds} @> ${JSON.stringify([triggerId])}::jsonb)`));
    },
  };
}

export function connectionRelaySecretResolver(db: Db) {
  const secrets = secretService(db);
  return async (publicRef: string): Promise<Buffer> => {
    // Same GIN-indexed containment lookup as findConnectionByPublicRef — this resolver runs before
    // signature verification, so it must not scan the whole tool_connections table per request.
    const rows = await db.select({ companyId: toolConnections.companyId, config: toolConnections.config }).from(toolConnections).where(sql`${toolConnections.config} @> ${JSON.stringify({ relay: { publicRef } })}::jsonb`).limit(1);
    const connection = rows[0];
    const relay = connection && (connection.config as RelayConnectionConfig).relay;
    if (!connection || !relay?.secretId) throw new Error("Relay connection or secret not found");
    const parsedVersion = relay.secretVersion && /^\d+$/.test(relay.secretVersion) ? Number(relay.secretVersion) : "latest";
    const value = await secrets.resolveSecretValue(connection.companyId, relay.secretId, parsedVersion);
    return Buffer.from(value, "base64");
  };
}

export type ConnectionRelayDispatchContext = { idempotencyKey: string };

export type ConnectionRelayDispatcher = Record<RelayTrigger["destinationType"], (trigger: RelayTrigger, envelope: RelayEnvelope, context: ConnectionRelayDispatchContext) => Promise<void>>;

function relayTriggerIdempotencyKey(envelope: RelayEnvelope, trigger: RelayTrigger) {
  return `connection-relay:${envelope.deliveryId}:${trigger.id}`;
}

export function connectionRelayDispatcher(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeup">;
  } = {},
): ConnectionRelayDispatcher {
  const routines = routineService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const heartbeat = options.heartbeat ?? heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
  return {
    routine: async (trigger, envelope, context) => {
      const routine = await db.select({ id: routinesTable.id }).from(routinesTable).where(and(eq(routinesTable.id, trigger.destinationId), eq(routinesTable.companyId, trigger.companyId))).limit(1).then((rows) => rows[0]);
      if (!routine) throw new Error("Relay routine destination is outside the connection company");
      await routines.runRoutine(trigger.destinationId, {
        source: "api",
        payload: { connectionRelay: envelope },
        idempotencyKey: context.idempotencyKey,
      });
    },
    issue_wake: async (trigger, envelope, context) => {
      const issue = await db
        .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.id, trigger.destinationId), eq(issues.companyId, trigger.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue?.assigneeAgentId) throw new Error("Relay issue destination has no assigned agent");
      const existingWake = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, trigger.companyId),
          eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
          eq(agentWakeupRequests.idempotencyKey, context.idempotencyKey),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingWake) return;
      await heartbeat.wakeup(issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "connection_trigger",
        idempotencyKey: context.idempotencyKey,
        requestedByActorType: "system",
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          wakeReason: "connection_trigger",
          connectionRelay: envelope,
        },
      });
    },
    plugin_worker: async (trigger, envelope, context) => {
      if (!options.pluginWorkerManager) throw new Error("Plugin worker manager is unavailable");
      const plugin = await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.id, trigger.destinationId)).limit(1).then((rows) => rows[0]);
      const companySetting = await db.select({ enabled: pluginCompanySettings.enabled }).from(pluginCompanySettings).where(and(eq(pluginCompanySettings.pluginId, trigger.destinationId), eq(pluginCompanySettings.companyId, trigger.companyId))).limit(1).then((rows) => rows[0]);
      if (!plugin || companySetting?.enabled === false) throw new Error("Relay plugin destination is not enabled for the connection company");
      const endpointKey = typeof trigger.config?.endpointKey === "string" ? trigger.config.endpointKey : "connection-relay";
      const rawBody = Buffer.from(envelope.provider.bodyB64, "base64").toString("utf8");
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = undefined;
      }
      await options.pluginWorkerManager.call(trigger.destinationId, "handleWebhook", {
        companyId: trigger.companyId,
        endpointKey,
        headers: envelope.provider.headers,
        rawBody,
        parsedBody,
        requestId: context.idempotencyKey,
      });
    },
  };
}

export async function processConnectionRelay(
  store: ConnectionRelayStore,
  input: {
    rawBody: Buffer;
    signature: string | null | undefined;
    timestamp: string | null | undefined;
    relaySecret: Buffer | string;
    now?: Date;
  },
) {
  if (!input.signature || !input.timestamp || !verifyRelaySignature({
    body: input.rawBody,
    relaySecret: typeof input.relaySecret === "string" ? Buffer.from(input.relaySecret, "base64") : input.relaySecret,
    signature: input.signature,
    timestamp: input.timestamp,
    now: input.now,
  })) {
    throw new ConnectProtocolError("invalid_envelope", 401);
  }

  let envelope: RelayEnvelope;
  try {
    envelope = relayEnvelopeSchema.parse(JSON.parse(input.rawBody.toString("utf8")));
  } catch {
    throw new ConnectProtocolError("invalid_envelope", 401);
  }

  const connection = await store.findConnectionByPublicRef(envelope.connectionPublicRef);
  if (!connection || !connection.enabled) {
    throw new Error("Relay connection not found");
  }

  // Resolve the currently-enabled triggers up front so they can be captured atomically with the
  // claim. The claim only persists this set on the very first insert; every later attempt reuses
  // the stored snapshot. This guarantees a trigger added or re-enabled after the first claim never
  // receives an envelope for an event that predates it — even across a crash-and-recover cycle.
  const currentTriggers = await store.listEnabledTriggers(connection.id);
  const claim = await store.claimDelivery({ companyId: connection.companyId, connectionId: connection.id, envelope, triggerSnapshot: currentTriggers, now: input.now });
  if (!claim.claimed) return { status: "duplicate" as const, envelope, connection, triggers: [] as RelayTrigger[], completedTriggerIds: [] as string[] };

  return { status: "accepted" as const, envelope, connection, triggers: claim.triggerSnapshot ?? currentTriggers, completedTriggerIds: claim.completedTriggerIds };
}

export async function processAndDispatchConnectionRelay(store: ConnectionRelayStore, dispatcher: ConnectionRelayDispatcher, input: Parameters<typeof processConnectionRelay>[1]) {
  const result = await processConnectionRelay(store, input);
  if (result.status === "duplicate") return result;
  await store.updateDelivery?.({ connectionId: result.connection.id, deliveryId: result.envelope.deliveryId, status: "forwarded", now: input.now });
  try {
    for (const trigger of result.triggers) {
      if (result.completedTriggerIds.includes(trigger.id)) continue;
      await dispatcher[trigger.destinationType](trigger, result.envelope, {
        idempotencyKey: relayTriggerIdempotencyKey(result.envelope, trigger),
      });
      await store.markTriggerCompleted?.({ connectionId: result.connection.id, deliveryId: result.envelope.deliveryId, triggerId: trigger.id, now: input.now });
    }
    await store.updateDelivery?.({ connectionId: result.connection.id, deliveryId: result.envelope.deliveryId, status: "delivered", now: input.now });
    return { ...result, status: "delivered" as const };
  } catch (error) {
    const status = result.envelope.attempt >= 10 ? "dead_letter" : "failed";
    await store.updateDelivery?.({ connectionId: result.connection.id, deliveryId: result.envelope.deliveryId, status, error: error instanceof Error ? error.message : "Relay destination dispatch failed", now: input.now });
    return { ...result, status };
  }
}

type RelayChannelItem = { envelope: RelayEnvelope; signature: string; timestamp: string };

function parseRelayChannelItem(raw: unknown): RelayChannelItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as { envelope?: unknown; signature?: unknown; timestamp?: unknown };
  if (typeof item.signature !== "string" || typeof item.timestamp !== "string") return null;
  return { envelope: relayEnvelopeSchema.parse(item.envelope), signature: item.signature, timestamp: item.timestamp };
}

async function readRelaySse(response: Response): Promise<RelayChannelItem[]> {
  const text = await response.text();
  const items: RelayChannelItem[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const item = parseRelayChannelItem(JSON.parse(data));
    if (item) items.push(item);
  }
  return items;
}

export async function pollRelayChannel(options: {
  baseUrl: string;
  createSession: () => Promise<string | { channelToken: string; streamUrl: string }>;
  onEnvelope: (input: { body: Buffer; signature: string; timestamp: string }) => Promise<void>;
  acknowledge?: (deliveryIds: string[]) => Promise<void>;
  lastEventId?: string;
  fetch?: typeof globalThis.fetch;
}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const session = await options.createSession();
  const channelToken = typeof session === "string" ? session : session.channelToken;
  const streamUrl = typeof session === "string" ? "/v1/relay/stream" : session.streamUrl;
  const headers: Record<string, string> = { authorization: `Bearer ${channelToken}`, accept: "text/event-stream, application/json" };
  if (options.lastEventId) headers["last-event-id"] = options.lastEventId;
  let response = await fetcher(new URL(streamUrl, options.baseUrl), { headers });
  let items: RelayChannelItem[] = [];
  if (response.ok && response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
    items = await readRelaySse(response);
  } else {
    response = await fetcher(new URL("/v1/relay/poll?waitSeconds=25", options.baseUrl), { headers });
    if (response.ok) {
      const payload = await response.json() as unknown;
      items = (Array.isArray(payload) ? payload : [payload])
        .map(parseRelayChannelItem)
        .filter((item): item is RelayChannelItem => item !== null);
    }
  }
  if (!response.ok) throw new Error(`Relay channel failed (${response.status})`);
  const acknowledged: string[] = [];
  for (const item of items) {
    await options.onEnvelope({ body: Buffer.from(JSON.stringify(item.envelope)), signature: item.signature, timestamp: item.timestamp });
    acknowledged.push(item.envelope.deliveryId);
  }
  if (acknowledged.length > 0) await options.acknowledge?.(acknowledged);
}

export function connectionTriggerService(db: Db) {
  async function validateDestination(input: { companyId: string; destinationType: RelayTrigger["destinationType"]; destinationId: string }) {
    if (input.destinationType === "routine") {
      const found = await db.select({ id: routinesTable.id }).from(routinesTable).where(and(eq(routinesTable.id, input.destinationId), eq(routinesTable.companyId, input.companyId))).limit(1);
      if (!found.length) throw new Error("Routine destination must belong to the connection company");
    } else if (input.destinationType === "issue_wake") {
      const found = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.destinationId), eq(issues.companyId, input.companyId))).limit(1);
      if (!found.length) throw new Error("Issue destination must belong to the connection company");
    } else {
      const plugin = await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.id, input.destinationId)).limit(1);
      const companySetting = await db.select({ enabled: pluginCompanySettings.enabled }).from(pluginCompanySettings).where(and(eq(pluginCompanySettings.pluginId, input.destinationId), eq(pluginCompanySettings.companyId, input.companyId))).limit(1);
      if (!plugin.length || companySetting[0]?.enabled === false) throw new Error("Plugin destination must be enabled for the connection company");
    }
  }
  return {
    list: (companyId: string, connectionId: string) => db.select().from(connectionTriggers).where(and(eq(connectionTriggers.companyId, companyId), eq(connectionTriggers.connectionId, connectionId))),
    async create(input: { companyId: string; connectionId: string; destinationType: RelayTrigger["destinationType"]; destinationId: string; enabled?: boolean; config?: Record<string, unknown> }) {
      await validateDestination(input);
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.connectionId}))`);
        const connection = await tx.select({ id: toolConnections.id }).from(toolConnections).where(and(eq(toolConnections.id, input.connectionId), eq(toolConnections.companyId, input.companyId))).limit(1);
        if (!connection.length) throw new Error("Connection must belong to the trigger company");
        const existing = await tx.select({ id: connectionTriggers.id }).from(connectionTriggers).where(and(eq(connectionTriggers.companyId, input.companyId), eq(connectionTriggers.connectionId, input.connectionId)));
        if (existing.length >= 3) throw new Error("A connection may have at most 3 triggers");
        return tx.insert(connectionTriggers).values({ ...input, enabled: input.enabled ?? true, config: input.config ?? {} }).returning().then((rows) => rows[0]);
      });
    },
    async update(companyId: string, connectionId: string, id: string, patch: { destinationType?: RelayTrigger["destinationType"]; destinationId?: string; enabled?: boolean; config?: Record<string, unknown> }) {
      const existing = await db.select({ destinationType: connectionTriggers.destinationType, destinationId: connectionTriggers.destinationId }).from(connectionTriggers).where(and(eq(connectionTriggers.companyId, companyId), eq(connectionTriggers.connectionId, connectionId), eq(connectionTriggers.id, id))).limit(1).then((rows) => rows[0]);
      if (!existing) return null;
      await validateDestination({ companyId, destinationType: patch.destinationType ?? existing.destinationType, destinationId: patch.destinationId ?? existing.destinationId });
      return db.update(connectionTriggers).set({ ...patch, updatedAt: new Date() }).where(and(eq(connectionTriggers.companyId, companyId), eq(connectionTriggers.connectionId, connectionId), eq(connectionTriggers.id, id))).returning().then((rows) => rows[0] ?? null);
    },
    async remove(companyId: string, connectionId: string, id: string) {
      return db.delete(connectionTriggers).where(and(eq(connectionTriggers.companyId, companyId), eq(connectionTriggers.connectionId, connectionId), eq(connectionTriggers.id, id))).returning({ id: connectionTriggers.id }).then((rows) => rows.length === 1);
    },
    /**
     * Observability rollup for a connection's inbound webhook relay. Powers the
     * detail-page Triggers panel: cumulative received/forwarded counts (a
     * delivery walks received → forwarded → delivered|failed|dead_letter, so we
     * count by "reached this stage" rather than by current status), the most
     * recent error, and the dead-letter queue.
     */
    async deliverySummary(companyId: string, connectionId: string): Promise<ConnectionTriggerDeliverySummary> {
      const scope = and(
        eq(connectionTriggerDeliveries.companyId, companyId),
        eq(connectionTriggerDeliveries.connectionId, connectionId),
      );
      const [agg] = await db
        .select({
          received: sql<number>`count(*)::int`,
          forwarded: sql<number>`count(*) filter (where ${connectionTriggerDeliveries.forwardedAt} is not null)::int`,
          delivered: sql<number>`count(*) filter (where ${connectionTriggerDeliveries.status} = 'delivered')::int`,
          failed: sql<number>`count(*) filter (where ${connectionTriggerDeliveries.status} = 'failed')::int`,
          deadLetter: sql<number>`count(*) filter (where ${connectionTriggerDeliveries.status} = 'dead_letter')::int`,
        })
        .from(connectionTriggerDeliveries)
        .where(scope);
      const deadLetters = await db
        .select({
          id: connectionTriggerDeliveries.id,
          deliveryId: connectionTriggerDeliveries.deliveryId,
          providerSlug: connectionTriggerDeliveries.providerSlug,
          attempt: connectionTriggerDeliveries.attempt,
          lastError: connectionTriggerDeliveries.lastError,
          receivedAt: connectionTriggerDeliveries.receivedAt,
        })
        .from(connectionTriggerDeliveries)
        .where(and(scope, eq(connectionTriggerDeliveries.status, "dead_letter")))
        .orderBy(desc(connectionTriggerDeliveries.receivedAt))
        .limit(25);
      const [lastErrorRow] = await db
        .select({
          deliveryId: connectionTriggerDeliveries.deliveryId,
          lastError: connectionTriggerDeliveries.lastError,
          updatedAt: connectionTriggerDeliveries.updatedAt,
        })
        .from(connectionTriggerDeliveries)
        .where(and(scope, isNotNull(connectionTriggerDeliveries.lastError)))
        .orderBy(desc(connectionTriggerDeliveries.updatedAt))
        .limit(1);
      return {
        counts: {
          received: agg?.received ?? 0,
          forwarded: agg?.forwarded ?? 0,
          delivered: agg?.delivered ?? 0,
          failed: agg?.failed ?? 0,
          deadLetter: agg?.deadLetter ?? 0,
        },
        lastError:
          lastErrorRow && lastErrorRow.lastError
            ? { message: lastErrorRow.lastError, at: lastErrorRow.updatedAt.toISOString(), deliveryId: lastErrorRow.deliveryId }
            : null,
        deadLetters: deadLetters.map((row) => ({
          id: row.id,
          deliveryId: row.deliveryId,
          providerSlug: row.providerSlug,
          attempt: row.attempt,
          lastError: row.lastError,
          receivedAt: row.receivedAt.toISOString(),
        })),
      };
    },
  };
}

export type ConnectionTriggerDeadLetter = {
  id: string;
  deliveryId: string;
  providerSlug: string;
  attempt: number;
  lastError: string | null;
  receivedAt: string;
};

export type ConnectionTriggerDeliverySummary = {
  counts: { received: number; forwarded: number; delivered: number; failed: number; deadLetter: number };
  lastError: { message: string; at: string; deliveryId: string } | null;
  deadLetters: ConnectionTriggerDeadLetter[];
};
