import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionTriggerDeliveries, connectionTriggers, toolConnections } from "@paperclipai/db";
import {
  ConnectProtocolError,
  relayEnvelopeSchema,
  verifyRelaySignature,
  type RelayEnvelope,
} from "@paperclip/connect-protocol";
import { secretService } from "./secrets.js";

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

export async function pollRelayChannel(options: { baseUrl: string; createSession: () => Promise<string>; onEnvelope: (input: { body: Buffer; signature: string; timestamp: string }) => Promise<void>; fetch?: typeof globalThis.fetch }) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const channelToken = await options.createSession();
  const headers = { authorization: `Bearer ${channelToken}`, accept: "text/event-stream, application/json" };
  let response = await fetcher(new URL("/v1/relay/channel", options.baseUrl), { headers });
  if (!response.ok || !response.body) response = await fetcher(new URL("/v1/relay/poll", options.baseUrl), { headers });
  if (!response.ok) throw new Error(`Relay channel failed (${response.status})`);
  const payload = await response.json() as unknown;
  for (const raw of Array.isArray(payload) ? payload : [payload]) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { envelope?: unknown; signature?: unknown; timestamp?: unknown };
    if (typeof item.signature !== "string" || typeof item.timestamp !== "string") continue;
    const envelope = relayEnvelopeSchema.parse(item.envelope);
    await options.onEnvelope({ body: Buffer.from(JSON.stringify(envelope)), signature: item.signature, timestamp: item.timestamp });
  }
}

export function connectionTriggerService(db: Db) {
  return {
    list: (connectionId: string) => db.select().from(connectionTriggers).where(eq(connectionTriggers.connectionId, connectionId)),
    async create(input: { companyId: string; connectionId: string; destinationType: RelayTrigger["destinationType"]; destinationId: string; enabled?: boolean; config?: Record<string, unknown> }) {
      const existing = await db.select({ id: connectionTriggers.id }).from(connectionTriggers).where(eq(connectionTriggers.connectionId, input.connectionId));
      if (existing.length >= 3) throw new Error("A connection may have at most 3 triggers");
      return db.insert(connectionTriggers).values({ ...input, enabled: input.enabled ?? true, config: input.config ?? {} }).returning().then((rows) => rows[0]);
    },
    async update(id: string, patch: { destinationType?: RelayTrigger["destinationType"]; destinationId?: string; enabled?: boolean; config?: Record<string, unknown> }) {
      return db.update(connectionTriggers).set({ ...patch, updatedAt: new Date() }).where(eq(connectionTriggers.id, id)).returning().then((rows) => rows[0] ?? null);
    },
    async remove(id: string) {
      return db.delete(connectionTriggers).where(eq(connectionTriggers.id, id)).returning({ id: connectionTriggers.id }).then((rows) => rows.length === 1);
    },
  };
}
