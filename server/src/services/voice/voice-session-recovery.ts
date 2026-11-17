import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { chatEndpoints, chatVoiceSessions, toolConnections, type Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";
import { withVoiceSessionChange, type VoiceRecoveryScope } from "./voice-recovery-notifications.js";

export const LIVE_VOICE_STATES = ["reserved", "creating", "creation_unknown", "connecting", "active", "ending"] as const;
type Session = typeof chatVoiceSessions.$inferSelect;
export type VoiceRecoveryEntry = { id: string; companyId: string; endpointId: string; connectionId: string; dueAt: number };
type Candidate<T = Pick<Session, "id" | "companyId" | "endpointId" | "providerSessionId" | "expiresAt" | "updatedAt" | "generation" | "state" | "errorCode">> = { session: T; connectionId: string; endpointStatus: string; enabled: boolean; generation: number };

export function voiceSessionRecoveryAt(row: Candidate, featureEnabled: boolean): number {
  const session = row.session;
  if (!session.providerSessionId) return session.expiresAt.getTime() + 120_001;
  const changed = !featureEnabled || !row.enabled || !["active", "verifying"].includes(row.endpointStatus)
    || session.generation !== row.generation || session.state === "ending";
  if (changed) return session.errorCode === "cleanup_pending" ? session.updatedAt.getTime() + 30_000 : 0;
  if (["connecting", "active"].includes(session.state)) return Math.min(session.expiresAt.getTime(), session.updatedAt.getTime() + 30_000);
  return session.expiresAt.getTime();
}

export function voiceSessionRecovery(db: Db, operations: {
  authorize(session: Session): Promise<void>;
  inspect(session: Session): Promise<{ endedAt?: unknown } | null>;
  close(session: Session): Promise<unknown>;
}) {
  function sessionConditions(scope?: VoiceRecoveryScope, cursor?: string) {
    return and(inArray(chatVoiceSessions.state, [...LIVE_VOICE_STATES]),
      scope?.kind === "session" ? eq(chatVoiceSessions.id, scope.id) : undefined,
      scope?.kind === "endpoint" ? eq(chatVoiceSessions.endpointId, scope.id) : undefined,
      scope?.kind === "connection" ? eq(toolConnections.id, scope.id) : undefined,
      scope?.kind === "company" ? eq(chatVoiceSessions.companyId, scope.id) : undefined,
      cursor ? gt(chatVoiceSessions.id, cursor) : undefined);
  }
  async function candidates(scope?: VoiceRecoveryScope, signal?: AbortSignal) {
    const rows: Candidate<Session>[] = [];
    let cursor: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const page = await db.select({ session: chatVoiceSessions, connectionId: toolConnections.id,
        endpointStatus: chatEndpoints.status, enabled: toolConnections.enabled, generation: sql<number>`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0)` })
        .from(chatVoiceSessions)
        .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatVoiceSessions.endpointId), eq(chatEndpoints.companyId, chatVoiceSessions.companyId)))
        .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatVoiceSessions.companyId)))
        .where(sessionConditions(scope, cursor))
        .orderBy(chatVoiceSessions.id).limit(100);
      rows.push(...page);
      if (page.length < 100) return rows;
      cursor = page[page.length - 1].session.id;
    }
  }
  async function load(scope?: VoiceRecoveryScope, signal?: AbortSignal): Promise<VoiceRecoveryEntry[]> {
    const rows = await candidates(scope, signal);
    if (!rows.length) return [];
    const enabled = (await instanceSettingsService(db).getExperimental()).enableChatConnectors;
    return rows.map(row => ({ id: row.session.id, companyId: row.session.companyId, endpointId: row.session.endpointId,
      connectionId: row.connectionId, dueAt: voiceSessionRecoveryAt(row, enabled) }));
  }
  type Parent = { id: string; companyId: string; connectionId: string; signature: string | null };
  type Scan = { phase: "parents" | "sessions"; cursor?: string; parents: Map<string, Parent> };
  const parents = new Map<string, Parent>();
  const scans = new Map<string, Scan>();
  function scopeKey(scope?: VoiceRecoveryScope) { return scope ? `${scope.kind}:${scope.id}` : "*"; }
  function parentMatches(row: Parent, scope?: VoiceRecoveryScope) {
    return !scope || (scope.kind === "endpoint" ? row.id : scope.kind === "connection" ? row.connectionId : row.companyId) === scope.id;
  }
  function remember(target: Map<string, Parent>, row: Parent) {
    const prior = target.get(row.id);
    target.set(row.id, prior && prior.signature !== row.signature ? { ...row, signature: null } : row);
  }
  async function refresh(scope?: VoiceRecoveryScope, signal?: AbortSignal): Promise<{ rows: VoiceRecoveryEntry[] | null; complete: boolean }> {
    const key = scopeKey(scope);
    const scan = scans.get(key) ?? { phase: scope && scope.kind !== "session" ? "parents" as const : "sessions" as const, parents: new Map<string, Parent>() };
    signal?.throwIfAborted();
    if (scan.phase === "parents") {
      const page = await db.select({ id: chatEndpoints.id, companyId: chatEndpoints.companyId, connectionId: toolConnections.id,
        endpointStatus: chatEndpoints.status, enabled: toolConnections.enabled,
        generation: sql<number>`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0)` })
        .from(chatEndpoints).innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
        .where(and(scope?.kind === "endpoint" ? eq(chatEndpoints.id, scope.id) : undefined,
          scope?.kind === "connection" ? eq(toolConnections.id, scope.id) : undefined,
          scope?.kind === "company" ? eq(chatEndpoints.companyId, scope.id) : undefined,
          scan.cursor ? gt(chatEndpoints.id, scan.cursor) : undefined))
        .orderBy(chatEndpoints.id).limit(100);
      const enabled = page.length ? (await instanceSettingsService(db).getExperimental()).enableChatConnectors : false;
      const next = new Map(scan.parents);
      for (const row of page) remember(next, { id: row.id, companyId: row.companyId, connectionId: row.connectionId,
        signature: JSON.stringify([row.connectionId, row.endpointStatus, row.enabled, row.generation, enabled]) });
      signal?.throwIfAborted();
      if (page.length === 100) {
        scans.set(key, { phase: "parents", cursor: page[page.length - 1].id, parents: next });
        return { rows: [], complete: false };
      }
      const previous = [...parents.values()].filter(row => parentMatches(row, scope));
      if (previous.length === next.size && previous.every(row => row.signature !== null && next.get(row.id)?.signature === row.signature)) {
        scans.delete(key); return { rows: null, complete: true };
      }
      scans.set(key, { phase: "sessions", parents: next });
      return { rows: [], complete: false };
    }
    const page = await db.select({ session: { id: chatVoiceSessions.id, companyId: chatVoiceSessions.companyId,
      endpointId: chatVoiceSessions.endpointId, state: chatVoiceSessions.state, providerSessionId: chatVoiceSessions.providerSessionId,
      expiresAt: chatVoiceSessions.expiresAt, updatedAt: chatVoiceSessions.updatedAt, generation: chatVoiceSessions.generation,
      errorCode: chatVoiceSessions.errorCode }, connectionId: toolConnections.id,
      endpointStatus: chatEndpoints.status, enabled: toolConnections.enabled,
      generation: sql<number>`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0)` })
      .from(chatVoiceSessions)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatVoiceSessions.endpointId), eq(chatEndpoints.companyId, chatVoiceSessions.companyId)))
      .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatVoiceSessions.companyId)))
      .where(sessionConditions(scope, scan.cursor))
      .orderBy(chatVoiceSessions.id).limit(100);
    const enabled = page.length ? (await instanceSettingsService(db).getExperimental()).enableChatConnectors : false;
    const next = new Map(scan.parents);
    for (const row of page) remember(next, { id: row.session.endpointId, companyId: row.session.companyId, connectionId: row.connectionId,
      signature: JSON.stringify([row.connectionId, row.endpointStatus, row.enabled, row.generation, enabled]) });
    const rows = page.map(row => ({ id: row.session.id, companyId: row.session.companyId, endpointId: row.session.endpointId,
      connectionId: row.connectionId, dueAt: voiceSessionRecoveryAt(row, enabled) }));
    signal?.throwIfAborted();
    const complete = page.length < 100;
    if (!complete) scans.set(key, { phase: "sessions", cursor: page[page.length - 1].session.id, parents: next });
    else {
      scans.delete(key);
      if (scope?.kind !== "session") {
        for (const row of parents.values()) if (parentMatches(row, scope)) parents.delete(row.id);
        for (const [id, row] of next) parents.set(id, row);
      }
    }
    return { rows, complete };
  }
  function reset() { scans.clear(); parents.clear(); }
  async function check(id: string, signal?: AbortSignal): Promise<VoiceRecoveryEntry | null> {
    const scope = { kind: "session", id } as const;
    const [row] = await candidates(scope, signal);
    if (!row) return null;
    const enabled = (await instanceSettingsService(db).getExperimental()).enableChatConnectors;
    if (voiceSessionRecoveryAt(row, enabled) <= Date.now()) {
      signal?.throwIfAborted();
      const session = row.session;
      try {
        let authorized = false;
        if (enabled && ["connecting", "active"].includes(session.state) && session.expiresAt.getTime() > Date.now()) {
          try { await operations.authorize(session); authorized = true; }
          catch (error) { if (!(error instanceof HttpError && [403, 404].includes(error.status))) throw error; }
        }
        if (authorized) {
          const state = await operations.inspect(session);
          await withVoiceSessionChange(db, id, tx => tx.update(chatVoiceSessions).set({
            ...(state?.endedAt ? { state: "ended" as const, endedAt: new Date(), errorCode: null } : {}), updatedAt: new Date(),
          }).where(and(eq(chatVoiceSessions.id, id), inArray(chatVoiceSessions.state, ["connecting", "active"]))), { replyDelivery: Boolean(state?.endedAt) });
        } else if (session.providerSessionId) await operations.close(session);
        else if (session.expiresAt.getTime() + 120_000 < Date.now()) {
          await withVoiceSessionChange(db, id, tx => tx.update(chatVoiceSessions).set({ state: "expired", endedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(chatVoiceSessions.id, id), isNull(chatVoiceSessions.providerSessionId), inArray(chatVoiceSessions.state, [...LIVE_VOICE_STATES]))));
        }
      } catch (error) {
        await withVoiceSessionChange(db, id, tx => tx.update(chatVoiceSessions).set({ errorCode: "cleanup_pending", updatedAt: new Date() })
          .where(and(eq(chatVoiceSessions.id, id), inArray(chatVoiceSessions.state, [...LIVE_VOICE_STATES]))), { replyDelivery: false });
        throw error;
      }
    }
    return (await load(scope, signal))[0] ?? null;
  }
  return { load, refresh, reset, check };
}
