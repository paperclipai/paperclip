import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { deliveryFindings, deliveryUnitIssues, deliveryUnits, type Db } from "@paperclipai/db";
import type { DeliveryBlocker } from "@paperclipai/shared";
import type { DeliveryEventService } from "./events.js";
import type { DeliveryPolicyService } from "./policy.js";
import type { DeliveryQueueService } from "./queue.js";
import type { DeliveryUnitService } from "./units.js";
import type { GitHubDeliveryClient } from "./github-client.js";
import type { GreptileReviewService } from "./greptile.js";
import { GREPTILE_BLOCKING_SEVERITIES, providerVerdictRejects } from "./greptile.js";
import type { DeliveryReconciler, DeliveryIssueStatusWriter } from "./reconciler.js";
import { readNativeReviewEvidence } from "./native-review.js";
import type { DeliveryControllerContext } from "./done-gate.js";
import { repositoryFullName, type DeliveryEvidence } from "./policy.js";

export const DELIVERY_MERGE_LEASE_OWNER_PREFIX = "delivery-merge";
export const DELIVERY_MAX_MERGE_ATTEMPTS = 5;
export type DeliveryMergeOutcome = {
  unitId: string | null;
  leased: boolean;
  merged: boolean;
  queued: boolean;
  blocked: boolean;
  reasonCode: string | null;
};

export interface DeliveryMergeExecutor {
  sweepRepository(input: {
    companyId: string;
    repositoryId: string;
    targetBranch: string;
    leaseOwner: string;
  }): Promise<DeliveryMergeOutcome[]>;
  sweepCompany(input: { companyId: string; leaseOwner: string }): Promise<DeliveryMergeOutcome[]>;
  attemptMerge(input: { companyId: string; unitId: string; lease?: { leaseOwner: string; leaseEpoch: number } }): Promise<DeliveryMergeOutcome>;
}

function blocker(reasonCode: string, message: string, nextAction: string | null = null): DeliveryBlocker {
  return { reasonCode, message, owner: null, nextAction };
}

export function deliveryMergeExecutor(
  db: Db,
  deps: {
    policy: DeliveryPolicyService;
    queue: DeliveryQueueService;
    events: DeliveryEventService;
    units: DeliveryUnitService;
    github: GitHubDeliveryClient;
    greptile: GreptileReviewService;
    reconciler: DeliveryReconciler;
    setIssueStatus: DeliveryIssueStatusWriter;
  },
): DeliveryMergeExecutor {
  const { policy, queue, events, units, github, greptile, reconciler, setIssueStatus } = deps;

  function mergeFailureReason(status: number | null, message: string) {
    const normalized = message.toLowerCase();
    if (normalized.includes("conflict") || status === 409) {
      return { reasonCode: "conflict", message: "The pull request conflicts with the target branch" };
    }
    if (normalized.includes("sha") || normalized.includes("head") || normalized.includes("stale")) {
      return { reasonCode: "head_stale", message: "GitHub rejected the merge because the head revision changed" };
    }
    if (status === 405) {
      return { reasonCode: "merge_queue_blocked", message: "Branch protection or merge queue requirements are not satisfied" };
    }
    return { reasonCode: "merge_rejected", message: message || "GitHub rejected the merge" };
  }

  /** Fencing read: the lease is held only by its current owner at its epoch. */
  async function leaseHeld(companyId: string, unitId: string, lease: { leaseOwner: string; leaseEpoch: number }) {
    const entry = await queue.getEntry(companyId, unitId);
    return entry != null
      && entry.status === "leased"
      && entry.leaseOwner === lease.leaseOwner
      && entry.leaseEpoch === lease.leaseEpoch
      && (entry.leaseExpiresAt == null || entry.leaseExpiresAt.getTime() > Date.now());
  }

  async function blockMerge(
    companyId: string,
    unit: { id: string; primaryIssueId: string; candidateGeneration: number },
    reasonCode: string,
    message: string,
  ) {
    const applied = await units.markBlocked({
      companyId,
      unitId: unit.id,
      blocker: blocker(reasonCode, message),
      candidateGeneration: unit.candidateGeneration,
    });
    // A dropped blocker write (replaced candidate, or a unit that has since
    // gone terminal) must not touch the unit's queue entry either.
    if (!applied) {
      return {
        unitId: unit.id,
        leased: false,
        merged: false,
        queued: false,
        blocked: false,
        reasonCode: await fencedWriteMiss({ companyId, unitId: unit.id, generation: unit.candidateGeneration }),
      };
    }
    await queue.setStatus({ companyId, unitId: unit.id, status: "blocked", lastErrorCode: reasonCode, lastError: message });
    return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode };
  }

  /**
   * Why a generation-fenced write matched no row. The candidate can have been
   * replaced, or the unit can have left the open set (merged, cancelled, closed
   * unmerged) while this attempt was in flight; both mean the write was
   * correctly refused, and the outcome names which one so operators are not
   * left guessing.
   */
  async function fencedWriteMiss(input: {
    companyId: string;
    unitId: string;
    generation: number;
  }): Promise<"unit_missing" | "candidate_replaced" | "unit_not_open"> {
    const current = await units.getUnit(input.companyId, input.unitId);
    if (!current) return "unit_missing";
    if (current.candidateGeneration !== input.generation) return "candidate_replaced";
    return "unit_not_open";
  }

  /**
   * Whether the accepted candidate this attempt was planned for is still the
   * unit's current candidate. Merge decisions are made from asynchronous
   * provider reads; a candidate registered in the meantime owns the unit and
   * must not be merged under — or blocked by — the replaced candidate's
   * evidence.
   */
  async function candidateStillCurrent(input: {
    companyId: string;
    unitId: string;
    generation: number;
    acceptedHeadSha: string | null;
  }): Promise<boolean> {
    const current = await units.getUnit(input.companyId, input.unitId);
    return current != null
      && current.candidateGeneration === input.generation
      && current.acceptedHeadSha === input.acceptedHeadSha;
  }

  async function attemptMerge(input: { companyId: string; unitId: string; lease?: { leaseOwner: string; leaseEpoch: number } }): Promise<DeliveryMergeOutcome> {
    const unit = await units.getUnit(input.companyId, input.unitId);
    if (!unit) return { unitId: null, leased: false, merged: false, queued: false, blocked: false, reasonCode: "unit_missing" };
    if (unit.status === "merged" || unit.status === "cancelled") {
      return { unitId: unit.id, leased: false, merged: unit.status === "merged", queued: false, blocked: false, reasonCode: null };
    }
    if (input.lease && !(await leaseHeld(input.companyId, input.unitId, input.lease))) {
      // Fencing: the queue lease moved on (expired, released, or stolen) while
      // this attempt was queued. Never merge without holding the current lease.
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "lease_lost" };
    }
    if (unit.status !== "ready_to_merge" && unit.status !== "merging") {
      // Only accepted units are ever leased; a stale queue row is not a licence
      // to merge.
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: false, reasonCode: "not_ready" };
    }
    const repository = await units.loadRepository(input.companyId, unit.repositoryId);
    const policyRow = await policy.getRowForIssueProject(input.companyId, unit.projectId);
    if (!repository || !policyRow) {
      await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("policy_missing", "Delivery policy or repository is missing"),
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "policy_missing" };
    }
    if (!policyRow.enabled || policyRow.paused) {
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "policy_paused" };
    }
    if (unit.mergeAttemptCount >= DELIVERY_MAX_MERGE_ATTEMPTS) {
      await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("repair_attempts_exhausted", "Merge attempts exhausted", "Escalate to the operator."),
      });
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "escalated",
        message: "Merge attempts exhausted; operator action required",
        dedupeKey: `merge_exhausted:${unit.id}`,
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "repair_attempts_exhausted" };
    }

    const connectionId = policyRow.githubConnectionId;
    const pr = unit.prNumber
      ? await github.getPullRequest(input.companyId, connectionId, repository.host, repository.owner, repository.name, unit.prNumber)
      : await github.findOpenPullRequest(
        input.companyId, connectionId, repository.host, repository.owner, repository.name, unit.sourceBranch, unit.targetBranch,
      );
    if (!pr.ok) {
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "provider_unknown" };
    }
    const pullRequest = pr.value;
    if (!pullRequest) {
      await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("candidate_required", "No open pull request to merge"),
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "candidate_required" };
    }
    if (pullRequest.merged) {
      const updated = await db
        .update(deliveryUnits)
        .set({
          headSha: pullRequest.headSha,
          mergedSha: pullRequest.mergeCommitSha ?? pullRequest.headSha,
          mergeCommitSha: pullRequest.mergeCommitSha,
          updatedAt: new Date(),
        })
        .where(and(
          eq(deliveryUnits.id, unit.id),
          eq(deliveryUnits.candidateGeneration, unit.candidateGeneration),
          // Terminal is permanent: an attempt that was planned while the unit
          // was open never restates a unit that has since merged or closed.
          notInArray(deliveryUnits.status, ["merged", "cancelled", "closed_unmerged"]),
        ))
        .returning({ id: deliveryUnits.id });
      if (updated.length === 0) {
        return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: false, reasonCode: await fencedWriteMiss({ companyId: input.companyId, unitId: unit.id, generation: unit.candidateGeneration }) };
      }
      const outcome = await reconciler.verifyMergedUnit({ companyId: input.companyId, unitId: unit.id });
      return { unitId: unit.id, leased: false, merged: outcome.merged, queued: false, blocked: false, reasonCode: null };
    }
    if (pullRequest.state !== "open") {
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "pr_closed_unmerged" };
    }
    if (!unit.acceptedHeadSha || pullRequest.headSha !== unit.acceptedHeadSha) {
      const applied = await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("head_stale", "The remote head no longer matches the accepted revision"),
      });
      if (applied) {
        await queue.setStatus({ companyId: input.companyId, unitId: unit.id, status: "blocked", lastErrorCode: "head_stale" });
      }
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "head_changed",
        message: "Merge refused: accepted revision is no longer the remote head",
        dedupeKey: `merge_refused_head:${pullRequest.headSha}`,
        url: pullRequest.url,
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "head_stale" };
    }

    // Re-read authoritative evidence for the accepted head. A failed read is
    // `null` evidence and blocks; persisted metadata is display-only.
    const checks = await github.getChecks(
      input.companyId, connectionId, repository.host, repository.owner, repository.name, unit.acceptedHeadSha,
    );
    const reviews = await github.getReviews(
      input.companyId, connectionId, repository.host, repository.owner, repository.name, pullRequest.number,
    );
    // A merge needs full fresh Greptile evidence too: when the policy requires
    // it, the read must succeed, the review must be completed, and its reviewed
    // head must be the exact accepted head. A partial read, an in-flight
    // review, or a stale review blocks the merge.
    let greptileAvailable = !policyRow.requireGreptile;
    let greptileBlocking = 0;
    let greptileStaleResolutions = 0;
    let greptileProviderVerdict: string | null = null;
    let greptileApproves = false;
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
          headSha: unit.acceptedHeadSha,
        },
      });
      if (!greptileRead.ok) {
        if (policyRow.requireGreptile) {
          return await blockMerge(input.companyId, unit, greptileRead.errorCode === "provider_unknown" ? "provider_unknown" : "greptile_unavailable", greptileRead.message);
        }
      } else {
        if (policyRow.requireGreptile && greptileRead.reviewState === "pending") {
          return await blockMerge(
            input.companyId, unit, "review_pending",
            "Greptile has not completed a review of the accepted head",
          );
        }
        if (policyRow.requireGreptile && greptileRead.headSha !== unit.acceptedHeadSha) {
          return await blockMerge(
            input.companyId, unit, "review_head_stale",
            "Greptile reviewed a different revision than the accepted head",
          );
        }
        greptileAvailable = true;
        greptileBlocking = greptileRead.blockingFindings;
        greptileStaleResolutions = greptileRead.staleResolutionFindings;
        greptileProviderVerdict = greptileRead.providerVerdict;
        greptileApproves = greptileRead.status !== "changes_requested";
      }
    }
    // Blocking findings count for the candidate that reported them, exactly as
    // they do in reconciliation: the current generation and the head under
    // evaluation. An unresolved finding of a replaced candidate is history — it
    // neither blocks nor explains the new one, and leaving it in this count
    // would block a merge no reconciliation path can ever clear.
    const openBlockingFindings = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryFindings)
      .where(and(
        eq(deliveryFindings.companyId, input.companyId),
        eq(deliveryFindings.unitId, unit.id),
        eq(deliveryFindings.candidateGeneration, unit.candidateGeneration),
        eq(deliveryFindings.headSha, pullRequest.headSha),
        inArray(deliveryFindings.state, ["open", "disputed"]),
        inArray(deliveryFindings.severity, [...GREPTILE_BLOCKING_SEVERITIES]),
      ))
      .then((rows) => rows[0]?.count ?? 0);
    // Merge-time evidence follows the same exact-head contract as
    // reconciliation: a required Greptile review that names the accepted head
    // and carries no blocking findings is the review verdict for that head, and
    // a native independent review only counts for the exact accepted revision.
    const greptileVerdict = policyRow.requireGreptile && greptileAvailable;
    const reviewStatus = greptileVerdict
      ? (greptileApproves ? "approved" : "changes_requested")
      : (reviews.ok ? reviews.value.status : null);
    const unitIssueIds = await db
      .select({ issueId: deliveryUnitIssues.issueId })
      .from(deliveryUnitIssues)
      .where(and(eq(deliveryUnitIssues.companyId, input.companyId), eq(deliveryUnitIssues.unitId, unit.id)))
      .then((rows) => rows.map((row) => row.issueId));
    const nativeReview = await readNativeReviewEvidence(db, {
      companyId: input.companyId,
      issueIds: unitIssueIds,
      headSha: unit.acceptedHeadSha,
      excludedReviewerAgentIds: [unit.ownerAgentId].filter((agentId): agentId is string => agentId != null),
    });
    const evidence: DeliveryEvidence = {
      headSha: unit.acceptedHeadSha,
      checks: checks.ok ? checks.value : null,
      reviewStatus,
      reviewHeadSha: greptileVerdict && greptileApproves
        ? unit.acceptedHeadSha
        : (reviews.ok ? (reviews.value.approvedHeadSha ?? reviews.value.headSha) : null),
      approvals: reviews.ok ? reviews.value.approvals : null,
      prAuthorLogin: pullRequest.authorLogin ?? null,
      blockingFindings: Math.max(
        reviews.ok ? reviews.value.blockingFindings : 0,
        openBlockingFindings,
        greptileBlocking,
      ),
      staleResolutionFindings: greptileStaleResolutions,
      independentChangesRequested: (reviews.ok && reviews.value.status === "changes_requested")
        || providerVerdictRejects(greptileProviderVerdict),
      nativeReview,
    };
    const decision = await policy.evaluateUnit({
      companyId: input.companyId,
      projectId: unit.projectId,
      targetBranch: unit.targetBranch,
      evidence,
      requireGreptile: greptileAvailable,
    });
    if (!decision.allowed) {
      const blockerValue = decision.blocker!;
      const applied = await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blockerValue,
        nextAction: blockerValue.nextAction,
      });
      if (!applied) {
        return {
          unitId: unit.id,
          leased: false,
          merged: false,
          queued: false,
          blocked: false,
          reasonCode: await fencedWriteMiss({ companyId: input.companyId, unitId: unit.id, generation: unit.candidateGeneration }),
        };
      }
      await queue.setStatus({
        companyId: input.companyId,
        unitId: unit.id,
        status: "blocked",
        lastErrorCode: blockerValue.reasonCode,
        lastError: blockerValue.message,
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: blockerValue.reasonCode };
    }

    const now = new Date();
    const controller: DeliveryControllerContext = {
      controller: "delivery-controller",
      unitId: unit.id,
      reason: "merge",
    };

    // Provider evidence reads may outlive or revoke the lease. Fence again
    // before either GitHub side effect; leave the current owner's state alone.
    if (input.lease && !(await leaseHeld(input.companyId, input.unitId, input.lease))) {
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "lease_lost" };
    }
    // The candidate can be replaced while the evidence is being read. A GitHub
    // merge is an external side effect that cannot be fenced by a database
    // write, so the candidate identity is re-read immediately before it: if a
    // submission replaced it, this attempt performs no remote write at all.
    if (!(await candidateStillCurrent({
      companyId: input.companyId,
      unitId: input.unitId,
      generation: unit.candidateGeneration,
      acceptedHeadSha: unit.acceptedHeadSha,
    }))) {
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: false, reasonCode: await fencedWriteMiss({ companyId: input.companyId, unitId: unit.id, generation: unit.candidateGeneration }) };
    }

    if (policyRow.mergeQueueMode === "native_merge_queue") {
      if (!pullRequest.nodeId) {
        return await blockMerge(input.companyId, unit, "provider_unknown",
          "Pull request node id is unavailable for the merge queue");
      }
      // The queue entry is bound to the accepted revision, and the remote head
      // is re-read immediately before the enqueue: a queue entry that could
      // merge a head pushed after the evidence read would bypass the exact-head
      // review the agent-review regime depends on.
      const currentHead = await github.getPullRequest(
        input.companyId, connectionId, repository.host, repository.owner, repository.name, pullRequest.number,
      );
      if (!currentHead.ok) {
        return await blockMerge(input.companyId, unit, "provider_unknown", currentHead.message);
      }
      if (currentHead.value.headSha !== unit.acceptedHeadSha) {
        return await blockMerge(
          input.companyId, unit, "head_stale",
          "The remote head moved before the merge queue could be bound to the accepted revision",
        );
      }
      const enqueued = await github.enqueuePullRequest({
        companyId: input.companyId,
        connectionId,
        host: repository.host,
        pullRequestNodeId: pullRequest.nodeId,
        expectedHeadOid: unit.acceptedHeadSha,
      });
      // A provider that refuses the exact-head binding rejected the request
      // before any queue attempt existed, so it must not consume the bounded
      // merge-attempt budget. Narrowed explicitly: a GitHubResult only carries
      // an error code on its failure branch.
      const bindingRefused = !enqueued.ok && enqueued.errorCode === "merge_queue_head_binding_unsupported";
      const recorded = await db
        .update(deliveryUnits)
        .set({
          status: enqueued.ok ? "merging" : undefined,
          mergeAttemptCount: bindingRefused ? unit.mergeAttemptCount : unit.mergeAttemptCount + 1,
          mergeRequestedAt: now,
          lastEventAt: enqueued.ok ? now : undefined,
          updatedAt: now,
        })
        .where(and(
          eq(deliveryUnits.id, unit.id),
          eq(deliveryUnits.candidateGeneration, unit.candidateGeneration),
          // Terminal is permanent: an attempt that was planned while the unit
          // was open never restates a unit that has since merged or closed.
          notInArray(deliveryUnits.status, ["merged", "cancelled", "closed_unmerged"]),
        ))
        .returning({ id: deliveryUnits.id });
      if (recorded.length === 0) {
        // The candidate changed while enqueue was in flight. Record the remote
        // result without attributing it to the replacement; a failed response
        // is not proof that GitHub created no queue entry.
        await events.append({
          companyId: input.companyId,
          unitId: unit.id,
          issueId: unit.primaryIssueId,
          type: "merge_queued",
          message: enqueued.ok
            ? `Merge queue entry for the replaced revision ${unit.acceptedHeadSha.slice(0, 12)} was submitted; the new candidate is unaffected`
            : `Merge queue enqueue for the replaced revision ${unit.acceptedHeadSha.slice(0, 12)} was not confirmed (${enqueued.errorCode}); the new candidate is unaffected`,
          dedupeKey: `merge_queued_stale:${unit.acceptedHeadSha}`,
          url: pullRequest.url,
          payload: { reasonCode: "candidate_replaced" },
        });
        return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: false, reasonCode: await fencedWriteMiss({ companyId: input.companyId, unitId: unit.id, generation: unit.candidateGeneration }) };
      }
      if (!enqueued.ok) {
        // A provider that cannot bind the entry to the accepted head fails
        // closed with its own named reason: enqueueing unbound would let the
        // queue merge a revision no review evaluated. Branch protection is
        // never bypassed as a workaround.
        const mapped = enqueued.errorCode === "merge_queue_head_binding_unsupported"
          ? {
            reasonCode: "merge_queue_unsupported",
            message: "GitHub's merge queue does not accept an exact-head binding on this host, so the queue cannot be proven to merge the reviewed revision. Use the serialized merge mode for this repository.",
          }
          : mergeFailureReason(enqueued.status, enqueued.message);
        const applied = await units.markBlocked({
          candidateGeneration: unit.candidateGeneration,
          companyId: input.companyId,
          unitId: unit.id,
          blocker: blocker(mapped.reasonCode, mapped.message),
        });
        if (!applied) {
          return {
            unitId: unit.id,
            leased: false,
            merged: false,
            queued: false,
            blocked: false,
            reasonCode: await fencedWriteMiss({ companyId: input.companyId, unitId: unit.id, generation: unit.candidateGeneration }),
          };
        }
        await queue.setStatus({
          companyId: input.companyId, unitId: unit.id, status: "blocked",
          lastErrorCode: mapped.reasonCode, lastError: mapped.message,
        });
        await reconciler.requestRepair({
          companyId: input.companyId,
          unit,
          reasonCode: mapped.reasonCode,
          message: mapped.message,
          signal: `native_queue:${unit.acceptedHeadSha}:${mapped.reasonCode}:${mapped.message}`,
          candidateGeneration: unit.candidateGeneration,
        });
        return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: mapped.reasonCode };
      }
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "merge_queued",
        message: `Enqueued ${unit.acceptedHeadSha.slice(0, 12)} into the native merge queue`,
        dedupeKey: `merge_queued:${unit.acceptedHeadSha}`,
        url: pullRequest.url,
        payload: { position: enqueued.value.position },
      });
      await setIssueStatus({ companyId: input.companyId, issueId: unit.primaryIssueId, status: "merging", controller });
      return { unitId: unit.id, leased: false, merged: false, queued: true, blocked: false, reasonCode: null };
    }

    const merged = await github.mergePullRequest(
      input.companyId,
      connectionId,
      repository.host,
      repository.owner,
      repository.name,
      pullRequest.number,
      {
        sha: unit.acceptedHeadSha,
        mergeMethod: policyRow.mergeMethod,
        commitTitle: `${unit.sourceBranch} (#${pullRequest.number})`,
      },
    );
    const mergeRecorded = await db
      .update(deliveryUnits)
      .set({
        mergeAttemptCount: unit.mergeAttemptCount + 1,
        mergeRequestedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(deliveryUnits.id, unit.id),
        eq(deliveryUnits.candidateGeneration, unit.candidateGeneration),
        notInArray(deliveryUnits.status, ["merged", "cancelled", "closed_unmerged"]),
      ))
      .returning({ id: deliveryUnits.id });
    if (mergeRecorded.length === 0) {
      // The merge call was already issued for the previous candidate when the
      // replacement landed: the remote effect exists, but this attempt owns no
      // further state for it. Report the ambiguity instead of blocking or
      // merging the new candidate under it.
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "merge_unknown",
        message: `Merge of the replaced revision ${unit.acceptedHeadSha.slice(0, 12)} was attempted; verify the remote result before acting on the new candidate`,
        dedupeKey: `merge_stale_candidate:${unit.acceptedHeadSha}`,
        url: pullRequest.url,
        payload: { reasonCode: "candidate_replaced" },
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: false, reasonCode: await fencedWriteMiss({ companyId: input.companyId, unitId: unit.id, generation: unit.candidateGeneration }) };
    }
    if (!merged.ok) {
      const mapped = mergeFailureReason(merged.status, merged.message);
      const applied = await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker(mapped.reasonCode, mapped.message, "Repair and reconcile again."),
      });
      if (!applied) {
        return {
          unitId: unit.id,
          leased: false,
          merged: false,
          queued: false,
          blocked: false,
          reasonCode: await fencedWriteMiss({ companyId: input.companyId, unitId: unit.id, generation: unit.candidateGeneration }),
        };
      }
      await queue.setStatus({
        companyId: input.companyId,
        unitId: unit.id,
        status: "blocked",
        lastErrorCode: mapped.reasonCode,
        lastError: mapped.message,
      });
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "merge_rejected",
        message: mapped.message,
        dedupeKey: `merge_rejected:${unit.acceptedHeadSha}:${mapped.reasonCode}`,
        url: pullRequest.url,
        payload: { reasonCode: mapped.reasonCode },
      });
      await reconciler.requestRepair({
        companyId: input.companyId,
        unit,
        reasonCode: mapped.reasonCode,
        message: mapped.message,
        signal: `v1:${mapped.reasonCode}:${unit.acceptedHeadSha}:${mapped.message}`,
        candidateGeneration: unit.candidateGeneration,
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: mapped.reasonCode };
    }
    if (!merged.value.merged) {
      await units.markBlocked({
        candidateGeneration: unit.candidateGeneration,
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("merge_unknown", merged.value.message || "GitHub did not confirm the merge"),
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "merge_unknown" };
    }
    const merging = await db
      .update(deliveryUnits)
      .set({
        status: "merging",
        mergedSha: merged.value.sha ?? unit.acceptedHeadSha,
        mergeCommitSha: merged.value.sha ?? null,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(deliveryUnits.id, unit.id),
        eq(deliveryUnits.candidateGeneration, unit.candidateGeneration),
        notInArray(deliveryUnits.status, ["merged", "cancelled", "closed_unmerged"]),
      ))
      .returning({ id: deliveryUnits.id });
    if (merging.length === 0) {
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: unit.primaryIssueId,
        type: "merge_unknown",
        message: `Merged ${merged.value.sha?.slice(0, 12) ?? unit.acceptedHeadSha?.slice(0, 12) ?? ""} for the replaced revision; verify the remote result before acting on the new candidate`,
        dedupeKey: `merge_stale_candidate:${unit.acceptedHeadSha}`,
        url: pullRequest.url,
        payload: { reasonCode: "candidate_replaced" },
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: false, reasonCode: await fencedWriteMiss({ companyId: input.companyId, unitId: unit.id, generation: unit.candidateGeneration }) };
    }
    await events.append({
      companyId: input.companyId,
      unitId: unit.id,
      issueId: unit.primaryIssueId,
      type: "merge_started",
      message: `Merging ${unit.acceptedHeadSha.slice(0, 12)} into ${unit.targetBranch}`,
      dedupeKey: `merge_started:${unit.acceptedHeadSha}`,
      url: pullRequest.url,
    });
    if (input.lease && !(await leaseHeld(input.companyId, input.unitId, input.lease))) {
      // The lease moved on during the merge call. Reconcile ambiguity before
      // repeating the side effect: verify instead of merging again.
      const outcome = await reconciler.verifyMergedUnit({ companyId: input.companyId, unitId: unit.id });
      return { unitId: unit.id, leased: false, merged: outcome.merged, queued: false, blocked: !outcome.merged, reasonCode: outcome.merged ? null : "lease_lost" };
    }
    await setIssueStatus({ companyId: input.companyId, issueId: unit.primaryIssueId, status: "merging", controller });
    const outcome = await reconciler.verifyMergedUnit({ companyId: input.companyId, unitId: unit.id });
    return { unitId: unit.id, leased: false, merged: outcome.merged, queued: false, blocked: !outcome.merged, reasonCode: outcome.merged ? null : "merge_unknown" };
  }

  /**
   * Serialize one repository+branch: lease the head entry, merge it, and return.
   * Independent repositories run concurrently because the key includes the
   * repository identity.
   */
  async function sweepRepository(input: {
    companyId: string;
    repositoryId: string;
    targetBranch: string;
    leaseOwner: string;
  }): Promise<DeliveryMergeOutcome[]> {
    const outcomes: DeliveryMergeOutcome[] = [];
    await queue.reconcileExpiredLeases();
    // Unique per sweep so two processes never share a fencing identity.
    const sweepOwner = `${input.leaseOwner}:${Date.now()}`;
    for (let guard = 0; guard < 10; guard += 1) {
      const leased = await queue.leaseNext({
        companyId: input.companyId,
        repositoryId: input.repositoryId,
        targetBranch: input.targetBranch,
        leaseOwner: sweepOwner,
      });
      if (!leased) break;
      const outcome = await attemptMerge({
        companyId: input.companyId,
        unitId: leased.unitId,
        lease: { leaseOwner: sweepOwner, leaseEpoch: leased.leaseEpoch },
      });
      outcomes.push({ ...outcome, leased: true });
      if (outcome.merged) {
        // The repository+branch lock is free again; continue with the next
        // queued unit in the same sweep.
        continue;
      }
      if (outcome.queued) {
        await queue.releaseLease({
          companyId: input.companyId,
          unitId: leased.unitId,
          leaseOwner: sweepOwner,
          leaseEpoch: leased.leaseEpoch,
        });
        break;
      }
      if (outcome.blocked) {
        await queue.releaseLease({
          companyId: input.companyId,
          unitId: leased.unitId,
          leaseOwner: sweepOwner,
          leaseEpoch: leased.leaseEpoch,
          reasonCode: outcome.reasonCode ?? "merge_blocked",
        });
        // Stop at the first blocked head so the next queued unit waits for this
        // repository+branch, preserving order.
        break;
      }
    }
    return outcomes;
  }

  async function sweepCompany(input: { companyId: string; leaseOwner: string }) {
    const keys = await queue.listActiveRepositoryKeys(input.companyId);
    const outcomes: DeliveryMergeOutcome[] = [];
    for (const key of keys) {
      outcomes.push(...await sweepRepository({
        companyId: input.companyId,
        repositoryId: key.repositoryId,
        targetBranch: key.targetBranch,
        leaseOwner: `${input.leaseOwner}:${key.repositoryId}:${key.targetBranch}`,
      }));
    }
    return outcomes;
  }

  return { sweepRepository, sweepCompany, attemptMerge };
}

/** Human-readable repository label used in queue leases and events. */
export function repositoryLabel(owner: string, name: string) {
  return repositoryFullName(owner, name);
}
