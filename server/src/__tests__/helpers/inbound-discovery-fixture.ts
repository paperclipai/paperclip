import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, getTableName, sql } from "drizzle-orm";
import { agents, chatActions, chatDeliveries, chatEndpoints, companies, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { createChatConversationDeliveryQueue } from "../../services/chat-channels/inbound/conversation-queue.js";
import { chatChannelService } from "../../services/chat-channels.js";

export type CapturedQuery = { sql: string; params: unknown[] };
export type QueueFactory = typeof createChatConversationDeliveryQueue;
export type ServiceFactory = typeof chatChannelService;
export const fixtureTime = new Date("2026-01-01T12:00:00.000Z");

export async function seedInboundDiscovery(db: Db, history = 20, payloadBytes = 0) {
  const companyId = randomUUID(), agentId = randomUUID(), endpointId = randomUUID();
  const applicationId = randomUUID(), connectionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic inbound discovery", issuePrefix: `Q${companyId.replaceAll("-", "").slice(0, 10).toUpperCase()}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "codex_local" });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Chat fixture", type: "chat" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Chat", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" });
  await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, provider: "slack", publicId: randomUUID(), status: "active" });
  const payload = randomBytes(Math.ceil(payloadBytes * 3 / 4)).toString("base64");
  await db.$client.unsafe(`insert into chat_deliveries (company_id, endpoint_id, provider_event_id, deduplication_key, event_kind, normalized_event, state, received_at)
    select $1::uuid, $2::uuid, 'history-' || n, 'history-' || n, 'message', jsonb_build_object('conversation', jsonb_build_object('externalThreadId', 'slack:fixture'), 'message', jsonb_build_object('text', $3::text)), 'processed', $4::timestamptz + n * interval '1 millisecond' from generate_series(1, $5::int) n`, [companyId, endpointId, payload, fixtureTime.toISOString(), history]);
  await db.$client.unsafe(`insert into chat_actions (company_id, endpoint_id, delivery_id, kind, provider_action_id, status, payload)
    select company_id, endpoint_id, id, 'inbound_wakeup', 'history-' || provider_event_id, 'processed', '{}'::jsonb from chat_deliveries where company_id = $1::uuid`, [companyId]);
  const threadId = "slack:fixture";
  async function delivery(overrides: Partial<typeof chatDeliveries.$inferInsert> = {}) {
    const id = randomUUID();
    const [row] = await db.insert(chatDeliveries).values({ id, companyId, endpointId, providerEventId: id, deduplicationKey: id,
      eventKind: "message", state: "received", receivedAt: fixtureTime, nextAttemptAt: fixtureTime,
      normalizedEvent: { conversation: { externalThreadId: threadId }, message: { providerSentAt: fixtureTime.toISOString(), providerMessageSequence: "2", text: payload } }, ...overrides }).returning();
    return row!;
  }
  async function action(deliveryId: string | null, overrides: Partial<typeof chatActions.$inferInsert> = {}) {
    const [row] = await db.insert(chatActions).values({ companyId, endpointId, deliveryId, kind: "inbound_wakeup", status: "issued", providerActionId: randomUUID(), ...overrides }).returning();
    return row!;
  }
  async function anotherEndpoint() {
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
    const nextConnection = randomUUID(), nextEndpoint = randomUUID();
    await db.insert(toolConnections).values({ ...connection!, id: nextConnection, uid: randomUUID() });
    await db.insert(chatEndpoints).values({ ...endpoint!, id: nextEndpoint, connectionId: nextConnection, publicId: randomUUID() });
    return nextEndpoint;
  }
  const pending = await delivery({ state: "processed" });
  await action(pending.id, { result: { retryAt: "2099-01-01T12:00:00.000Z" } });
  await delivery({ receivedAt: new Date(fixtureTime.getTime() + 1000), normalizedEvent: { conversation: { externalThreadId: threadId }, message: { providerSentAt: fixtureTime.toISOString(), providerMessageSequence: "3" } } });
  await db.$client.unsafe("ANALYZE chat_deliveries");
  await db.$client.unsafe("ANALYZE chat_actions");
  return { companyId, endpointId, threadId, delivery, action, anotherEndpoint, pending };
}

export function queueOptions() {
  return { DELIVERY_DRAIN_LIMIT: 25, DELIVERY_LEASE_TTL_MS: 60_000, durableExternalThreadIdentity: (id: string) => id,
    conversationDrainKey: (endpoint: string, thread: string) => `${endpoint}:${thread}`, liveInboundMessages: new Map(),
    githubManualMessages: new WeakMap(), githubAutomaticMessages: new WeakMap(), githubIssueMessages: new WeakMap(),
  } as Parameters<QueueFactory>[1];
}

export async function captureInboundQuery(db: Db, fixture: Awaited<ReturnType<typeof seedInboundDiscovery>>, kind: "deadline" | "head" | "ready",
  queueFactory: QueueFactory = createChatConversationDeliveryQueue, serviceFactory: ServiceFactory = chatChannelService, onlyDeliveryId?: string): Promise<CapturedQuery> {
  let captured: CapturedQuery | undefined;
  const stop = new Error("inbound discovery query captured");
  const captureDb = new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields), from = builder.from.bind(builder);
      builder.from = ((table: Parameters<typeof from>[0]) => {
        const selection = from(table), execute = selection.execute.bind(selection);
        selection.execute = async () => {
          const candidate = selection.toSQL();
          if (getTableName(table as typeof chatDeliveries) === "chat_deliveries" && candidate.sql.includes("inbound_wakeup") &&
            (kind !== "ready" || candidate.params.includes("reaction_added"))) {
            captured = candidate; throw stop;
          }
          if (kind === "ready") return [];
          return execute();
        };
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  }});
  try {
    if (kind === "ready") await serviceFactory(captureDb, { heartbeat: {} } as Parameters<ServiceFactory>[1]).processPendingDeliveries(25, onlyDeliveryId, false);
    else {
      const queue = queueFactory(captureDb, queueOptions());
      if (kind === "deadline") await queue.nextInboundDeliveryAt();
      else await queue.drainConversationDeliveries(fixture.endpointId, fixture.threadId);
    }
  } catch (error) { if (error !== stop) throw error; }
  if (!captured) throw new Error(`Did not capture real ${kind} query`);
  return captured;
}

export async function runQuery(db: Db, query: CapturedQuery) {
  return db.$client.unsafe(query.sql, query.params as never[]).values();
}

export async function pendingIds(db: Db, predicate: ReturnType<typeof sql>, companyId: string) {
  return db.select({ id: chatDeliveries.id }).from(chatDeliveries).where(and(eq(chatDeliveries.companyId, companyId), predicate)).orderBy(chatDeliveries.id);
}
