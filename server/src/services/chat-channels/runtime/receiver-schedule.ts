import { and, eq, gt, inArray, ne, or } from "drizzle-orm";
import { chatEndpoints, chatEndpointLeases, toolConnections, type Db } from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { RECEIVER_LEASE_KEYS, receiverLeaseKey } from "./receiver-policy.js";
import type { ReceiverScope } from "./receiver-work-notifications.js";

export type ReceiverDeadline = { id: string; companyId: string; connectionId: string; dueAt: number | null };

export function chatReceiverSchedule(db: Db, receiver: {
  reconcile: (id: string) => Promise<"owned" | "foreign">;
  stop: (id: string) => Promise<void>;
}) {
  async function load(scope?: ReceiverScope, signal?: AbortSignal): Promise<ReceiverDeadline[]> {
    const result: ReceiverDeadline[] = [];
    let cursor: string | undefined;
    while (true) {
      signal?.throwIfAborted();
      const rows = await db.select({ id: chatEndpoints.id, companyId: chatEndpoints.companyId, connectionId: chatEndpoints.connectionId })
        .from(chatEndpoints).innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
        .where(and(
          inArray(chatEndpoints.provider, Object.keys(RECEIVER_LEASE_KEYS) as ChatProvider[]),
          inArray(chatEndpoints.status, ["verifying", "active", "attention"]),
          eq(toolConnections.status, "active"), eq(toolConnections.enabled, true),
          or(ne(chatEndpoints.status, "attention"), ne(toolConnections.healthStatus, "failed")),
          scope?.kind === "endpoint" ? eq(chatEndpoints.id, scope.id) : undefined,
          scope?.kind === "connection" ? eq(chatEndpoints.connectionId, scope.id) : undefined,
          scope?.kind === "company" ? eq(chatEndpoints.companyId, scope.id) : undefined,
          cursor ? gt(chatEndpoints.id, cursor) : undefined,
        )).orderBy(chatEndpoints.id).limit(100);
      result.push(...rows.map(row => ({ ...row, dueAt: 0 })));
      if (rows.length < 100) return result;
      cursor = rows[rows.length - 1].id;
    }
  }
  async function check(id: string, signal?: AbortSignal): Promise<ReceiverDeadline | null> {
    const scope = { kind: "endpoint", id } as const;
    const [before] = await load(scope, signal);
    if (!before) { await receiver.stop(id); return null; }
    signal?.throwIfAborted();
    const ownership = await receiver.reconcile(id);
    const [after] = await load(scope, signal);
    if (!after) { await receiver.stop(id); return null; }
    if (ownership === "owned") return { ...after, dueAt: null };
    const [endpoint] = await db.select({ provider: chatEndpoints.provider }).from(chatEndpoints).where(eq(chatEndpoints.id, id));
    if (!endpoint) { await receiver.stop(id); return null; }
    const key = receiverLeaseKey(endpoint.provider);
    const [lease] = key ? await db.select({ expiresAt: chatEndpointLeases.expiresAt }).from(chatEndpointLeases).where(and(
      eq(chatEndpointLeases.companyId, after.companyId), eq(chatEndpointLeases.endpointId, id), eq(chatEndpointLeases.leaseKey, key),
    )).limit(1) : [];
    return { ...after, dueAt: Math.max(Date.now() + 1000, lease?.expiresAt.getTime() ?? 0) };
  }
  return { load, check, stop: receiver.stop };
}
