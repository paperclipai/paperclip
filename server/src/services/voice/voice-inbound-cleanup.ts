import { and, eq, gt, isNull } from "drizzle-orm";
import { chatEndpoints, chatVoiceInboundCalls, chatVoiceSessions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { notifyVoiceInbound, voiceInboundScope, type VoiceInboundScope } from "./voice-inbound-notifications.js";
import { notifyVoiceRecovery } from "./voice-recovery-notifications.js";

type Admission = typeof chatVoiceInboundCalls.$inferSelect;
type Session = typeof chatVoiceSessions.$inferSelect;
export type VoiceInboundEntry = { id: string; sessionId: string | null; companyId: string; endpointId: string; connectionId: string; dueAt: number };
const terminal = (session: Session) => ["ended", "failed", "expired"].includes(session.state) && session.endedAt !== null;
const rejected = (call: Admission) => ["denied", "expired", "ended"].includes(call.state);

/** A bound call belongs to live-session recovery. Admission cleanup may only
 * hand off a rejection or copy confirmed termination; it never ends that leg. */
export function inboundCleanupAt(call: Admission, session: Session | null): number | null {
  if (call.cleanupConfirmedAt) return null;
  if (session) {
    if (terminal(session) || (call.state === "approving" && session.callerAuthority !== "guest_intake")) return 0;
    return rejected(call) && session.state !== "ending" ? 0 : null;
  }
  if (call.cleanupNextAttemptAt) return call.cleanupNextAttemptAt.getTime();
  return ["awaiting_approval", "guest_intake", "approving"].includes(call.state) ? call.expiresAt.getTime() : 0;
}

/** Caller locks company endpoints before this check, matching admission ingress. */
export async function assertVoiceInboundCleanupSettled(db: Pick<Db, "select">, companyId: string) {
  const [pending] = await db.select({ id: chatVoiceInboundCalls.id }).from(chatVoiceInboundCalls)
    .where(and(eq(chatVoiceInboundCalls.companyId, companyId), isNull(chatVoiceInboundCalls.cleanupConfirmedAt))).limit(1);
  if (pending) throw conflict("Incoming phone calls must finish cleanup before deleting this company");
}

export function voiceInboundCleanup(db: Db, terminate: (call: Admission) => Promise<boolean>) {
  const cursors = new Map<string, string>();
  async function page(scope?: VoiceInboundScope, cursor?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const rows = await db.select({ call: chatVoiceInboundCalls, session: chatVoiceSessions, connectionId: chatEndpoints.connectionId })
      .from(chatVoiceInboundCalls)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatVoiceInboundCalls.endpointId), eq(chatEndpoints.companyId, chatVoiceInboundCalls.companyId)))
      .leftJoin(chatVoiceSessions, and(eq(chatVoiceSessions.id, chatVoiceInboundCalls.sessionId), eq(chatVoiceSessions.companyId, chatVoiceInboundCalls.companyId)))
      .where(and(isNull(chatVoiceInboundCalls.cleanupConfirmedAt),
        scope?.kind === "admission" ? eq(chatVoiceInboundCalls.id, scope.id) : undefined,
        scope?.kind === "session" ? eq(chatVoiceInboundCalls.sessionId, scope.id) : undefined,
        scope?.kind === "endpoint" ? eq(chatVoiceInboundCalls.endpointId, scope.id) : undefined,
        scope?.kind === "connection" ? eq(chatEndpoints.connectionId, scope.id) : undefined,
        scope?.kind === "company" ? eq(chatVoiceInboundCalls.companyId, scope.id) : undefined,
        cursor ? gt(chatVoiceInboundCalls.id, cursor) : undefined))
      .orderBy(chatVoiceInboundCalls.id).limit(100);
    signal?.throwIfAborted();
    return rows;
  }
  function entries(rows: Awaited<ReturnType<typeof page>>): VoiceInboundEntry[] {
    const result: VoiceInboundEntry[] = [];
    for (const { call, session, connectionId } of rows) {
      const dueAt = inboundCleanupAt(call, session);
      if (dueAt !== null) result.push({ id: call.id, sessionId: call.sessionId, companyId: call.companyId, endpointId: call.endpointId, connectionId, dueAt });
    }
    return result;
  }
  async function load(scope?: VoiceInboundScope, signal?: AbortSignal): Promise<VoiceInboundEntry[]> {
    const result: VoiceInboundEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const rows = await page(scope, cursor, signal);
      result.push(...entries(rows));
      if (rows.length < 100) return result;
      cursor = rows[rows.length - 1].call.id;
    }
  }
  async function refresh(scope?: VoiceInboundScope, signal?: AbortSignal) {
    const key = scope ? `${scope.kind}:${scope.id}` : "*";
    const rows = await page(scope, cursors.get(key), signal), result = entries(rows), complete = rows.length < 100;
    signal?.throwIfAborted();
    if (complete) cursors.delete(key); else cursors.set(key, rows[rows.length - 1].call.id);
    return { rows: result, complete };
  }
  async function check(id: string, signal?: AbortSignal): Promise<VoiceInboundEntry | null> {
    signal?.throwIfAborted();
    const claimed = await db.transaction(async tx => {
      // Discovery grants no ownership. Approval and lifecycle use this same lock,
      // always before the session lock; no provider request runs in this TX.
      const [call] = await tx.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, id)).for("update");
      if (!call || call.cleanupConfirmedAt) return null;
      const [session] = await tx.select().from(chatVoiceSessions).where(and(
        eq(chatVoiceSessions.companyId, call.companyId), eq(chatVoiceSessions.endpointId, call.endpointId),
        eq(chatVoiceSessions.providerSessionId, call.providerSessionId))).for("update");
      if (session) {
        if (terminal(session)) {
          if (call.sessionId && call.sessionId !== session.id) throw conflict("Incoming call cleanup has conflicting session ownership");
          await notifyVoiceInbound(tx, { kind: "admission", id });
          await tx.update(chatVoiceInboundCalls).set({ ...(!rejected(call) ? { state: "ended" as const } : {}), cleanupConfirmedAt: session.endedAt, cleanupNextAttemptAt: null, updatedAt: new Date() }).where(eq(chatVoiceInboundCalls.id, id));
          return null;
        }
        if (rejected(call)) {
          if (call.sessionId !== session.id) {
            if (call.sessionId || session.mode !== "inbound_phone" || session.idempotencyKey !== `inbound:${call.id}`
              || session.generation !== call.generation || session.credentialFingerprint !== call.credentialFingerprint
              || session.toolTokenHash !== call.toolTokenHash) throw conflict("Incoming call cleanup has conflicting session ownership");
            await notifyVoiceInbound(tx, { kind: "admission", id });
            await tx.update(chatVoiceInboundCalls).set({ sessionId: session.id, updatedAt: new Date() }).where(eq(chatVoiceInboundCalls.id, id));
          }
          if (session.state !== "ending") {
            await notifyVoiceRecovery(tx, { kind: "session", id: session.id });
            await tx.update(chatVoiceSessions).set({ state: "ending", updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
          }
          return null;
        }
        if (call.sessionId !== session.id || (call.state === "approving" && session.callerAuthority !== "guest_intake")) {
          // Repair older commits that inserted/promoted an authorized session
          // before the separate admission binding write. Never infer approval
          // from a matching provider ID alone.
          if (!["approving", "approved"].includes(call.state) || !call.approvedByUserId
            || session.idempotencyKey !== `inbound:${call.id}` || session.callerId !== call.approvedByUserId
            || session.approvedByUserId !== call.approvedByUserId || session.callerAuthority !== call.callerAuthority
            || session.generation !== call.generation || session.credentialFingerprint !== call.credentialFingerprint
            || session.toolTokenHash !== call.toolTokenHash || (call.requestedIssueId !== null && session.issueId !== call.requestedIssueId))
            throw conflict("Incoming call cleanup has conflicting session ownership");
          await notifyVoiceInbound(tx, { kind: "admission", id });
          await tx.update(chatVoiceInboundCalls).set({ state: "approved", sessionId: session.id, updatedAt: new Date() }).where(eq(chatVoiceInboundCalls.id, id));
          call.state = "approved"; call.sessionId = session.id;
        }
        return null;
      }
      if (call.sessionId) throw conflict("Incoming call cleanup owner is missing");
      const dueAt = inboundCleanupAt(call, null);
      if (dueAt === null || dueAt > Date.now()) return null;
      await notifyVoiceInbound(tx, { kind: "admission", id });
      const [claim] = await tx.update(chatVoiceInboundCalls).set({
        ...(!rejected(call) ? { state: "expired" as const } : {}),
        cleanupNextAttemptAt: new Date(Date.now() + 30_000), updatedAt: new Date(),
      }).where(eq(chatVoiceInboundCalls.id, id)).returning();
      return claim;
    });
    if (claimed) {
      signal?.throwIfAborted();
      if (await terminate(claimed)) await db.transaction(async tx => {
        await notifyVoiceInbound(tx, { kind: "admission", id });
        await tx.update(chatVoiceInboundCalls).set({ cleanupConfirmedAt: new Date(), cleanupNextAttemptAt: null, updatedAt: new Date() })
          .where(and(eq(chatVoiceInboundCalls.id, id), isNull(chatVoiceInboundCalls.cleanupConfirmedAt), eq(chatVoiceInboundCalls.cleanupNextAttemptAt, claimed.cleanupNextAttemptAt!)));
      });
    }
    return (await load({ kind: "admission", id }, signal))[0] ?? null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    cursors.clear();
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.voiceInboundCleanup, decodeScope: voiceInboundScope,
      matches: (entry, scope) => !scope || (scope.kind === "admission" ? entry.id : scope.kind === "session" ? entry.sessionId : scope.kind === "endpoint" ? entry.endpointId : scope.kind === "connection" ? entry.connectionId : entry.companyId) === scope.id,
      load: refresh, check: (entry, signal) => check(entry.id, signal),
    }, canRun);
  }
  return { load, check, register };
}
