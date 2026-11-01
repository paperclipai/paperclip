import { and, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { activityLog, chatEndpoints, chatVoiceReports, chatVoiceSessions, issues, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { documentService } from "../documents.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { voiceRecoveryScope, type VoiceRecoveryScope } from "./voice-recovery-notifications.js";
import { notifyVoiceReports } from "./voice-report-notifications.js";
import type { VoiceSessionRow } from "./voice-session-store.js";
import type { SpekoCallReport } from "./speko-call-report.js";
import { SpekoProviderError } from "./speko-provider.js";

type Entry = { id: string; companyId: string; endpointId: string; connectionId: string; dueAt: number };
type Report = SpekoCallReport;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const eligible = (now: number) => and(inArray(chatVoiceSessions.state, ["ended", "failed", "expired"]),
  isNotNull(chatVoiceSessions.providerSessionId), gte(chatVoiceSessions.endedAt, new Date(now - WINDOW_MS)));

/** Reports may change for 24 hours after a call. Available is a presentation
 * state, not a promise of immutable provider data. Keep that finite obligation. */
export function voiceCallReports(db: Db, fetchReport: (session: VoiceSessionRow) => Promise<Report>) {
  type Cursor = { id: string; endedAt: string };
  const cursors = new Map<string, Cursor>();
  async function page(scope?: VoiceRecoveryScope, cursor?: Cursor, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const rows = await db.select({ id: chatVoiceSessions.id, companyId: chatVoiceSessions.companyId,
      endpointId: chatVoiceSessions.endpointId, connectionId: chatEndpoints.connectionId,
      endedAt: sql<string>`${chatVoiceSessions.endedAt}::text`,
      dueAt: sql<string>`least(coalesce(ceil(extract(epoch from ${chatVoiceReports.nextCheckAt}) * 1000), 0), floor(extract(epoch from ${chatVoiceSessions.endedAt}) * 1000) + ${WINDOW_MS} + 1)`,
    }).from(chatVoiceSessions)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatVoiceSessions.endpointId), eq(chatEndpoints.companyId, chatVoiceSessions.companyId)))
      .leftJoin(chatVoiceReports, and(eq(chatVoiceReports.sessionId, chatVoiceSessions.id), eq(chatVoiceReports.companyId, chatVoiceSessions.companyId)))
      .where(and(eligible(Date.now()),
        scope?.kind === "session" ? eq(chatVoiceSessions.id, scope.id) : undefined,
        scope?.kind === "endpoint" ? eq(chatVoiceSessions.endpointId, scope.id) : undefined,
        scope?.kind === "connection" ? eq(chatEndpoints.connectionId, scope.id) : undefined,
        scope?.kind === "company" ? eq(chatVoiceSessions.companyId, scope.id) : undefined,
        cursor ? sql`(${chatVoiceSessions.endedAt}, ${chatVoiceSessions.id}) > (${cursor.endedAt}::timestamptz, ${cursor.id}::uuid)` : undefined))
      .orderBy(chatVoiceSessions.endedAt, chatVoiceSessions.id).limit(100);
    signal?.throwIfAborted();
    return rows;
  }
  function entries(rows: Awaited<ReturnType<typeof page>>): Entry[] {
    return rows.map(({ endedAt: _cursor, ...row }) => ({ ...row, dueAt: Number(row.dueAt) }));
  }
  async function load(scope?: VoiceRecoveryScope, signal?: AbortSignal): Promise<Entry[]> {
    const result: Entry[] = []; let cursor: Cursor | undefined;
    for (;;) {
      const rows = await page(scope, cursor, signal);
      result.push(...entries(rows));
      if (rows.length < 100) return result;
      cursor = rows[rows.length - 1];
    }
  }
  async function refresh(scope?: VoiceRecoveryScope, signal?: AbortSignal) {
    const key = scope ? `${scope.kind}:${scope.id}` : "*";
    const rows = await page(scope, cursors.get(key), signal), result = entries(rows), complete = rows.length < 100;
    signal?.throwIfAborted();
    if (complete) cursors.delete(key); else cursors.set(key, rows[rows.length - 1]);
    return { rows: result, complete };
  }
  async function projectTranscript(session: VoiceSessionRow) {
    // Keep both actual spoken sides on this public call's own task. This
    // does not publish a document or grant access to any other task.
    if (session.callerAuthority !== "guest_intake") return;
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`voice-transcript:${session.id}`}, 0))`);
      const [retained] = await tx.select().from(chatVoiceReports).where(and(eq(chatVoiceReports.companyId, session.companyId), eq(chatVoiceReports.sessionId, session.id)));
      if (!retained?.transcript.length) return;
      const [task] = await tx.select({sourceTrust: issues.sourceTrust}).from(issues).where(and(eq(issues.companyId, session.companyId), eq(issues.id, session.issueId)));
      if (task?.sourceTrust?.preset !== "low_trust_review" || task.sourceTrust.disposition !== "quarantined") return;
      const key = `voice-transcript-${session.id}`;
      const body = retained.transcript.map(turn => `**${turn.speaker === "caller" ? "Caller" : "Agent"}** · ${turn.startedAt}${turn.interrupted ? " · interrupted" : ""}\n\n${turn.text}`).join("\n\n---\n\n");
      const docs = documentService(tx as unknown as Db), previous = await docs.getIssueDocumentByKey(session.issueId, key);
      if (previous?.body === body) return;
      await docs.upsertIssueDocument({issueId: session.issueId, key, baseRevisionId: previous?.latestRevisionId, title: "Phone conversation transcript", format: "markdown", body, sourceTrust: task.sourceTrust, changeSummary: "Speko spoken conversation, including caller and agent turns"});
      await tx.insert(activityLog).values({companyId: session.companyId, actorType: "system", actorId: "speko-report", action: "voice.transcript.updated", entityType: "issue", entityId: session.issueId, details: {sessionId: session.id}});
    });
  }
  async function check(id: string, signal?: AbortSignal): Promise<Entry | null> {
    signal?.throwIfAborted();
    const claim = await db.transaction(async tx => {
      const [session] = await tx.select().from(chatVoiceSessions).where(and(eq(chatVoiceSessions.id, id), eligible(Date.now()))).for("update");
      if (!session) return null;
      await notifyVoiceReports(tx, { kind: "session", id });
      await tx.insert(chatVoiceReports).values({ sessionId: id, companyId: session.companyId, nextCheckAt: new Date() }).onConflictDoNothing();
      const [report] = await tx.select().from(chatVoiceReports).where(and(eq(chatVoiceReports.sessionId, id),
        eq(chatVoiceReports.companyId, session.companyId), lte(chatVoiceReports.nextCheckAt, new Date()))).for("update");
      if (!report) return null;
      signal?.throwIfAborted();
      const attempts = report.attempts + 1;
      const retryAt = new Date(Date.now() + Math.min(3600, 30 * 2 ** Math.min(attempts, 7)) * 1000);
      await tx.update(chatVoiceReports).set({ attempts, nextCheckAt: retryAt }).where(eq(chatVoiceReports.sessionId, id));
      return { session, attempts, retryAt };
    });
    if (claim) {
      const { session, attempts, retryAt } = claim;
      // A callback can advance nextCheckAt while this GET is in flight.
      // That callback or a newer attempt owns settlement; never overwrite it.
      const owned = () => and(eq(chatVoiceReports.sessionId, id), eq(chatVoiceReports.companyId, session.companyId),
        eq(chatVoiceReports.attempts, attempts), eq(chatVoiceReports.nextCheckAt, retryAt));
      signal?.throwIfAborted();
      try {
        const result = await fetchReport(session);
        logger.info({ event: "voice.call.report_received", companyId: session.companyId, endpointId: session.endpointId,
          issueId: session.issueId, sessionId: id, providerSessionId: session.providerSessionId, attempts,
          complete: result.complete, transcriptTurns: result.transcript.length, providerUpdatedAt: result.providerUpdatedAt?.toISOString() ?? null }, "Voice call report received for reconciliation");
        await db.transaction(async tx => {
          await notifyVoiceReports(tx, { kind: "session", id });
          await tx.update(chatVoiceReports).set({ transcript: result.transcript, costMicroUsd: result.costMicroUsd,
            durationSeconds: result.durationSeconds, providerUpdatedAt: result.providerUpdatedAt,
            status: result.complete ? "available" : "pending", updatedAt: new Date(),
          }).where(and(owned(), result.complete ? undefined : ne(chatVoiceReports.status, "available"),
            result.providerUpdatedAt ? or(sql`${chatVoiceReports.providerUpdatedAt} is null`, lte(chatVoiceReports.providerUpdatedAt, result.providerUpdatedAt)) : sql`${chatVoiceReports.providerUpdatedAt} is null`));
        });
        // Project the retained authoritative report, including when a response
        // was stale. A projection failure retains the already saved retry.
        await projectTranscript(session);
      } catch (error) {
        logger.warn({ event: "voice.call.report_failed", companyId: session.companyId, endpointId: session.endpointId,
          issueId: session.issueId, sessionId: id, providerSessionId: session.providerSessionId, attempts,
          errorCode: error instanceof SpekoProviderError ? error.code : "report_reconciliation_failed",
          httpStatus: error instanceof SpekoProviderError ? error.httpStatus ?? null : null, retryAt: retryAt.toISOString() }, "Voice call report reconciliation deferred");
        if (attempts >= 8) await db.transaction(async tx => {
          await notifyVoiceReports(tx, { kind: "session", id });
          await tx.update(chatVoiceReports).set({ status: "unavailable" }).where(and(owned(), ne(chatVoiceReports.status, "available")));
        });
      }
    }
    return (await load({ kind: "session", id }, signal))[0] ?? null;
  }
  async function reconcile(limit: number) {
    const rows = (await load()).filter(row => row.dueAt <= Date.now()).sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)).slice(0, limit);
    for (const row of rows) await check(row.id);
    return rows.length;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    cursors.clear();
    return registerScopedDeadlineWork(coordinator, { queue: DELIVERY_QUEUES.voiceReports, decodeScope: voiceRecoveryScope,
      matches: (entry, scope) => !scope || (scope.kind === "session" ? entry.id : scope.kind === "endpoint" ? entry.endpointId : scope.kind === "connection" ? entry.connectionId : entry.companyId) === scope.id,
      load: refresh, check: (entry, signal) => check(entry.id, signal),
    }, canRun);
  }
  return { load, check, reconcile, register };
}
