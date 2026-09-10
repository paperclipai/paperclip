import { and, eq, inArray, sql } from "drizzle-orm";
import { deliveryFindings, deliveryUnits, type Db } from "@paperclipai/db";
import type { DeliveryBlocker } from "@paperclipai/shared";
import type { DeliveryEventService } from "./events.js";
import type { DeliveryPolicyService } from "./policy.js";
import type { DeliveryQueueService } from "./queue.js";
import type { DeliveryUnitService } from "./units.js";
import type { GitHubDeliveryClient } from "./github-client.js";
import type { GreptileReviewService } from "./greptile.js";
import type { DeliveryReconciler, DeliveryIssueStatusWriter } from "./reconciler.js";
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

  async function blockMerge(companyId: string, unit: { id: string; primaryIssueId: string }, reasonCode: string, message: string) {
    await units.markBlocked({
      companyId,
      unitId: unit.id,
      blocker: blocker(reasonCode, message),
    });
    await queue.setStatus({ companyId, unitId: unit.id, status: "blocked", lastErrorCode: reasonCode, lastError: message });
    return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode };
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
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("candidate_required", "No open pull request to merge"),
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "candidate_required" };
    }
    if (pullRequest.merged) {
      await db
        .update(deliveryUnits)
        .set({
          headSha: pullRequest.headSha,
          mergedSha: pullRequest.mergeCommitSha ?? pullRequest.headSha,
          mergeCommitSha: pullRequest.mergeCommitSha,
          updatedAt: new Date(),
        })
        .where(eq(deliveryUnits.id, unit.id));
      const outcome = await reconciler.verifyMergedUnit({ companyId: input.companyId, unitId: unit.id });
      return { unitId: unit.id, leased: false, merged: outcome.merged, queued: false, blocked: false, reasonCode: null };
    }
    if (pullRequest.state !== "open") {
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "pr_closed_unmerged" };
    }
    if (!unit.acceptedHeadSha || pullRequest.headSha !== unit.acceptedHeadSha) {
      await units.markBlocked({
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("head_stale", "The remote head no longer matches the accepted revision"),
      });
      await queue.setStatus({ companyId: input.companyId, unitId: unit.id, status: "blocked", lastErrorCode: "head_stale" });
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
    // it, the read must succeed and its reviewed head must be the exact
    // accepted head. A partial read or a stale review blocks the merge.
    let greptileAvailable = !policyRow.requireGreptile;
    let greptileBlocking = 0;
    if (policyRow.greptileConnectionId) {
      const greptileRead = await greptile.read({
        companyId: input.companyId,
        connectionId: policyRow.greptileConnectionId,
        repositoryName: `${repository.owner}/${repository.name}`,
        defaultBranch: unit.targetBranch,
        prNumber: pullRequest.number,
        submittedHeadSha: pullRequest.headSha,
        acceptedHeadSha: unit.acceptedHeadSha,
        checks: checks.ok ? checks.value : [],
      });
      if (!greptileRead.ok) {
        if (policyRow.requireGreptile) {
          return await blockMerge(input.companyId, unit, "greptile_unavailable", greptileRead.message);
        }
      } else if (policyRow.requireGreptile && greptileRead.headSha !== unit.acceptedHeadSha) {
        return await blockMerge(
          input.companyId, unit, "review_head_stale",
          "Greptile reviewed a different revision than the accepted head",
        );
      } else {
        greptileAvailable = true;
        greptileBlocking = greptileRead.blockingFindings;
      }
    }
    const openBlockingFindings = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryFindings)
      .where(and(
        eq(deliveryFindings.companyId, input.companyId),
        eq(deliveryFindings.unitId, unit.id),
        inArray(deliveryFindings.state, ["open", "disputed"]),
        inArray(deliveryFindings.severity, ["critical", "high", "error", "blocker"]),
      ))
      .then((rows) => rows[0]?.count ?? 0);
    const evidence: DeliveryEvidence = {
      headSha: unit.acceptedHeadSha,
      checks: checks.ok ? checks.value : null,
      reviewStatus: reviews.ok ? reviews.value.status : null,
      reviewHeadSha: reviews.ok ? (reviews.value.approvedHeadSha ?? reviews.value.headSha) : null,
      approvals: reviews.ok ? reviews.value.approvals : null,
      prAuthorLogin: pullRequest.authorLogin ?? null,
      blockingFindings: Math.max(reviews.ok ? reviews.value.blockingFindings : 0, openBlockingFindings, greptileBlocking),
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
      await units.markBlocked({
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blockerValue,
        nextAction: blockerValue.nextAction,
      });
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

    if (policyRow.mergeQueueMode === "native_merge_queue") {
      if (!pullRequest.nodeId) {
        await units.markBlocked({
          companyId: input.companyId,
          unitId: unit.id,
          blocker: blocker("merge_queue_blocked", "Pull request node id is unavailable for the merge queue"),
        });
        return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "merge_queue_blocked" };
      }
      const enqueued = await github.enqueuePullRequest({
        companyId: input.companyId,
        connectionId,
        host: repository.host,
        pullRequestNodeId: pullRequest.nodeId,
      });
      if (!enqueued.ok) {
        const mapped = mergeFailureReason(enqueued.status, enqueued.message);
        await units.markBlocked({
          companyId: input.companyId,
          unitId: unit.id,
          blocker: blocker(mapped.reasonCode, mapped.message),
        });
        return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: mapped.reasonCode };
      }
      await db
        .update(deliveryUnits)
        .set({
          status: "merging",
          mergeAttemptCount: unit.mergeAttemptCount + 1,
          mergeRequestedAt: now,
          lastEventAt: now,
          updatedAt: now,
        })
        .where(eq(deliveryUnits.id, unit.id));
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
    await db
      .update(deliveryUnits)
      .set({
        mergeAttemptCount: unit.mergeAttemptCount + 1,
        mergeRequestedAt: now,
        updatedAt: now,
      })
      .where(eq(deliveryUnits.id, unit.id));
    if (!merged.ok) {
      const mapped = mergeFailureReason(merged.status, merged.message);
      await units.markBlocked({
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker(mapped.reasonCode, mapped.message, "Repair and reconcile again."),
      });
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
      await reconciler.wakeOwnerForRepair({
        companyId: input.companyId,
        unit: unit,
        reasonCode: mapped.reasonCode,
        message: mapped.message,
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: mapped.reasonCode };
    }
    if (!merged.value.merged) {
      await units.markBlocked({
        companyId: input.companyId,
        unitId: unit.id,
        blocker: blocker("merge_unknown", merged.value.message || "GitHub did not confirm the merge"),
      });
      return { unitId: unit.id, leased: false, merged: false, queued: false, blocked: true, reasonCode: "merge_unknown" };
    }
    await db
      .update(deliveryUnits)
      .set({
        status: "merging",
        mergedSha: merged.value.sha ?? unit.acceptedHeadSha,
        mergeCommitSha: merged.value.sha ?? null,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(eq(deliveryUnits.id, unit.id));
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
