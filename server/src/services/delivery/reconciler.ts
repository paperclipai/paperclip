import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  deliveryFindings,
  deliveryRepositories,
  deliveryReceipts,
  deliveryRepairAttempts,
  deliveryUnitIssues,
  deliveryUnits,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import type {
  DeliveryBlocker,
  DeliveryCheck,
  DeliveryProvenance,
  DeliverySummary,
} from "@paperclipai/shared";
import { createHash } from "node:crypto";
import type { DeliveryEventService } from "./events.js";
import type { DeliveryPolicyService, DeliveryRepositoryRow } from "./policy.js";
import type { DeliveryQueueService } from "./queue.js";
import type { DeliveryUnitService, DeliveryUnitRow } from "./units.js";
import { deriveDeliveryPhase, readUnitMetadata } from "./units.js";
import type { GitHubDeliveryClient } from "./github-client.js";
import type { GreptileFinding, GreptileReviewService, GreptileReviewState } from "./greptile.js";
import { GREPTILE_BLOCKING_SEVERITIES } from "./greptile.js";
import { recordObservedFindings } from "./findings.js";
import type { DeliveryControllerContext } from "./done-gate.js";
import { isCheckSuccessful, repositoryFullName, type DeliveryEvidence } from "./policy.js";

export const DELIVERY_MAX_REPAIR_ATTEMPTS = 3;

export type DeliveryReconcileTrigger =
  | "submit"
  | "manual"
  | "sweep"
  | "webhook"
  | "operator"
  | "retry";

/** One actionable repair request. `signal` is its evidence identity. */
export type DeliveryRepairRequest = {
  companyId: string;
  unit: DeliveryUnitRow;
  reasonCode: string;
  message: string;
  signal: string;
  detail?: string;
  /**
   * Candidate generation the actionable evidence was read at. A request for an
   * older generation is dropped: it cannot dispatch work for a candidate that
   * has been replaced.
   */
  candidateGeneration?: number | null;
};

export type DeliveryRepairOutcome = {
  requested: boolean;
  attempt: number;
  exhausted: boolean;
};

export type DeliveryReconcileOutcome = {
  unitId: string;
  status: DeliveryUnitRow["status"];
  phase: DeliverySummary["phase"];
  blocker: DeliveryBlocker | null;
  merged: boolean;
  changed: boolean;
  /**
   * The evidence read belonged to a candidate generation that has since been
   * replaced. Every write derived from that read was discarded.
   */
  stale?: boolean;
};

export interface DeliveryReconciler {
  reconcileUnit(input: {
    companyId: string;
    unitId: string;
    trigger: DeliveryReconcileTrigger;
  }): Promise<DeliveryReconcileOutcome>;
  reconcileIssue(input: { companyId: string; issueId: string; trigger?: DeliveryReconcileTrigger }): Promise<DeliveryReconcileOutcome | null>;
  reconcilePullRequest(input: {
    companyId: string;
    owner: string;
    repo: string;
    number: number;
  }): Promise<number>;
  reconcileCompany(input: { companyId: string; limit?: number }): Promise<{ reconciled: number; merged: number }>;
  verifyMergedUnit(input: { companyId: string; unitId: string }): Promise<DeliveryReconcileOutcome>;
  /** Wakes the owner for a changed actionable evidence signal, bounded per signal. */
  requestRepair(input: DeliveryRepairRequest): Promise<DeliveryRepairOutcome>;
}

export type DeliveryIssueStatusWriter = (input: {
  companyId: string;
  issueId: string;
  status: "in_review" | "ready_to_merge" | "merging" | "done";
  controller: DeliveryControllerContext;
}) => Promise<void>;

function hashEvidence(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function blocker(reasonCode: string, message: string, nextAction: string | null = null): DeliveryBlocker {
  return { reasonCode, message, owner: null, nextAction };
}

/**
 * Acceptance transition.
 *
 * Submission records the head; acceptance is granted only by the reconciler
 * after fresh authoritative evidence passes for that exact head. A failed
 * requirement withdraws acceptance; once the same head passes again it is
 * re-accepted automatically, so a repair does not need an arbitrary resubmit.
 */
export function nextAcceptanceState(input: {
  acceptedHeadSha: string | null;
  remoteHeadSha: string | null;
  requirementsMet: boolean;
}): { acceptedHeadSha: string | null; action: "none" | "accept" | "revoke" } {
  if (!input.remoteHeadSha) {
    return { acceptedHeadSha: null, action: input.acceptedHeadSha ? "revoke" : "none" };
  }
  if (!input.requirementsMet) {
    return { acceptedHeadSha: null, action: input.acceptedHeadSha ? "revoke" : "none" };
  }
  if (input.acceptedHeadSha === input.remoteHeadSha) {
    return { acceptedHeadSha: input.acceptedHeadSha, action: "none" };
  }
  return { acceptedHeadSha: input.remoteHeadSha, action: "accept" };
}

export function deliveryReconciler(
  db: Db,
  deps: {
    policy: DeliveryPolicyService;
    queue: DeliveryQueueService;
    events: DeliveryEventService;
    units: DeliveryUnitService;
    github: GitHubDeliveryClient;
    greptile: GreptileReviewService;
    setIssueStatus: DeliveryIssueStatusWriter;
  },
): DeliveryReconciler {
  const { policy, queue, events, units, github, greptile, setIssueStatus } = deps;

  /**
   * Fence a delivery-unit write to the candidate generation its evidence was
   * read at.
   *
   * Delivery reconciliation is asynchronous: a GitHub read can outlive the
   * candidate it was started for. Ids and head SHAs are not sufficient fences
   * (a revision that moves A -> B -> A would let generation-A evidence pass as
   * current), so every evidence-derived write compares the durable
   * `candidateGeneration` and is discarded when it no longer matches. A
   * discarded write is never retried against the new candidate — the next
   * reconcile reads fresh evidence for it.
   */
  async function writeUnitFenced(input: {
    companyId: string;
    unitId: string;
    generation: number;
    set: Partial<typeof deliveryUnits.$inferInsert>;
  }): Promise<DeliveryUnitRow | null> {
    const [row] = await db
      .update(deliveryUnits)
      .set(input.set)
      .where(and(
        eq(deliveryUnits.companyId, input.companyId),
        eq(deliveryUnits.id, input.unitId),
        eq(deliveryUnits.candidateGeneration, input.generation),
        // Terminal is permanent, and it is checked *inside* the write rather
        // than only in the caller's earlier read: a merge that commits while
        // this evidence is in flight must never be reopened or restated by it.
        notInArray(deliveryUnits.status, ["merged", "cancelled", "closed_unmerged"]),
      ))
      .returning();
    return row ?? null;
  }

  /**
   * Outcome for a reconciliation whose writes were fenced out: the evidence
   * belonged to a candidate that has since been replaced, so nothing was
   * changed and the caller must not treat the read as a result for the unit's
   * current generation.
   */
  function staleOutcome(unit: DeliveryUnitRow): DeliveryReconcileOutcome {
    return {
      unitId: unit.id,
      status: unit.status,
      phase: deriveDeliveryPhase(unit),
      blocker: unit.blocker ?? null,
      merged: false,
      changed: false,
      stale: true,
    };
  }

  /**
   * Record that the current candidate's authoritative evidence could not be
   * read. Fenced like every other evidence write: a failed read of an older
   * generation must not mark the current candidate unknown.
   */
  async function recordEvidenceReadFailure(input: {
    companyId: string;
    unit: DeliveryUnitRow;
    generation: number;
  }): Promise<void> {
    const metadata = readUnitMetadata(input.unit.metadata);
    await writeUnitFenced({
      companyId: input.companyId,
      unitId: input.unit.id,
      generation: input.generation,
      set: {
        metadata: { ...metadata, evidenceGeneration: input.generation, lastReadFailed: true },
        updatedAt: new Date(),
      },
    });
  }

  async function coveredIssueIds(companyId: string, unitId: string) {
    return await db
      .select({ issueId: deliveryUnitIssues.issueId })
      .from(deliveryUnitIssues)
      .where(and(eq(deliveryUnitIssues.companyId, companyId), eq(deliveryUnitIssues.unitId, unitId)))
      .then((rows) => rows.map((row) => row.issueId));
  }

  async function syncIssueStatus(
    companyId: string,
    unit: DeliveryUnitRow,
    status: "in_review" | "ready_to_merge" | "merging" | "done",
  ) {
    const issueIds = await coveredIssueIds(companyId, unit.id);
    for (const issueId of issueIds) {
      const [issue] = await db
        .select({ status: issues.status, deliveryKind: issues.deliveryKind })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
        .limit(1);
      if (!issue) continue;
      if (issue.status === "cancelled" || issue.status === "done") continue;
      if (issue.status === status) continue;
      // Never downgrade an explicit board decision to a delivery status; only
      // move between the delivery-owned review/merge statuses.
      if (
        status === "ready_to_merge"
        || status === "merging"
        || issue.status === "ready_to_merge"
        || issue.status === "merging"
        || status === "done"
      ) {
        try {
          await setIssueStatus({
            companyId,
            issueId,
            status,
            controller: {
              controller: "delivery-controller",
              unitId: unit.id,
              reason: `reconcile:${status}`,
            },
          });
        } catch (error) {
          // The Done gate can legitimately refuse a parent while child delivery
          // obligations are open. The remote merge is already verified, so record
          // the refusal instead of failing the whole reconciliation.
          const details = error && typeof error === "object" && "details" in error
            ? (error as { details?: Record<string, unknown> }).details
            : undefined;
          await events.append({
            companyId,
            unitId: unit.id,
            issueId,
            type: "blocked",
            message: error instanceof Error ? error.message : "Delivery status update was refused",
            dedupeKey: `status_refused:${issueId}:${status}:${String(details?.reasonCode ?? "unknown")}`,
            payload: { reasonCode: details?.reasonCode ?? "delivery_status_refused", targetStatus: status },
          });
        }
      }
    }
  }

  async function holdQueue(companyId: string, unit: DeliveryUnitRow, reasonCode: string, message: string) {
    const entry = await queue.getEntry(companyId, unit.id);
    if (!entry) return;
    await queue.setStatus({
      companyId,
      unitId: unit.id,
      status: "blocked",
      lastErrorCode: reasonCode,
      lastError: message,
    });
  }

  /**
   * Withdraw acceptance. A unit only ever merges the head it was accepted at,
   * so a new head, a failed requirement, or an unreadable authoritative source
   * clears `acceptedHeadSha` and any queue position it held.
   */
  async function revokeAcceptance(input: {
    companyId: string;
    unit: DeliveryUnitRow;
    blocker: DeliveryBlocker;
    dedupeKey: string;
    eventType: string;
    message?: string;
    /** Generation the failing evidence was read at; see `writeUnitFenced`. */
    generation: number;
  }): Promise<boolean> {
    const now = new Date();
    const revoked = await writeUnitFenced({
      companyId: input.companyId,
      unitId: input.unit.id,
      generation: input.generation,
      set: {
        acceptedHeadSha: null,
        readyAt: null,
        queueEnteredAt: null,
        updatedAt: now,
      },
    });
    // A newer candidate owns this unit now: the failure describes evidence for
    // a candidate that no longer exists, so nothing is revoked or blocked.
    if (!revoked) return false;
    await units.markBlocked({
      companyId: input.companyId,
      unitId: input.unit.id,
      blocker: input.blocker,
      nextAction: input.blocker.nextAction,
      candidateGeneration: input.generation,
    });
    await holdQueue(input.companyId, input.unit, input.blocker.reasonCode, input.blocker.message);
    if (input.unit.status === "ready_to_merge" || input.unit.status === "merging") {
      await units.setUnitStatus({
        companyId: input.companyId,
        unitId: input.unit.id,
        status: "in_review",
        candidateGeneration: input.generation,
      });
      await syncIssueStatus(input.companyId, input.unit, "in_review");
    }
    await events.append({
      companyId: input.companyId,
      unitId: input.unit.id,
      issueId: input.unit.primaryIssueId,
      type: input.eventType,
      message: input.message ?? input.blocker.message,
      dedupeKey: input.dedupeKey,
      url: input.unit.prUrl,
      payload: { reasonCode: input.blocker.reasonCode, candidateGeneration: input.generation },
    });
    return true;
  }

  /** Run statuses whose execution is still in flight or still promotable. */
  const LIVE_RUN_STATUSES: Record<string, true> = {
    queued: true,
    running: true,
    scheduled_retry: true,
    claimed: true,
    pending: true,
  };

  /**
   * Whether a recorded repair dispatch still has an executable outcome.
   *
   * Delivery dedupe must survive duplicate sweeps, but it must never confuse
   * "we asked the owner" with "the owner's execution still exists". A wake
   * intent that was never picked up, or a run that ended without completing
   * (cancelled, failed, process loss) and has no live retry, is a vanished
   * execution: the signal is unhandled again and a bounded re-dispatch is the
   * only thing that keeps the repair loop alive. A completed run is a real
   * outcome and keeps the signal handled.
   */
  async function repairDispatchOutcome(input: {
    companyId: string;
    wakeRequestId: string | null;
  }): Promise<"live" | "completed" | "vanished"> {
    if (!input.wakeRequestId) return "vanished";
    const [wake] = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.id, input.wakeRequestId),
      ))
      .limit(1);
    if (!wake) return "vanished";
    if (wake.runId == null) {
      // The intent itself is the pending execution: a queued or claimed wake
      // is still promotable, so it stays live. A cancelled, failed, skipped, or
      // coalesced wake with no run has no execution left.
      return wake.status === "queued" || wake.status === "claimed" ? "live" : "vanished";
    }
    const [run] = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake.runId))
      .limit(1);
    if (!run) return "vanished";
    if (LIVE_RUN_STATUSES[run.status] === true) return "live";
    if (run.status === "completed") return "completed";
    // Terminal without completing: only a live retry of that exact run keeps
    // the signal handled. Otherwise the execution vanished.
    const [retry] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.retryOfRunId, run.id),
        inArray(heartbeatRuns.status, Object.keys(LIVE_RUN_STATUSES)),
      ))
      .limit(1);
    return retry ? "live" : "vanished";
  }

  /**
   * Bounded repair loop: wake the implementation owner, but stop after
   * `DELIVERY_MAX_REPAIR_ATTEMPTS` and escalate instead of looping forever.
   */
  async function wakeOwnerForRepair(input: {
    companyId: string;
    unit: DeliveryUnitRow;
    reasonCode: string;
    message: string;
    detail?: string;
    signal: string;
    generation: number;
  }) {
    const [attemptsRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryRepairAttempts)
      .where(and(
        eq(deliveryRepairAttempts.companyId, input.companyId),
        eq(deliveryRepairAttempts.unitId, input.unit.id),
        eq(deliveryRepairAttempts.reasonCode, input.reasonCode),
        inArray(deliveryRepairAttempts.status, ["requested", "dispatched"]),
      ));
    const attempt = (attemptsRow?.count ?? 0) + 1;
    if (attempt > DELIVERY_MAX_REPAIR_ATTEMPTS) {
      await db.insert(deliveryRepairAttempts).values({
        companyId: input.companyId,
        unitId: input.unit.id,
        reasonCode: input.reasonCode,
        attempt,
        status: "exhausted",
        signal: input.signal,
        candidateGeneration: input.generation,
        headSha: input.unit.headSha,
        ownerAgentId: input.unit.ownerAgentId,
        requestedByActorType: "system",
        requestedByActorId: "delivery-controller",
        detail: input.detail ?? input.message,
      }).onConflictDoNothing();
      const exhaustedBlocker = blocker(
        "repair_attempts_exhausted",
        `Repair attempts exhausted for ${input.reasonCode}`,
        "Inspect the repair results and explicitly retry after resolving the failure.",
      );
      exhaustedBlocker.owner = input.unit.ownerAgentId;
      const applied = await units.markBlocked({
        companyId: input.companyId,
        unitId: input.unit.id,
        blocker: exhaustedBlocker,
        candidateGeneration: input.generation,
      });
      if (applied) {
        await holdQueue(input.companyId, input.unit, exhaustedBlocker.reasonCode, exhaustedBlocker.message);
      }
      await events.append({
        companyId: input.companyId,
        unitId: input.unit.id,
        issueId: input.unit.primaryIssueId,
        type: "repair_exhausted",
        message: `Repair attempts exhausted for ${input.reasonCode}`,
        dedupeKey: `repair_exhausted:${input.reasonCode}`,
        payload: { reasonCode: input.reasonCode, attempts: DELIVERY_MAX_REPAIR_ATTEMPTS, candidateGeneration: input.generation },
      });
      return { attempted: false, attempt, exhausted: true };
    }
    const ownerAgentId = input.unit.ownerAgentId;
    const idempotencyKey = `delivery_repair:${input.unit.id}:${input.reasonCode}:${attempt}`;
    let wakeRequestId: string | null = null;
    let dispatched = false;
    if (ownerAgentId) {
      // Real idempotent heartbeat wake through the injected dispatcher. The
      // durable intent row is the idempotency record; `dispatched` reports
      // whether a run was actually queued, so a bare row is never mistaken
      // for owner feedback. The wake carries the controller's own repair
      // intent as a context snapshot: unit, candidate generation, head, reason
      // and attempt are minted here and never taken from worker-supplied text.
      const wake = await units.dispatchOwnerWake({
        companyId: input.companyId,
        agentId: ownerAgentId,
        reason: "delivery_repair_requested",
        payload: {
          issueId: input.unit.primaryIssueId,
          taskId: input.unit.primaryIssueId,
          unitId: input.unit.id,
          reasonCode: input.reasonCode,
          message: input.message,
          attempt,
          candidateGeneration: input.generation,
          headSha: input.unit.headSha,
        },
        contextSnapshot: {
          deliveryRepair: {
            unitId: input.unit.id,
            candidateGeneration: input.generation,
            headSha: input.unit.headSha,
            reasonCode: input.reasonCode,
            attempt,
          },
        },
        idempotencyKey,
      });
      wakeRequestId = wake.intentId;
      dispatched = wake.dispatched;
    }
    await db
      .insert(deliveryRepairAttempts)
      .values({
        companyId: input.companyId,
        unitId: input.unit.id,
        reasonCode: input.reasonCode,
        attempt,
        status: dispatched ? "dispatched" : "requested",
        signal: input.signal,
        candidateGeneration: input.generation,
        headSha: input.unit.headSha,
        ownerAgentId,
        wakeRequestId,
        requestedByActorType: "system",
        requestedByActorId: "delivery-controller",
        detail: input.detail ?? input.message,
      })
      .onConflictDoNothing();
    await events.append({
      companyId: input.companyId,
      unitId: input.unit.id,
      issueId: input.unit.primaryIssueId,
      type: "repair_requested",
      message: `Repair requested (attempt ${attempt}): ${input.message}`,
      dedupeKey: `repair_requested:${input.reasonCode}:${attempt}`,
      payload: { reasonCode: input.reasonCode, attempt, wakeRequestId, dispatched, candidateGeneration: input.generation },
    });
    if (!ownerAgentId || !dispatched) {
      await events.append({
        companyId: input.companyId,
        unitId: input.unit.id,
        issueId: input.unit.primaryIssueId,
        type: "escalated",
        message: !ownerAgentId
          ? `No implementation owner is assigned for ${input.reasonCode}`
          : `Owner wake for ${input.reasonCode} is pending dispatch; operator attention required`,
        dedupeKey: `escalated:${input.reasonCode}:${attempt}`,
        payload: { reasonCode: input.reasonCode, dispatched },
      });
    }
    return { attempted: dispatched, attempt, exhausted: false };
  }

  /**
   * Request a repair only for a signal the unit has not already been woken for.
   *
   * Reconciliation polls: the same head, the same finding and the same failing
   * check are re-observed on every sweep. A repeated request for unchanged
   * evidence is not a new repair and must not consume the bounded attempt
   * budget, so the last requested signal is recorded per reason code and a
   * repeated signal returns without dispatching. New actionable evidence — a
   * new head, a new or changed finding, a new failing check — carries a new
   * signal and does request a wake.
   *
   * Dedupe is bound to the durable execution, not to the recorded string: when
   * the run that was supposed to handle the signal vanished (cancelled, failed
   * by process loss, never picked up) and has no live retry, the signal is
   * unhandled again and a bounded re-dispatch follows. Retry creation stays
   * idempotent because every attempt carries its own deterministic
   * `(unit, reason, attempt)` key and the intent row is unique per key.
   */
  async function requestRepair(input: DeliveryRepairRequest): Promise<DeliveryRepairOutcome> {
    if (!REPAIRABLE_REASON_CODES[input.reasonCode]) {
      return { requested: false, attempt: 0, exhausted: false };
    }
    if (input.candidateGeneration != null && input.unit.candidateGeneration !== input.candidateGeneration) {
      // Evidence for a replaced candidate never dispatches work on the new one.
      return { requested: false, attempt: 0, exhausted: false };
    }
    const metadata = readUnitMetadata(input.unit.metadata);
    if (metadata.lastRepairSignal?.[input.reasonCode] === input.signal
      && (input.unit.blocker as DeliveryBlocker | null)?.reasonCode !== "repair_attempts_exhausted") {
      const [recorded] = await db
        .select({
          attempt: deliveryRepairAttempts.attempt,
          wakeRequestId: deliveryRepairAttempts.wakeRequestId,
        })
        .from(deliveryRepairAttempts)
        .where(and(
          eq(deliveryRepairAttempts.companyId, input.companyId),
          eq(deliveryRepairAttempts.unitId, input.unit.id),
          eq(deliveryRepairAttempts.reasonCode, input.reasonCode),
          eq(deliveryRepairAttempts.signal, input.signal),
          inArray(deliveryRepairAttempts.status, ["requested", "dispatched"]),
        ))
        .orderBy(desc(deliveryRepairAttempts.attempt))
        .limit(1);
      const outcome = recorded
        ? await repairDispatchOutcome({ companyId: input.companyId, wakeRequestId: recorded.wakeRequestId })
        : "vanished";
      if (outcome !== "vanished") {
        return { requested: false, attempt: recorded?.attempt ?? 0, exhausted: false };
      }
      await events.append({
        companyId: input.companyId,
        unitId: input.unit.id,
        issueId: input.unit.primaryIssueId,
        type: "repair_requested",
        message: `Repair execution for ${input.reasonCode} vanished; re-dispatching the same signal`,
        dedupeKey: `repair_vanished:${input.reasonCode}:${recorded?.attempt ?? 0}`,
        payload: {
          reasonCode: input.reasonCode,
          signal: input.signal,
          priorAttempt: recorded?.attempt ?? null,
          candidateGeneration: input.unit.candidateGeneration,
        },
      });
    }
    const result = await wakeOwnerForRepair({
      companyId: input.companyId,
      unit: input.unit,
      reasonCode: input.reasonCode,
      message: input.message,
      detail: input.detail,
      signal: input.signal,
      generation: input.unit.candidateGeneration,
    });
    // Failed dispatches remain retryable within the bound. Only a real queued
    // owner run handles the signal; exhaustion stays visible as a blocker.
    if (result.attempted) await writeUnitFenced({
      companyId: input.companyId,
      unitId: input.unit.id,
      generation: input.unit.candidateGeneration,
      set: {
        metadata: {
          ...metadata,
          lastRepairSignal: { ...(metadata.lastRepairSignal ?? {}), [input.reasonCode]: input.signal },
        },
        updatedAt: new Date(),
      },
    });
    return { requested: result.attempted, attempt: result.attempt, exhausted: result.exhausted };
  }

  /**
   * Evidence identity for a review/check repair: a change is a new request.
   *
   * `explicitNonce` makes an operator-driven retry a fresh request even when
   * the evidence is unchanged, because that is what an explicit retry means.
   * Polling never sets it, so repeated sweeps of unchanged evidence stay
   * deduplicated and never spend an attempt.
   */
  function evidenceSignal(input: {
    reasonCode: string;
    headSha: string | null;
    reviewStatus: string | null;
    reviewHeadSha: string | null;
    blockingFindings: number;
    checks: DeliveryCheck[] | null;
    findings?: Array<Pick<typeof deliveryFindings.$inferSelect,
      "source" | "externalId" | "severity" | "state" | "title" | "body" | "filePath" | "line">>;
    reviewChanges?: string[];
    explicitNonce?: number | null;
  }) {
    return `v1:${hashEvidence({
      reasonCode: input.reasonCode,
      headSha: input.headSha,
      reviewStatus: input.reasonCode === "review_blocking_findings" ? input.reviewStatus : null,
      reviewHeadSha: input.reasonCode === "review_blocking_findings" ? input.reviewHeadSha : null,
      blockingFindings: input.reasonCode === "review_blocking_findings" ? input.blockingFindings : null,
      findings: input.reasonCode === "review_blocking_findings" ? input.findings ?? [] : null,
      reviewChanges: input.reasonCode === "review_blocking_findings" ? input.reviewChanges ?? [] : null,
      checks: input.reasonCode === "checks_failing"
        ? input.checks?.map((check) => `${check.name}:${check.status}`).sort() ?? null
        : null,
      explicitNonce: input.explicitNonce ?? null,
    })}`;
  }

  /**
   * Reason codes a code repair can actually resolve. Evidence that can only
   * change by waiting (an in-flight provider review, a missing required check,
   * a human approval gate, an unreadable provider) withdraws readiness but
   * never spends a repair attempt on the implementation owner.
   */
  const REPAIRABLE_REASON_CODES: Record<string, true> = {
    review_blocking_findings: true,
    checks_failing: true,
    head_stale: true,
    conflict: true,
    merge_queue_blocked: true,
    merge_rejected: true,
    pr_closed_unmerged: true,
  };

  /** Withdraw readiness, and request a repair only for actionable evidence. */
  async function failRequirements(input: {
    companyId: string;
    unit: DeliveryUnitRow;
    blocker: DeliveryBlocker;
    signal: string;
    dedupeKey: string;
    eventType: string;
    generation: number;
  }): Promise<void> {
    const revoked = await revokeAcceptance({
      companyId: input.companyId,
      unit: input.unit,
      blocker: input.blocker,
      dedupeKey: input.dedupeKey,
      eventType: input.eventType,
      generation: input.generation,
    });
    // A newer candidate replaced this one while the evidence was being read.
    if (!revoked) return;
    if (!REPAIRABLE_REASON_CODES[input.blocker.reasonCode]) return;
    await requestRepair({
      companyId: input.companyId,
      unit: input.unit,
      reasonCode: input.blocker.reasonCode,
      message: input.blocker.message,
      signal: input.signal,
      detail: input.blocker.nextAction ?? undefined,
      candidateGeneration: input.generation,
    });
  }

  async function buildReceipt(input: {
    companyId: string;
    unit: DeliveryUnitRow;
    repository: DeliveryRepositoryRow;
    prMergedSha: string;
    mergeCommitSha: string | null;
    checks: DeliveryCheck[];
    reviewStatus: string;
    blockingFindings: number;
  }) {
    const metadata = readUnitMetadata(input.unit.metadata);
    const provenance: DeliveryProvenance = {
      repository: repositoryFullName(input.repository.owner, input.repository.name),
      githubRepositoryId: input.repository.githubRepositoryId,
      targetBranch: input.unit.targetBranch,
      sourceBranch: input.unit.sourceBranch,
      submittedHeadSha: metadata.submittedHeadSha ?? input.unit.headSha ?? "",
      acceptedHeadSha: input.unit.acceptedHeadSha ?? "",
      baseSha: input.unit.baseSha,
      mergedSha: input.prMergedSha,
      mergeCommitSha: input.mergeCommitSha,
      mergeMethod: input.unit.mergeMethod,
      squashOrRebase: input.unit.mergeMethod !== "merge",
      checks: input.checks,
      reviewStatus: input.reviewStatus,
      blockingFindings: input.blockingFindings,
      verifiedAt: new Date().toISOString(),
    };
    const now = new Date();
    await db
      .insert(deliveryReceipts)
      .values({
        companyId: input.companyId,
        unitId: input.unit.id,
        repository: provenance.repository,
        githubRepositoryId: provenance.githubRepositoryId,
        targetBranch: provenance.targetBranch,
        sourceBranch: provenance.sourceBranch,
        submittedHeadSha: provenance.submittedHeadSha,
        acceptedHeadSha: provenance.acceptedHeadSha,
        baseSha: provenance.baseSha,
        mergedSha: provenance.mergedSha,
        mergeCommitSha: provenance.mergeCommitSha,
        mergeMethod: provenance.mergeMethod,
        squashOrRebase: provenance.squashOrRebase,
        checks: provenance.checks,
        reviewStatus: provenance.reviewStatus,
        blockingFindings: provenance.blockingFindings,
        provenance,
        evidenceHash: hashEvidence(provenance),
        verifiedAt: now,
      })
      .onConflictDoNothing();
  }

  /**
   * Prove the merge landed in the intended target, then finalize. A closed or
   * unknown outcome never produces a receipt.
   */
  async function verifyMergedUnit(input: { companyId: string; unitId: string }): Promise<DeliveryReconcileOutcome> {
    const unit = await units.getUnit(input.companyId, input.unitId);
    if (!unit) throw new Error("delivery_unit_not_found");
    const repository = await units.loadRepository(input.companyId, unit.repositoryId);
    const policyRow = await policy.getRowForIssueProject(input.companyId, unit.projectId);
    if (!repository) throw new Error("delivery_repository_not_found");
    if (!unit.acceptedHeadSha || unit.acceptedHeadSha !== unit.headSha) {
      await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker(
          "head_stale",
          "Merge verification refused: the accepted revision is not the current head",
          "Reconcile and re-accept the current head before verifying the merge.",
        ),
      });
      return { unitId: unit.id, status: "blocked", phase: "merging", blocker: unit.blocker, merged: false, changed: true };
    }
    const mergedSha = unit.mergedSha ?? unit.mergeCommitSha ?? unit.headSha;
    if (!mergedSha) {
      await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("merge_unknown", "Merge outcome is unknown; no revision is available to verify"),
      });
      return { unitId: unit.id, status: "blocked", phase: "merging", blocker: unit.blocker, merged: false, changed: true };
    }
    const included = await github.compareCommits(
      input.companyId,
      policyRow?.githubConnectionId ?? null,
      repository.host,
      repository.owner,
      repository.name,
      mergedSha,
      unit.targetBranch,
    );
    if (!included.ok || !included.value.included) {
      await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker(
          "merge_unknown",
          included.ok
            ? "The reported merge revision is not included in the target branch"
            : `Could not verify merge inclusion: ${included.message}`,
          "Reconcile again once GitHub reports the merge.",
        ),
      });
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "merge_unknown",
        message: "Merge reported but inclusion in the target branch is unproven",
        dedupeKey: `merge_unknown:${mergedSha}`,
        payload: { mergedSha },
      });
      return { unitId: unit.id, status: "blocked", phase: "merging", blocker: unit.blocker, merged: false, changed: true };
    }
    const now = new Date();
    // The receipt records fresh authoritative evidence, never cached display
    // metadata. Every read must succeed; a failed read blocks instead of
    // issuing a receipt over stale evidence.
    const freshChecks = await github.getChecks(
      input.companyId,
      policyRow?.githubConnectionId ?? null,
      repository.host,
      repository.owner,
      repository.name,
      unit.acceptedHeadSha,
    );
    const freshReviews = unit.prNumber
      ? await github.getReviews(
        input.companyId,
        policyRow?.githubConnectionId ?? null,
        repository.host,
        repository.owner,
        repository.name,
        unit.prNumber,
      )
      : null;
    if (!freshChecks.ok || !freshReviews || !freshReviews.ok) {
      await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker(
          "merge_unknown",
          "Merge verified in the target branch but fresh review evidence could not be read; no receipt issued",
          "Reconcile again once GitHub is reachable.",
        ),
      });
      return { unitId: unit.id, status: "blocked", phase: "merging", blocker: unit.blocker, merged: false, changed: true };
    }
    let freshBlocking = freshReviews.value.blockingFindings;
    let freshReviewStatus = freshReviews.value.status;
    if (policyRow?.requireGreptile) {
      if (!policyRow.greptileConnectionId) {
        await units.markBlocked({
          candidateGeneration: unit.candidateGeneration,
          companyId: input.companyId,
          unitId: unit.id,
          blocker: blocker("greptile_required", "Policy requires a Greptile review", "Connect Greptile and reconcile again."),
        });
        return { unitId: unit.id, status: "blocked", phase: "merging", blocker: unit.blocker, merged: false, changed: true };
      }
      if (!unit.prNumber) {
        await units.markBlocked({
          candidateGeneration: unit.candidateGeneration,
          companyId: input.companyId,
          unitId: unit.id,
          blocker: blocker(
            "greptile_unavailable",
            "Greptile review cannot be verified because no pull request is bound to the unit",
            "Bind the pull request before verifying the merge.",
          ),
        });
        return { unitId: unit.id, status: "blocked", phase: "merging", blocker: unit.blocker, merged: false, changed: true };
      }
      // The receipt is issued over the same exact-head contract as the merge
      // decision: a completed review that names the accepted head is required,
      // and an in-flight or stale review never becomes merge evidence.
      const freshGreptile = await greptile.read({
        companyId: input.companyId,
        connectionId: policyRow.greptileConnectionId,
        repositoryName: `${repository.owner}/${repository.name}`,
        defaultBranch: unit.targetBranch,
        prNumber: unit.prNumber!,
        correlation: {
          host: repository.host,
          connectionId: policyRow.githubConnectionId ?? null,
          owner: repository.owner,
          repo: repository.name,
        },
      });
      if (!freshGreptile.ok) {
        await units.markBlocked({
          candidateGeneration: unit.candidateGeneration,
          companyId: input.companyId,
          unitId: unit.id,
          blocker: blocker(
            freshGreptile.errorCode === "provider_unknown" ? "provider_unknown" : "greptile_unavailable",
            `Greptile evidence could not be refreshed for the receipt: ${freshGreptile.message}`,
            "Reconcile again once Greptile is reachable.",
          ),
        });
        return { unitId: unit.id, status: "blocked", phase: "merging", blocker: unit.blocker, merged: false, changed: true };
      }
      if (freshGreptile.reviewState === "pending") {
        await units.markBlocked({
          candidateGeneration: unit.candidateGeneration,
          companyId: input.companyId,
          unitId: unit.id,
          blocker: blocker(
            "review_pending",
            "Greptile has not completed a review of the accepted head; no receipt issued",
            "Wait for Greptile to finish reviewing the accepted head, then reconcile again.",
          ),
        });
        return { unitId: unit.id, status: "blocked", phase: "merging", blocker: unit.blocker, merged: false, changed: true };
      }
      if (freshGreptile.headSha !== unit.acceptedHeadSha) {
        await units.markBlocked({
          candidateGeneration: unit.candidateGeneration,
          companyId: input.companyId,
          unitId: unit.id,
          blocker: blocker(
            "review_head_stale",
            "Greptile reviewed a different revision than the accepted head; no receipt issued",
            "Reconcile again once Greptile has reviewed the accepted head.",
          ),
        });
        return { unitId: unit.id, status: "blocked", phase: "merging", blocker: unit.blocker, merged: false, changed: true };
      }
      freshBlocking = Math.max(freshBlocking, freshGreptile.blockingFindings);
      // The receipt states the verdict the evidence actually supports: a
      // completed clean Greptile review of the accepted head is the review
      // verdict, but a change request from either source is recorded as one.
      freshReviewStatus = freshGreptile.status === "changes_requested"
        || freshReviews.value.status === "changes_requested"
        ? "changes_requested"
        : "approved";
    }
    // Claim the merged outcome under the generation fence *before* issuing the
    // receipt: a candidate registered while the evidence was being read owns
    // the unit now, and neither its status nor its receipt may describe the
    // replaced candidate. Once claimed, the unit is terminal, so no later
    // submission can reuse it (registration skips terminal units).
    const [updated] = await db
      .update(deliveryUnits)
      .set({
        status: "merged",
        mergedSha,
        mergedAt: unit.mergedAt ?? now,
        blocker: null,
        nextAction: null,
        lastReconciledAt: now,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(deliveryUnits.id, unit.id),
        eq(deliveryUnits.candidateGeneration, unit.candidateGeneration),
      ))
      .returning();
    if (!updated) {
      return {
        unitId: unit.id,
        status: unit.status,
        phase: deriveDeliveryPhase(unit),
        blocker: unit.blocker ?? null,
        merged: false,
        changed: false,
        stale: true,
      };
    }
    await buildReceipt({
      companyId: input.companyId,
      unit: updated,
      repository,
      prMergedSha: mergedSha,
      mergeCommitSha: unit.mergeCommitSha,
      checks: freshChecks.value,
      reviewStatus: freshReviewStatus,
      blockingFindings: freshBlocking,
    });
    await queue.setStatus({ companyId: input.companyId, unitId: unit.id, status: "merged" });
    await events.append({
      companyId: input.companyId,
      unitId: unit.id,
      issueId: unit.primaryIssueId,
      type: "merged",
      message: `Merged ${mergedSha.slice(0, 12)} into ${unit.targetBranch}`,
      dedupeKey: `merged:${mergedSha}`,
      url: unit.prUrl,
      payload: { mergedSha, targetBranch: unit.targetBranch },
    });
    await events.append({
      companyId: input.companyId,
      unitId: unit.id,
      issueId: unit.primaryIssueId,
      type: "receipt_issued",
      message: "Verified merge receipt issued",
      dedupeKey: `receipt:${mergedSha}`,
      url: unit.prUrl,
      payload: { mergedSha },
    });
    if (updated) await syncIssueStatus(input.companyId, updated, "done");
    return { unitId: unit.id, status: "merged", phase: "done", blocker: null, merged: true, changed: true };
  }

  async function reconcileUnit(input: {
    companyId: string;
    unitId: string;
    trigger: DeliveryReconcileTrigger;
  }): Promise<DeliveryReconcileOutcome> {
    const unit = await units.getUnit(input.companyId, input.unitId);
    if (!unit) throw new Error("delivery_unit_not_found");
    if (unit.status === "merged") {
      return { unitId: unit.id, status: "merged", phase: "done", blocker: null, merged: true, changed: false };
    }
    if (unit.status === "cancelled") {
      return { unitId: unit.id, status: "cancelled", phase: "not_started", blocker: null, merged: false, changed: false };
    }
    if (unit.status === "closed_unmerged") {
      // Terminal for this unit: a new candidate registers as a new unit, so
      // reconciliation never revives or re-blocks it.
      return { unitId: unit.id, status: "closed_unmerged", phase: "in_review", blocker: null, merged: false, changed: false };
    }
    const [primaryIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, unit.primaryIssueId)))
      .limit(1);
    if (primaryIssue?.status === "cancelled") {
      await units.cancelUnit({
        companyId: input.companyId,
        unitId: unit.id,
        actor: { type: "system", id: "delivery-controller" },
        reason: "Source issue cancelled",
      });
      return { unitId: unit.id, status: "cancelled", phase: "not_started", blocker: null, merged: false, changed: true };
    }
    const repository = await units.loadRepository(input.companyId, unit.repositoryId);
    if (!repository) throw new Error("delivery_repository_not_found");
    const policyRow = await policy.getRowForIssueProject(input.companyId, unit.projectId);
    const connectionId = policyRow?.githubConnectionId ?? null;
    const metadata = readUnitMetadata(unit.metadata);
    const now = new Date();

    if (!policyRow) {
      await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("policy_missing", "Project has no delivery policy"),
      });
      return { unitId: unit.id, status: "blocked", phase: "in_review", blocker: unit.blocker, merged: false, changed: true };
    }
    if (!policyRow.enabled) {
      const applied = await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("policy_disabled", "Delivery is not enabled for this project"),
      });
      if (applied) {
        await holdQueue(input.companyId, unit, "policy_disabled", "Delivery is not enabled for this project");
      }
      return { unitId: unit.id, status: "blocked", phase: "in_review", blocker: unit.blocker, merged: false, changed: true };
    }
    if (policyRow.paused || unit.pausedAt) {
      // An operator pause is preserved verbatim: in-flight reconciliation
      // holds the queue but never overwrites the pause blocker or resumes the
      // unit. Only an explicit resume clears it.
      await holdQueue(input.companyId, unit, "policy_paused", "Delivery is paused");
      return { unitId: unit.id, status: "blocked", phase: "in_review", blocker: unit.blocker, merged: false, changed: true };
    }

    const pr = unit.prNumber
      ? await github.getPullRequest(input.companyId, connectionId, repository.host, repository.owner, repository.name, unit.prNumber)
      : await github.findOpenPullRequest(
        input.companyId, connectionId, repository.host, repository.owner, repository.name, unit.sourceBranch, unit.targetBranch,
      );
    if (!pr.ok) {
      const reasonCode = pr.errorCode === "connection_missing" ? "connection_missing" : "provider_unknown";
      // A failed provider read is recorded as such for the generation it was
      // attempted for, so cached passes present as unknown instead of current.
      await recordEvidenceReadFailure({
        companyId: input.companyId,
        unit,
        generation: unit.candidateGeneration,
      });
      const applied = await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker(reasonCode, pr.message, "Reconcile again once GitHub is reachable."),
      });
      if (applied) await holdQueue(input.companyId, unit, reasonCode, pr.message);
      return { unitId: unit.id, status: "blocked", phase: "in_review", blocker: unit.blocker, merged: false, changed: true };
    }

    const pullRequest = pr.value;
    if (!pullRequest) {
      const applied = await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("candidate_required", "No open pull request exists for the candidate branch", "Publish the candidate branch and open a pull request."),
      });
      if (applied) {
        await holdQueue(input.companyId, unit, "candidate_required", "No open pull request exists for the candidate branch");
      }
      return { unitId: unit.id, status: "blocked", phase: "in_review", blocker: unit.blocker, merged: false, changed: true };
    }

    if (pullRequest.merged) {
      const merged = await writeUnitFenced({
        companyId: input.companyId,
        unitId: unit.id,
        generation: unit.candidateGeneration,
        set: {
          headSha: pullRequest.headSha,
          mergedSha: pullRequest.mergeCommitSha ?? pullRequest.headSha,
          mergeCommitSha: pullRequest.mergeCommitSha,
          lastReconciledAt: now,
          updatedAt: now,
        },
      });
      if (!merged) return staleOutcome(unit);
      return await verifyMergedUnit({ companyId: input.companyId, unitId: merged.id });
    }
    if (pullRequest.state === "closed") {
      const closed = await writeUnitFenced({
        companyId: input.companyId,
        unitId: unit.id,
        generation: unit.candidateGeneration,
        set: { status: "closed_unmerged", blocker: null, lastReconciledAt: now, updatedAt: now },
      });
      if (!closed) return staleOutcome(unit);
      await queue.setStatus({ companyId: input.companyId, unitId: unit.id, status: "cancelled" });
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "pr_closed_unmerged",
        message: "Pull request was closed without merging",
        dedupeKey: `closed_unmerged:${pullRequest.number}`,
        url: pullRequest.url,
      });
      await requestRepair({
        companyId: input.companyId,
        unit: { ...closed, status: "closed_unmerged" },
        reasonCode: "pr_closed_unmerged",
        message: "The pull request was closed without merging; reopen it or publish a new candidate.",
        signal: `v1:${hashEvidence({ reasonCode: "pr_closed_unmerged", prNumber: pullRequest.number })}`,
        candidateGeneration: closed.candidateGeneration,
      });
      return { unitId: unit.id, status: "closed_unmerged", phase: "in_review", blocker: null, merged: false, changed: true };
    }

    let changed = false;
    let nextUnit = unit;
    if (pullRequest.headSha !== unit.headSha) {
      const updated = await writeUnitFenced({
        companyId: input.companyId,
        unitId: unit.id,
        generation: unit.candidateGeneration,
        set: { headSha: pullRequest.headSha, prNumber: pullRequest.number, prUrl: pullRequest.url, updatedAt: now },
      });
      if (!updated) return staleOutcome(unit);
      nextUnit = updated;
      changed = true;
      if (unit.acceptedHeadSha && pullRequest.headSha !== unit.acceptedHeadSha) {
        await failRequirements({
          companyId: input.companyId,
          unit: nextUnit,
          blocker: blocker(
            "head_stale",
            `Remote head ${pullRequest.headSha.slice(0, 12)} no longer matches the accepted revision`,
            "Re-submit the reviewed candidate revision.",
          ),
          signal: evidenceSignal({
            reasonCode: "head_stale",
            headSha: pullRequest.headSha,
            reviewStatus: null,
            reviewHeadSha: unit.acceptedHeadSha,
            blockingFindings: 0,
            checks: null,
          }),
          dedupeKey: `head_changed:${pullRequest.headSha}`,
          eventType: "head_changed",
          generation: nextUnit.candidateGeneration,
        });
      }
    }

    const checks = await github.getChecks(
      input.companyId, connectionId, repository.host, repository.owner, repository.name, pullRequest.headSha,
    );
    const reviews = await github.getReviews(
      input.companyId, connectionId, repository.host, repository.owner, repository.name, pullRequest.number,
    );
    const authorLogin = pullRequest.authorLogin ?? null;

    // Greptile is read through the scoped gateway and every finding is
    // correlated with GitHub's own review-comment records before it counts.
    // A required-but-unavailable read blocks; an optional one only contributes
    // findings when it succeeds.
    let greptileEvidenceAvailable = !policyRow.requireGreptile;
    let greptileFindings: GreptileFinding[] = [];
    let greptileBlocking = 0;
    let greptileReviewedHead: string | null = null;
    let greptileReviewState: GreptileReviewState | null = null;
    let greptileReadVerdict: string | null = null;
    let greptileGate: DeliveryBlocker | null = null;
    if (policyRow.greptileConnectionId) {
      const greptileRead = await greptile.read({
        companyId: input.companyId,
        connectionId: policyRow.greptileConnectionId,
        repositoryName: `${repository.owner}/${repository.name}`,
        defaultBranch: unit.targetBranch,
        prNumber: pullRequest.number,
        correlation: {
          host: repository.host,
          connectionId,
          owner: repository.owner,
          repo: repository.name,
        },
      });
      if (greptileRead.ok) {
        greptileFindings = greptileRead.findings;
        greptileEvidenceAvailable = true;
        greptileReviewState = greptileRead.reviewState;
        greptileReviewedHead = greptileRead.headSha;
        greptileBlocking = greptileRead.blockingFindings;
        greptileReadVerdict = greptileRead.status;
        metadata.greptileFetchedAt = now.toISOString();
        metadata.greptileReviewState = greptileRead.reviewState;
        metadata.greptileReviewedHeadSha = greptileRead.headSha;
        metadata.greptileProviderFindings = greptileRead.providerFindings;
        // Every observed finding and its real provenance is persisted before
        // any requirement is judged: findings, review state and reviewed head
        // are operator-visible even when acceptance still fails.
        await recordObservedFindings(db, {
          companyId: input.companyId,
          unitId: unit.id,
          candidateGeneration: unit.candidateGeneration,
          headSha: greptileRead.headSha,
          findings: greptileFindings,
        });
        if (policyRow.requireGreptile && greptileRead.reviewState === "pending") {
          greptileGate = blocker(
            "review_pending",
            "Greptile has not completed a review of the current head",
            "Wait for Greptile to finish reviewing the current head, then reconcile again.",
          );
        } else if (policyRow.requireGreptile && greptileRead.headSha !== pullRequest.headSha) {
          greptileGate = blocker(
            "review_head_stale",
            `Greptile reviewed ${greptileRead.headSha?.slice(0, 12) ?? "an unknown revision"}, not the current head ${pullRequest.headSha.slice(0, 12)}`,
            "Wait for Greptile to review the current head, then reconcile again.",
          );
        }
      } else if (policyRow.requireGreptile) {
        greptileEvidenceAvailable = false;
        greptileGate = blocker(
          greptileRead.errorCode === "provider_unknown" ? "provider_unknown" : "greptile_unavailable",
          greptileRead.message,
          "Refresh the authoritative GitHub and Greptile review evidence, then reconcile again.",
        );
      }
    } else if (policyRow.requireGreptile) {
      greptileEvidenceAvailable = false;
    }

    // Findings count only for the candidate that reported them: the current
    // generation and the head under evaluation. Older findings stay in the
    // timeline as history but never block a revision they were not reported on
    // (an A -> B -> A revision history must not resurrect them).
    const openBlockingFindings = await db
      .select({
        source: deliveryFindings.source,
        externalId: deliveryFindings.externalId,
        severity: deliveryFindings.severity,
        state: deliveryFindings.state,
        title: deliveryFindings.title,
        body: deliveryFindings.body,
        filePath: deliveryFindings.filePath,
        line: deliveryFindings.line,
      })
      .from(deliveryFindings)
      .where(and(
        eq(deliveryFindings.companyId, input.companyId),
        eq(deliveryFindings.unitId, unit.id),
        eq(deliveryFindings.candidateGeneration, unit.candidateGeneration),
        eq(deliveryFindings.headSha, pullRequest.headSha),
        inArray(deliveryFindings.state, ["open", "disputed"]),
        inArray(deliveryFindings.severity, [...GREPTILE_BLOCKING_SEVERITIES]),
      ))
      .orderBy(asc(deliveryFindings.source), asc(deliveryFindings.externalId));
    const blockingFindings = Math.max(
      reviews.ok ? reviews.value.blockingFindings : 0,
      openBlockingFindings.length,
      greptileBlocking,
    );

    // Only authoritative reads feed the decision. A failed read is `null`
    // evidence, which the requirement evaluator blocks on; the cached metadata
    // written below is for display and never merge evidence. A required
    // Greptile review is part of that evidence: a completed review of the
    // exact head stands as the review verdict, and blocking findings on the
    // head block regardless of the native review state.
    const greptileRequiredAndFresh = policyRow.requireGreptile
      && greptileEvidenceAvailable
      && greptileReviewState === "completed"
      && greptileReviewedHead === pullRequest.headSha
      && greptileReadVerdict !== "changes_requested";
    const evidence: DeliveryEvidence = {
      headSha: pullRequest.headSha,
      checks: checks.ok ? checks.value : null,
      reviewStatus: greptileReadVerdict === "changes_requested" || (reviews.ok && reviews.value.status === "changes_requested")
        ? "changes_requested"
        : greptileRequiredAndFresh ? "approved" : (reviews.ok ? reviews.value.status : null),
      reviewHeadSha: greptileRequiredAndFresh
        ? greptileReviewedHead
        : (reviews.ok ? (reviews.value.approvedHeadSha ?? reviews.value.headSha) : null),
      approvals: reviews.ok ? reviews.value.approvals : null,
      prAuthorLogin: authorLogin,
      blockingFindings,
    };

    // Evidence-change detection happens before the fence so the write and the
    // events derived from the same read are decided together; the events are
    // appended only once the fenced write proves the read still describes the
    // unit's current candidate.
    let checksChanged = false;
    let reviewChanged = false;
    if (checks.ok && reviews.ok) {
      const checkSignature = checks.value.map((check) => `${check.name}:${check.status}`).sort().join("|");
      const priorSignature = (metadata.checks ?? []).map((check) => `${check.name}:${check.status}`).sort().join("|");
      checksChanged = checkSignature !== priorSignature;
      reviewChanged = evidence.reviewStatus !== metadata.reviewStatus || evidence.reviewHeadSha !== metadata.reviewHeadSha;
    }

    // Display evidence is stamped with the generation and head it was read at,
    // and a failed authoritative read is recorded as such: the board must show
    // unknown, never a cached pass, until a fresh read succeeds.
    const evidenceReadFailed = !checks.ok || !reviews.ok
      || (policyRow.requireGreptile && !greptileEvidenceAvailable);
    const nextMetadata = {
      ...metadata,
      evidenceGeneration: unit.candidateGeneration,
      lastReadFailed: evidenceReadFailed,
      checksHeadSha: pullRequest.headSha,
      ...(checks.ok ? { checks: checks.value } : {}),
      ...(reviews.ok ? { approvals: reviews.value.approvals } : {}),
      // The effective verdict is persisted whenever either authoritative source
      // produced one, so the board shows the real reviewed head and status even
      // when acceptance still fails.
      ...((reviews.ok || greptileRequiredAndFresh)
        ? { reviewStatus: greptileReadVerdict ?? evidence.reviewStatus, reviewHeadSha: greptileEvidenceAvailable && policyRow.greptileConnectionId ? greptileReviewedHead : evidence.reviewHeadSha }
        : {}),
      blockingFindings,
      authorLogin,
      lastRemoteUpdatedAt: pullRequest.updatedAt,
    };
    const refreshed = await writeUnitFenced({
      companyId: input.companyId,
      unitId: unit.id,
      generation: unit.candidateGeneration,
      set: {
        metadata: nextMetadata,
        prNumber: pullRequest.number,
        prUrl: pullRequest.url,
        lastReconciledAt: now,
        updatedAt: now,
      },
    });
    // The candidate was replaced while its evidence was being read: nothing
    // derived from this read is applied to the new candidate.
    if (!refreshed) return staleOutcome(unit);
    if (checks.ok && reviews.ok && checksChanged) {
      changed = true;
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "checks_changed",
        message: `Checks on ${pullRequest.headSha.slice(0, 12)}: ${checks.value.filter((check) => !isCheckSuccessful(check.status)).map((check) => check.name).join(", ") || "all passing"}`,
        dedupeKey: `checks:${pullRequest.headSha}:${hashEvidence(checks.value.map((check) => `${check.name}:${check.status}`).sort().join("|")).slice(0, 16)}`,
        url: pullRequest.url,
        payload: { checks: checks.value, candidateGeneration: refreshed.candidateGeneration },
      });
    }
    if (checks.ok && reviews.ok && reviewChanged) {
      changed = true;
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "review_changed",
        message: `Review status is now ${evidence.reviewStatus}`,
        dedupeKey: `review:${pullRequest.headSha}:${evidence.reviewStatus}:${evidence.reviewHeadSha ?? "none"}`,
        url: pullRequest.url,
        payload: { candidateGeneration: refreshed.candidateGeneration },
      });
    }
    if (greptileGate) {
      await revokeAcceptance({
        companyId: input.companyId,
        unit: refreshed,
        blocker: greptileGate,
        dedupeKey: `${greptileGate.reasonCode}:${pullRequest.headSha}:${greptileReviewedHead ?? "none"}`,
        eventType: "readiness_revoked",
        generation: refreshed.candidateGeneration,
      });
      return { unitId: unit.id, status: "blocked", phase: "in_review", blocker: greptileGate, merged: false, changed: true };
    }

    const decision = await policy.evaluateUnit({
      companyId: input.companyId,
      projectId: refreshed.projectId,
      targetBranch: refreshed.targetBranch,
      evidence,
      requireGreptile: greptileEvidenceAvailable,
    });

    const acceptance = nextAcceptanceState({
      acceptedHeadSha: refreshed.acceptedHeadSha,
      remoteHeadSha: refreshed.headSha,
      requirementsMet: decision.allowed,
    });

    if (!decision.allowed || acceptance.action === "revoke") {
      const blockerValue = decision.blocker ?? blocker(
        "head_stale",
        "The remote head no longer matches an accepted revision",
        "Re-submit the reviewed candidate revision.",
      );
      await failRequirements({
        companyId: input.companyId,
        unit: refreshed,
        blocker: blockerValue,
        signal: evidenceSignal({
          reasonCode: blockerValue.reasonCode,
          headSha: pullRequest.headSha,
          reviewStatus: evidence.reviewStatus,
          reviewHeadSha: evidence.reviewHeadSha,
          blockingFindings: evidence.blockingFindings,
          findings: openBlockingFindings,
          reviewChanges: reviews.ok ? reviews.value.reviews
            .filter((review) => review.state === "CHANGES_REQUESTED")
            .map((review) => JSON.stringify([review.login, review.commitSha, review.submittedAt]))
            .sort() : [],
          checks: evidence.checks?.filter((check) =>
            policyRow.requiredChecks.includes(check.name) && !isCheckSuccessful(check.status)) ?? null,
          // An explicit operator/retry reconcile is a fresh request; a poll is
          // not.
          explicitNonce: input.trigger === "retry" || input.trigger === "operator" ? now.getTime() : null,
        }),
        dedupeKey: `revoked:${blockerValue.reasonCode}:${pullRequest.headSha}`,
        eventType: "readiness_revoked",
        generation: refreshed.candidateGeneration,
      });
      return {
        unitId: refreshed.id,
        status: "blocked",
        phase: "in_review",
        blocker: blockerValue,
        merged: false,
        changed: true,
      };
    }

    let acceptedUnit = refreshed;
    if (acceptance.action === "accept" && acceptance.acceptedHeadSha) {
      const accepted = await writeUnitFenced({
        companyId: input.companyId,
        unitId: refreshed.id,
        generation: refreshed.candidateGeneration,
        set: {
          acceptedHeadSha: acceptance.acceptedHeadSha,
          blocker: null,
          nextAction: null,
          updatedAt: now,
        },
      });
      if (!accepted) return staleOutcome(refreshed);
      acceptedUnit = accepted;
      await events.append({
        companyId: input.companyId,
        unitId: refreshed.id,
        issueId: refreshed.primaryIssueId,
        type: "artifact_ready",
        message: `Accepted ${acceptance.acceptedHeadSha.slice(0, 12)} after fresh review/check evidence`,
        dedupeKey: `accepted:${acceptance.acceptedHeadSha}:g${refreshed.candidateGeneration}`,
        url: refreshed.prUrl,
      });
      // Reviewed artifact readiness: dependents wake only now that the exact
      // head stands accepted — never on the worker submit boolean alone.
      if (acceptedUnit.artifactReady) {
        await units.notifyArtifactDependents(input.companyId, acceptedUnit);
      }
    }

    if (acceptedUnit.status !== "ready_to_merge" && acceptedUnit.status !== "merging") {
      const ready = await writeUnitFenced({
        companyId: input.companyId,
        unitId: acceptedUnit.id,
        generation: acceptedUnit.candidateGeneration,
        set: {
          status: "ready_to_merge",
          blocker: null,
          nextAction: null,
          readyAt: acceptedUnit.readyAt ?? now,
          queueEnteredAt: acceptedUnit.queueEnteredAt ?? now,
          lastEventAt: now,
          updatedAt: now,
        },
      });
      if (!ready) return staleOutcome(acceptedUnit);
      await queue.enqueue({
        companyId: input.companyId,
        repositoryId: repository.id,
        targetBranch: acceptedUnit.targetBranch,
        unitId: acceptedUnit.id,
        priority: acceptedUnit.priority,
        readyAt: now,
      });
      await events.append({
        companyId: input.companyId,
        unitId: acceptedUnit.id,
        issueId: acceptedUnit.primaryIssueId,
        type: "queue_enqueued",
        message: `Ready to merge ${acceptedUnit.acceptedHeadSha?.slice(0, 12) ?? ""} under policy v${policyRow.version}`,
        dedupeKey: `ready:${acceptedUnit.acceptedHeadSha}:${policyRow.version}:g${acceptedUnit.candidateGeneration}`,
        url: acceptedUnit.prUrl,
      });
      await syncIssueStatus(input.companyId, ready, "ready_to_merge");
      return { unitId: acceptedUnit.id, status: "ready_to_merge", phase: "ready_to_merge", blocker: null, merged: false, changed: true };
    }

    return {
      unitId: acceptedUnit.id,
      status: acceptedUnit.status,
      phase: acceptedUnit.status === "merging" ? "merging" : "ready_to_merge",
      blocker: null,
      merged: false,
      changed,
    };
  }

  async function reconcileIssue(input: { companyId: string; issueId: string; trigger?: DeliveryReconcileTrigger }) {
    const unit = await units.findUnitForIssue(input.companyId, input.issueId);
    if (!unit) return null;
    return await reconcileUnit({ companyId: input.companyId, unitId: unit.id, trigger: input.trigger ?? "manual" });
  }

  /**
   * Event-driven entry point: a GitHub pull_request webhook names the repository
   * and PR number, so only the matching unit is reconciled. Delivery remains
   * correct without webhooks because `reconcileCompany` sweeps as a fallback.
   */
  async function reconcilePullRequest(input: {
    companyId: string;
    owner: string;
    repo: string;
    number: number;
  }): Promise<number> {
    const rows = await db
      .select({ unitId: deliveryUnits.id })
      .from(deliveryUnits)
      .innerJoin(deliveryRepositories, eq(deliveryRepositories.id, deliveryUnits.repositoryId))
      .where(and(
        eq(deliveryUnits.companyId, input.companyId),
        eq(deliveryUnits.prNumber, input.number),
        sql`lower(${deliveryRepositories.owner}) = lower(${input.owner})`,
        sql`lower(${deliveryRepositories.name}) = lower(${input.repo})`,
        inArray(deliveryUnits.status, ["submitted", "in_review", "ready_to_merge", "merging", "blocked", "closed_unmerged"]),
      ));
    let reconciled = 0;
    for (const row of rows) {
      await reconcileUnit({ companyId: input.companyId, unitId: row.unitId, trigger: "webhook" });
      reconciled += 1;
    }
    return reconciled;
  }

  async function reconcileCompany(input: { companyId: string; limit?: number }) {
    const openUnits = await db
      .select({ id: deliveryUnits.id })
      .from(deliveryUnits)
      .where(and(
        eq(deliveryUnits.companyId, input.companyId),
        inArray(deliveryUnits.status, ["submitted", "in_review", "ready_to_merge", "merging", "blocked", "closed_unmerged"]),
      ))
      .orderBy(asc(deliveryUnits.updatedAt))
      .limit(input.limit ?? 50);
    let reconciled = 0;
    let merged = 0;
    for (const row of openUnits) {
      const outcome = await reconcileUnit({ companyId: input.companyId, unitId: row.id, trigger: "sweep" });
      reconciled += 1;
      if (outcome.merged) merged += 1;
    }
    return { reconciled, merged };
  }

  return { reconcileUnit, reconcileIssue, reconcilePullRequest, reconcileCompany, verifyMergedUnit, requestRepair };
}
