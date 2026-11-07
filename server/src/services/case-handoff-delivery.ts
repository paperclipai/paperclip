import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { agentWakeupRequests, caseHandoffs, cases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { caseHandoffService, recordCaseHandoffEvent, type CaseHandoffRow } from "./case-handoffs.js";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import { isCaseHandoffSourceReleased } from "./heartbeat/case-handoff-lifecycle.js";
import type { heartbeatService } from "./heartbeat.js";

const PENDING = ["awaiting_release", "pending_dispatch"] as const;
const ACCEPTED = ["queued", "claimed", "running", "succeeded", "completed", "retrying", "scheduled_retry"];
type Heartbeat = Pick<ReturnType<typeof heartbeatService>, "wakeup"> & {
  requestCaseHandoffYield?: (input: { runId: string; issueId: string; handoffId: string }) => Promise<unknown>;
};

/** The ledger is the outbox. Notifications reduce latency; leases/retries survive restarts. */
export function caseHandoffDeliveryService(db: Db, options: { heartbeat: Heartbeat; now?: () => Date; leaseMs?: number }) {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 60_000;
  const handoffs = caseHandoffService(db);

  async function requestSourceYield(row: CaseHandoffRow): Promise<string | null> {
    if (!row.sourceRunId) return null;
    try {
      await options.heartbeat.requestCaseHandoffYield?.({ runId: row.sourceRunId, issueId: row.issueId, handoffId: row.id });
      return null;
    } catch (error) {
      // An unconfirmed Stop (including adapter_stop_pending) is not an
      // operator supersession. Keep the accepted intent fenced until the
      // executor's durable release proof or an explicit cancellation wins.
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function settle(row: CaseHandoffRow, state: "delivered" | "cancelled", message?: string) {
    const publications: ActivityPublication[] = [];
    await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [updated] = await tx.update(caseHandoffs).set({ state, leaseExpiresAt: null, updatedAt: now(),
        ...(state === "delivered" ? { deliveredAt: now(), lastErrorCode: null, lastError: null }
          : { cancelledAt: now(), lastErrorCode: "superseded", lastError: message ?? "Superseded by newer task state" }) })
        .where(and(eq(caseHandoffs.id, row.id), inArray(caseHandoffs.state, PENDING), eq(caseHandoffs.leaseExpiresAt, row.leaseExpiresAt!))).returning();
      if (updated) await recordCaseHandoffEvent(tx, updated, state === "delivered" ? "handoff_delivered" : "handoff_cancelled", publications);
    });
    publications.forEach(publishActivity);
  }

  async function retry(row: CaseHandoffRow, code: string, message: string) {
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(4, Math.max(0, row.attemptCount - 1)));
    const at = now(), later = new Date(at.getTime() + delay);
    // Cleanup may have committed after our readiness read but before this retry.
    // Preserve its immediate deadline rather than overwriting it with backoff.
    const nextAttemptAt = row.state === "awaiting_release" && row.sourceRunId ? sql<Date>`case when exists (
      select 1 from ${heartbeatRuns} released where released.id = ${row.sourceRunId}::uuid
        and released.company_id = ${row.companyId}::uuid
        and released.result_json->'caseHandoffExecutionReleased'->>'schema' = 'paperclip.case-handoff-release.v1'
        and released.result_json->'caseHandoffExecutionReleased'->>'runId' = ${row.sourceRunId}
        and released.result_json->'caseHandoffExecutionReleased'->>'issueId' = ${row.issueId}
    ) then ${at.toISOString()}::timestamptz else ${later.toISOString()}::timestamptz end` : later;
    await db.update(caseHandoffs).set({ leaseExpiresAt: null, nextAttemptAt,
      lastErrorCode: code, lastError: message.slice(0, 2_000), updatedAt: now() }).where(and(
        eq(caseHandoffs.id, row.id), inArray(caseHandoffs.state, PENDING), eq(caseHandoffs.leaseExpiresAt, row.leaseExpiresAt!),
      ));
  }

  async function accepted(row: CaseHandoffRow) {
    if (row.destinationKind !== "agent" || !row.toAgentId) return false;
    const [receipt] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, row.wakeupRequestId), eq(agentWakeupRequests.companyId, row.companyId),
      eq(agentWakeupRequests.agentId, row.toAgentId),
      or(inArray(agentWakeupRequests.status, ACCEPTED), sql`exists (
        select 1 from ${heartbeatRuns} admitted where admitted.id = ${agentWakeupRequests.runId}
          and admitted.company_id = ${row.companyId}::uuid and admitted.agent_id = ${row.toAgentId}::uuid
          and admitted.wakeup_request_id = ${row.wakeupRequestId}::uuid
          and (admitted.native_issue_id = ${row.issueId}::uuid or admitted.issue_id = ${row.issueId}::uuid
            or admitted.context_snapshot->>'issueId' = ${row.issueId})
      )`),
    ));
    return !!receipt;
  }

  async function deliver(row: CaseHandoffRow) {
    if (row.destinationKind !== "agent" || !row.toAgentId) return;
    // First recover the commit/ack gap. A recipient may already have advanced
    // task status since this receipt was accepted.
    if (await accepted(row)) { await settle(row, "delivered"); return; }
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, row.issueId), eq(issues.companyId, row.companyId)));
    const [caseRow] = await db.select().from(cases).where(and(eq(cases.id, row.caseId), eq(cases.companyId, row.companyId)));
    if (!issue || !caseRow || caseRow.workIssueId !== row.issueId || caseRow.handoffVersion !== row.version ||
        !["todo", "in_progress"].includes(issue.status)) { await settle(row, "cancelled"); return; }
    if (row.state === "pending_dispatch" && (issue.assigneeAgentId !== row.toAgentId || issue.assigneeUserId || issue.statusVersion !== row.appliedIssueStatusVersion)) {
      await settle(row, "cancelled"); return;
    }
    if (row.state === "awaiting_release") {
      if (!row.sourceRunId || issue.assigneeAgentId !== row.fromAgentId || issue.statusVersion !== row.expectedIssueStatusVersion) {
        await settle(row, "cancelled"); return;
      }
      if (!(await isCaseHandoffSourceReleased(db, { runId: row.sourceRunId, issueId: row.issueId }))) {
        const yieldError = await requestSourceYield(row);
        await retry(row, "awaiting_source_release", yieldError ?? "Waiting for the outgoing execution and workspace to settle"); return;
      }
      const applied = await handoffs.applyPending(row.id);
      if (!applied || applied.state !== "pending_dispatch") return;
      row = applied;
    }
    if (row.appliedIssueStatusVersion == null) throw new Error("Handoff assignment has no status version");
    if (!row.toAgentId) throw new Error("Agent handoff has no recipient");
    await handoffs.authorizePendingDispatch(row.id);
    await options.heartbeat.wakeup(row.toAgentId, {
      source: "assignment", triggerDetail: "system", reason: "case_handoff",
      idempotencyKey: `case-handoff:${row.id}`,
      requestedByActorType: row.actorType, requestedByActorId: row.actorId,
      payload: { issueId: row.issueId, mutation: "case_handoff", caseId: row.caseId, handoffId: row.id, commentId: row.commentId },
      contextSnapshot: { issueId: row.issueId, taskKey: row.issueId, caseId: row.caseId, caseHandoffId: row.id,
        wakeCommentId: row.commentId, responsibleUserId: row.responsibleUserId, source: "case_handoff" },
      issueStateGuard: { statuses: ["todo"], assigneeAgentId: row.toAgentId, statusVersion: row.appliedIssueStatusVersion },
      durableCaseHandoffRequest: { handoffId: row.id, wakeupRequestId: row.wakeupRequestId, issueId: row.issueId,
        expectedIssueStatusVersion: row.appliedIssueStatusVersion },
    });
    if (await accepted(row)) await settle(row, "delivered");
    else await retry(row, "wake_not_admitted", "Assignment is saved; execution is waiting for normal admission");
  }

  return {
    async sweepPending(signal?: AbortSignal) {
      const enabled = (await instanceSettingsService(db).getExperimental()).enableCases;
      const at = now();
      // Select bounded candidates, then atomically claim each. Two coordinator
      // instances may inspect the same IDs; only one owns an unexpired lease.
      const candidates = await db.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(
        eq(caseHandoffs.destinationKind, "agent"),
        enabled ? inArray(caseHandoffs.state, PENDING) : eq(caseHandoffs.state, "awaiting_release"), lte(caseHandoffs.nextAttemptAt, at),
        or(isNull(caseHandoffs.leaseExpiresAt), lte(caseHandoffs.leaseExpiresAt, at)),
      )).orderBy(asc(caseHandoffs.nextAttemptAt), asc(caseHandoffs.id)).limit(25);
      let examined = 0;
      for (const candidate of candidates) {
        if (signal?.aborted) break;
        const [claimed] = await db.update(caseHandoffs).set({ leaseExpiresAt: new Date(now().getTime() + leaseMs),
          attemptCount: sql`${caseHandoffs.attemptCount} + 1`,
          updatedAt: now() }).where(and(eq(caseHandoffs.id, candidate.id), eq(caseHandoffs.destinationKind, "agent"), inArray(caseHandoffs.state, PENDING),
          lte(caseHandoffs.nextAttemptAt, at), or(isNull(caseHandoffs.leaseExpiresAt), lte(caseHandoffs.leaseExpiresAt, at)))).returning();
        if (!claimed) continue;
        examined++;
        try {
          if (!enabled) {
            // A flag change pauses successor work, but cannot leave an accepted
            // outgoing process running indefinitely. Its usual yield/stop and
            // workspace cleanup retain their existing authority.
            const yieldError = await requestSourceYield(claimed);
            await retry(claimed, "cases_disabled", yieldError ?? "Case handoffs are paused in Experimental settings");
          } else await deliver(claimed);
        }
        catch (error) {
          const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;
          const details = typeof error === "object" && error && "details" in error && error.details && typeof error.details === "object"
            ? error.details as { code?: unknown; reason?: unknown } : null;
          if (details?.code === "case_handoff_admission_wait") await retry(claimed,
            typeof details.reason === "string" ? details.reason : "wake_not_admitted", error instanceof Error ? error.message : "Waiting for normal admission");
          else if (status === 409 || status === 404) await settle(claimed, "cancelled", error instanceof Error ? error.message : "Superseded");
          else await retry(claimed, status === 403 ? "access_or_admission_blocked" : "delivery_failed", error instanceof Error ? error.message : String(error));
        }
      }
      return { examined };
    },
    async hasPending() {
      // Retain a small recovery sweep while disabled so enabling the flag picks
      // up already-persisted intent without requiring a process restart.
      return (await db.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(eq(caseHandoffs.destinationKind, "agent"),
        inArray(caseHandoffs.state, PENDING))).limit(1)).length > 0;
    },
  };
}
