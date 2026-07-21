import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionTriggerDeliveries, connectionTriggers, issues, toolConnections } from "@paperclipai/db";
import {
  ConnectProtocolError,
  relayEnvelopeSchema,
  verifyRelaySignature,
  type RelayEnvelope,
} from "@paperclip/connect-protocol";
import { secretService } from "./secrets.js";
import { routineService } from "./routines.js";
import { heartbeatService } from "./heartbeat.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export type RelayTrigger = {
  id: string;
  destinationType: "routine" | "issue_wake" | "plugin_worker";
  destinationId: string;
  config?: Record<string, unknown>;
};

export type ConnectionRelayStore = {
  findConnectionByPublicRef(publicRef: string): Promise<{ id: string; companyId: string; enabled: boolean } | null>;
  createDeliveryIfAbsent(input: { companyId: string; connectionId: string; envelope: RelayEnvelope }): Promise<boolean>;
  listEnabledTriggers(connectionId: string): Promise<RelayTrigger[]>;
  updateDelivery?(input: { connectionId: string; deliveryId: string; status: "forwarded" | "delivered" | "failed" | "dead_letter"; error?: string | null; now?: Date }): Promise<void>;
};

type RelayConnectionConfig = { relay?: { publicRef?: string; secretId?: string; secretVersion?: string } };

export function connectionRelayStore(db: Db): ConnectionRelayStore {
  return {
    async findConnectionByPublicRef(publicRef) {
      const rows = await db.select({ id: toolConnections.id, companyId: toolConnections.companyId, enabled: toolConnections.enabled, config: toolConnections.config }).from(toolConnections);
      return rows.find((row) => (row.config as RelayConnectionConfig).relay?.publicRef === publicRef) ?? null;
    },
    async createDeliveryIfAbsent({ companyId, connectionId, envelope }) {
      const inserted = await db.insert(connectionTriggerDeliveries).values({ companyId, connectionId, deliveryId: envelope.deliveryId, providerSlug: envelope.providerSlug, attempt: envelope.attempt, envelope, receivedAt: new Date(envelope.receivedAt) }).onConflictDoNothing().returning({ id: connectionTriggerDeliveries.id });
      return inserted.length === 1;
    },
    async listEnabledTriggers(connectionId) {
      return db.select({ id: connectionTriggers.id, destinationType: connectionTriggers.destinationType, destinationId: connectionTriggers.destinationId, config: connectionTriggers.config }).from(connectionTriggers).where(and(eq(connectionTriggers.connectionId, connectionId), eq(connectionTriggers.enabled, true)));
    },
    async updateDelivery({ connectionId, deliveryId, status, error, now = new Date() }) {
      await db.update(connectionTriggerDeliveries).set({ status, forwardedAt: status === "forwarded" ? now : undefined, deliveredAt: status === "delivered" ? now : undefined, lastError: error ?? null, updatedAt: now }).where(and(eq(connectionTriggerDeliveries.connectionId, connectionId), eq(connectionTriggerDeliveries.deliveryId, deliveryId)));
    },
  };
}

export function connectionRelaySecretResolver(db: Db) {
  const secrets = secretService(db);
  return async (publicRef: string): Promise<Buffer> => {
    const rows = await db.select({ companyId: toolConnections.companyId, config: toolConnections.config }).from(toolConnections);
    const connection = rows.find((row) => (row.config as RelayConnectionConfig).relay?.publicRef === publicRef);
    const relay = connection && (connection.config as RelayConnectionConfig).relay;
    if (!connection || !relay?.secretId) throw new Error("Relay connection or secret not found");
    const parsedVersion = relay.secretVersion && /^\d+$/.test(relay.secretVersion) ? Number(relay.secretVersion) : "latest";
    const value = await secrets.resolveSecretValue(connection.companyId, relay.secretId, parsedVersion);
    return Buffer.from(value, "base64");
  };
}

export type ConnectionRelayDispatcher = Record<RelayTrigger["destinationType"], (trigger: RelayTrigger, envelope: RelayEnvelope) => Promise<void>>;

export function connectionRelayDispatcher(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
): ConnectionRelayDispatcher {
  const routines = routineService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
  return {
    routine: async (trigger, envelope) => {
      await routines.runRoutine(trigger.destinationId, {
        source: "api",
        payload: { connectionRelay: envelope },
        idempotencyKey: `connection-relay:${envelope.deliveryId}:${trigger.id}`,
      });
    },
    issue_wake: async (trigger, envelope) => {
      const issue = await db
        .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, trigger.destinationId))
        .then((rows) => rows[0] ?? null);
      if (!issue?.assigneeAgentId) throw new Error("Relay issue destination has no assigned agent");
      await heartbeat.wakeup(issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "connection_trigger",
        idempotencyKey: `connection-relay:${envelope.deliveryId}:${trigger.id}`,
        requestedByActorType: "system",
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          wakeReason: "connection_trigger",
          connectionRelay: envelope,
        },
      });
    },
    plugin_worker: async (trigger, envelope) => {
      if (!options.pluginWorkerManager) throw new Error("Plugin worker manager is unavailable");
      const endpointKey = typeof trigger.config?.endpointKey === "string" ? trigger.config.endpointKey : "connection-relay";
      const rawBody = Buffer.from(envelope.provider.bodyB64, "base64").toString("utf8");
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = undefined;
      }
      await options.pluginWorkerManager.call(trigger.destinationId, "handleWebhook", {
        endpointKey,
        headers: envelope.provider.headers,
        rawBody,
        parsedBody,
        requestId: envelope.deliveryId,
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

  const inserted = await store.createDeliveryIfAbsent({ companyId: connection.companyId, connectionId: connection.id, envelope });
  if (!inserted) return { status: "duplicate" as const, envelope, connection, triggers: [] as RelayTrigger[] };

  return { status: "accepted" as const, envelope, connection, triggers: await store.listEnabledTriggers(connection.id) };
}

export async function processAndDispatchConnectionRelay(store: ConnectionRelayStore, dispatcher: ConnectionRelayDispatcher, input: Parameters<typeof processConnectionRelay>[1]) {
  const result = await processConnectionRelay(store, input);
  if (result.status === "duplicate") return result;
  await store.updateDelivery?.({ connectionId: result.connection.id, deliveryId: result.envelope.deliveryId, status: "forwarded", now: input.now });
  try {
    for (const trigger of result.triggers) await dispatcher[trigger.destinationType](trigger, result.envelope);
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
  return {
    list: (companyId: string, connectionId: string) => db.select().from(connectionTriggers).where(and(eq(connectionTriggers.companyId, companyId), eq(connectionTriggers.connectionId, connectionId))),
    async create(input: { companyId: string; connectionId: string; destinationType: RelayTrigger["destinationType"]; destinationId: string; enabled?: boolean; config?: Record<string, unknown> }) {
      const existing = await db.select({ id: connectionTriggers.id }).from(connectionTriggers).where(eq(connectionTriggers.connectionId, input.connectionId));
      if (existing.length >= 3) throw new Error("A connection may have at most 3 triggers");
      return db.insert(connectionTriggers).values({ ...input, enabled: input.enabled ?? true, config: input.config ?? {} }).returning().then((rows) => rows[0]);
    },
    async update(companyId: string, connectionId: string, id: string, patch: { destinationType?: RelayTrigger["destinationType"]; destinationId?: string; enabled?: boolean; config?: Record<string, unknown> }) {
      return db.update(connectionTriggers).set({ ...patch, updatedAt: new Date() }).where(and(eq(connectionTriggers.companyId, companyId), eq(connectionTriggers.connectionId, connectionId), eq(connectionTriggers.id, id))).returning().then((rows) => rows[0] ?? null);
    },
    async remove(companyId: string, connectionId: string, id: string) {
      return db.delete(connectionTriggers).where(and(eq(connectionTriggers.companyId, companyId), eq(connectionTriggers.connectionId, connectionId), eq(connectionTriggers.id, id))).returning({ id: connectionTriggers.id }).then((rows) => rows.length === 1);
    },
  };
}
