import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { chatEndpoints, chatVoiceInboundCalls, type Db } from "@paperclipai/db";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { voiceInboundScope, type VoiceInboundScope } from "./voice-inbound-notifications.js";

type RetentionEntry = { id: string; companyId: string; endpointId: string; connectionId: string; dueAt: number };
const RETENTION_MS = 7 * 86_400_000;
const eligible = () => and(isNull(chatVoiceInboundCalls.sessionId), isNull(chatVoiceInboundCalls.intakeIssueId),
  isNotNull(chatVoiceInboundCalls.cleanupConfirmedAt), inArray(chatVoiceInboundCalls.state, ["denied", "expired", "ended"]));
const due = (now: number) => and(eligible(), lte(chatVoiceInboundCalls.expiresAt, new Date(now - RETENTION_MS)),
  lte(chatVoiceInboundCalls.updatedAt, new Date(now - RETENTION_MS)));

/** Retain the existing seven-day policy for both timestamps. SQL rounds the wake
 * up to a millisecond so PostgreSQL submillisecond timestamps cannot fire early. */
export function voiceInboundRetention(db: Db) {
  const cursors = new Map<string, string>();
  async function page(scope?: VoiceInboundScope, cursor?: string, signal?: AbortSignal): Promise<RetentionEntry[]> {
    signal?.throwIfAborted();
    if (scope?.kind === "session") return [];
    const rows = await db.select({ id: chatVoiceInboundCalls.id, companyId: chatVoiceInboundCalls.companyId,
      endpointId: chatVoiceInboundCalls.endpointId, connectionId: chatEndpoints.connectionId,
      dueAt: sql<string>`ceil(extract(epoch from greatest(${chatVoiceInboundCalls.expiresAt}, ${chatVoiceInboundCalls.updatedAt})) * 1000) + ${RETENTION_MS}`,
    }).from(chatVoiceInboundCalls)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatVoiceInboundCalls.endpointId), eq(chatEndpoints.companyId, chatVoiceInboundCalls.companyId)))
      .where(and(eligible(),
        scope?.kind === "admission" ? eq(chatVoiceInboundCalls.id, scope.id) : undefined,
        scope?.kind === "endpoint" ? eq(chatVoiceInboundCalls.endpointId, scope.id) : undefined,
        scope?.kind === "connection" ? eq(chatEndpoints.connectionId, scope.id) : undefined,
        scope?.kind === "company" ? eq(chatVoiceInboundCalls.companyId, scope.id) : undefined,
        cursor ? gt(chatVoiceInboundCalls.id, cursor) : undefined)).orderBy(chatVoiceInboundCalls.id).limit(100);
    signal?.throwIfAborted();
    return rows.map(row => ({ ...row, dueAt: Number(row.dueAt) }));
  }
  async function load(scope?: VoiceInboundScope, signal?: AbortSignal): Promise<RetentionEntry[]> {
    const entries: RetentionEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const rows = await page(scope, cursor, signal);
      entries.push(...rows);
      if (rows.length < 100) return entries;
      cursor = rows[rows.length - 1].id;
    }
  }
  async function refresh(scope?: VoiceInboundScope, signal?: AbortSignal) {
    const key = scope ? `${scope.kind}:${scope.id}` : "*";
    const rows = await page(scope, cursors.get(key), signal), complete = rows.length < 100;
    signal?.throwIfAborted();
    if (complete) cursors.delete(key); else cursors.set(key, rows[rows.length - 1].id);
    return { rows, complete };
  }
  async function check(id: string, signal?: AbortSignal): Promise<RetentionEntry | null> {
    signal?.throwIfAborted();
    const deleted = await db.transaction(async tx => {
      // Eligibility and both age conditions are current-state predicates under
      // the admission lock. Cached discovery cannot delete a changed binding.
      const [row] = await tx.select({ id: chatVoiceInboundCalls.id }).from(chatVoiceInboundCalls)
        .where(and(eq(chatVoiceInboundCalls.id, id), due(Date.now()))).for("update");
      if (!row) return false;
      signal?.throwIfAborted();
      return (await tx.delete(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.id, id), due(Date.now())))
        .returning({ id: chatVoiceInboundCalls.id })).length > 0;
    });
    if (deleted) return null;
    return (await load({ kind: "admission", id }, signal))[0] ?? null;
  }
  /** Explicit compatibility path; never register this bulk operation on a tick. */
  async function prune() {
    await db.delete(chatVoiceInboundCalls).where(due(Date.now()));
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    cursors.clear();
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.voiceInboundRetention, decodeScope: voiceInboundScope,
      matches: (entry, scope) => !scope || scope.kind !== "session" && (scope.kind === "admission" ? entry.id : scope.kind === "endpoint" ? entry.endpointId : scope.kind === "connection" ? entry.connectionId : entry.companyId) === scope.id,
      load: refresh, check: (entry, signal) => check(entry.id, signal),
    }, canRun);
  }
  return { load, check, prune, register };
}
