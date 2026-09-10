import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  deliveryPolicies,
  deliveryUnitIssues,
  deliveryUnits,
  issues,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound } from "../../errors.js";
import type {
  DeliveryPolicy,
  DeliveryReconciliationInventory,
  DeliveryReviewSummary,
  DeliverySummary,
  DeliveryUnitDetail,
} from "@paperclipai/shared";
import { issueService } from "../issues.js";
import type { ToolGatewayService } from "../tool-gateway.js";
import { createGitHubDeliveryClient, type GitHubDeliveryClient } from "./github-client.js";
import { deliveryEventService, type DeliveryEventService } from "./events.js";
import { deliveryPolicyService, type DeliveryPolicyService, type PolicyWriteInput } from "./policy.js";
import { deliveryQueueService, type DeliveryQueueService } from "./queue.js";
import { deliveryUnitService, readUnitMetadata, type DeliveryActor, type DeliveryIssueRow, type DeliveryUnitService, type DeliveryWakeEnqueue } from "./units.js";
import { greptileReviewService, type GreptileReviewService } from "./greptile.js";
import { recordObservedFindings } from "./findings.js";
import {
  deliveryReconciler,
  type DeliveryIssueStatusWriter,
  type DeliveryReconciler,
} from "./reconciler.js";
import { DELIVERY_MAX_MERGE_ATTEMPTS, deliveryMergeExecutor, type DeliveryMergeExecutor, type DeliveryMergeOutcome } from "./merge-executor.js";
import { deliveryReconciliationService, type DeliveryReconciliationService } from "./reconciliation.js";
import type { DeliveryControllerContext } from "./done-gate.js";

const DELIVERY_LIST_LIMIT = 500;

export type DeliverySubmitInput = {
  headSha: string;
  baseSha?: string | null;
  sourceBranch: string;
  artifactReady: boolean;
  coveredIssueIds?: string[];
  targetBranch?: string;
};


export interface DeliveryService {
  getSummary(companyId: string, issueId: string): Promise<DeliverySummary>;
  listSummaries(companyId: string, projectId?: string | null): Promise<DeliverySummary[]>;
  getUnitDetail(companyId: string, unitId: string): Promise<DeliveryUnitDetail>;
  submit(input: {
    companyId: string;
    issueId: string;
    actor: DeliveryActor;
    action: DeliverySubmitInput;
  }): Promise<DeliverySummary>;
  reconcileIssue(companyId: string, issueId: string): Promise<DeliverySummary>;
  retry(input: { companyId: string; issueId: string; actor: DeliveryActor }): Promise<DeliverySummary>;
  recordFeedback(input: {
    companyId: string;
    issueId: string;
    actor: DeliveryActor;
    findingId: string;
    disposition: "fixed" | "disputed" | "already_addressed";
    explanation: string;
  }): Promise<DeliverySummary>;
  recordDisposition(input: {
    companyId: string;
    issueId: string;
    actor: DeliveryActor;
    kind: "code" | "non_code";
    reasonCode: string;
    message: string;
    owner?: string | null;
    nextAction?: string | null;
  }): Promise<DeliverySummary>;
  setDependencies(input: {
    companyId: string;
    issueId: string;
    actor: DeliveryActor;
    needsArtifactIssueIds?: string[];
    mustMergeAfterIssueIds?: string[];
  }): Promise<DeliverySummary>;
  pause(input: { companyId: string; issueId: string; actor: DeliveryActor; reason?: string }): Promise<DeliverySummary>;
  resume(input: { companyId: string; issueId: string; actor: DeliveryActor }): Promise<DeliverySummary>;
  cancel(input: { companyId: string; issueId: string; actor: DeliveryActor; reason?: string }): Promise<DeliverySummary>;
  getPolicy(companyId: string, projectId: string): Promise<DeliveryPolicy | null>;
  putPolicy(input: {
    companyId: string;
    projectId: string;
    actorUserId: string | null;
    patch: PolicyWriteInput;
  }): Promise<DeliveryPolicy>;
  readReview(companyId: string, issueId: string): Promise<DeliveryReviewSummary>;
  inventory(input: { companyId: string; projectId?: string | null }): Promise<DeliveryReconciliationInventory>;
  recordReconciliation: DeliveryReconciliationService["record"];
  listReconciliations: DeliveryReconciliationService["list"];
  sweepCompany(input: { companyId: string }): Promise<{
    reconciled: number;
    merged: number;
    mergeOutcomes: DeliveryMergeOutcome[];
  }>;
  sweepAllCompanies(): Promise<{ companies: number; reconciled: number; merged: number }>;
  /** Late-wire the heartbeat wake dispatcher (built after delivery in app.ts). */
  setWakeDispatcher(dispatcher: DeliveryWakeEnqueue | undefined): void;
  services: {
    policy: DeliveryPolicyService;
    queue: DeliveryQueueService;
    events: DeliveryEventService;
    units: DeliveryUnitService;
    reconciler: DeliveryReconciler;
    merge: DeliveryMergeExecutor;
    reconciliation: DeliveryReconciliationService;
    greptile: GreptileReviewService;
    github: GitHubDeliveryClient;
  };
}

export function deliveryService(
  db: Db,
  deps: {
    toolGateway: Pick<ToolGatewayService, "readConnectedTool">;
    requestOwnerWake?: DeliveryWakeEnqueue;
  },
): DeliveryService {
  const github = createGitHubDeliveryClient(db);
  const events = deliveryEventService(db);
  const policy = deliveryPolicyService(db, { github });
  const queue = deliveryQueueService(db);
  let ownerWake: DeliveryWakeEnqueue | undefined = deps.requestOwnerWake;
  // Stable forwarder so the host can wire the heartbeat dispatcher after
  // construction (the heartbeat service is built after delivery in app.ts).
  // Unwired, wakes resolve null and stay queued as durable intent rows.
  const requestOwnerWake: DeliveryWakeEnqueue = (agentId, opts) =>
    ownerWake ? ownerWake(agentId, opts) : Promise.resolve(null);
  const units = deliveryUnitService(db, { policy, queue, events, github, requestOwnerWake });
  const greptile = greptileReviewService(db, { toolGateway: deps.toolGateway, github });
  const reconciliation = deliveryReconciliationService(db, {
    github,
    loadRepository: (companyId, repositoryId) => units.loadRepository(companyId, repositoryId),
  });

  const setIssueStatus: DeliveryIssueStatusWriter = async (input) => {
    const controller: DeliveryControllerContext = input.controller;
    await issueService(db).update(
      input.issueId,
      { status: input.status },
      db,
      undefined,
      undefined,
      { deliveryController: controller },
    );
  };

  const reconciler = deliveryReconciler(db, {
    policy, queue, events, units, github, greptile, setIssueStatus,
  });
  const merge = deliveryMergeExecutor(db, {
    policy, queue, events, units, github, greptile, reconciler, setIssueStatus,
  });
  async function loadIssue(companyId: string, issueId: string): Promise<DeliveryIssueRow> {
    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");
    return issue;
  }

  async function submit(input: {
    companyId: string;
    issueId: string;
    actor: DeliveryActor;
    action: DeliverySubmitInput;
  }) {
    const issue = await loadIssue(input.companyId, input.issueId);
    assertDeliveryMutable(issue);
    await units.registerCandidate({
      companyId: input.companyId,
      issue,
      actor: input.actor,
      headSha: input.action.headSha,
      baseSha: input.action.baseSha ?? null,
      sourceBranch: input.action.sourceBranch,
      targetBranch: input.action.targetBranch,
      artifactReady: input.action.artifactReady,
      coveredIssueIds: input.action.coveredIssueIds,
    });
    await reconciler.reconcileIssue({ companyId: input.companyId, issueId: input.issueId });
    return await units.buildSummary(input.companyId, input.issueId);
  }

  function assertDeliveryMutable(issue: DeliveryIssueRow) {
    if (issue.status === "done" || issue.status === "cancelled") {
      throw conflict("Completed or cancelled issues cannot receive a new delivery candidate", {
        issueStatus: issue.status,
      });
    }
  }

  async function reconcileIssue(companyId: string, issueId: string) {
    await loadIssue(companyId, issueId);
    await reconciler.reconcileIssue({ companyId, issueId });
    return await units.buildSummary(companyId, issueId);
  }

  async function retry(input: { companyId: string; issueId: string; actor: DeliveryActor }) {
    const unit = await units.findUnitForIssue(input.companyId, input.issueId);
    if (!unit) throw notFound("This issue has no delivery unit");
    // Bounded operator/agent retry: re-reconcile without resetting
    // mergeAttemptCount or the repair-attempt bound. Resetting counters on
    // retry would let an agent loop forever around the escalation bound.
    if (unit.mergeAttemptCount >= DELIVERY_MAX_MERGE_ATTEMPTS) {
      throw conflict("Merge attempts exhausted; operator action required", {
        reasonCode: "repair_attempts_exhausted",
        unitId: unit.id,
      });
    }
    await reconciler.reconcileIssue({ companyId: input.companyId, issueId: input.issueId, trigger: "retry" });
    return await units.buildSummary(input.companyId, input.issueId);
  }

  async function recordFeedback(input: {
    companyId: string;
    issueId: string;
    actor: DeliveryActor;
    findingId: string;
    disposition: "fixed" | "disputed" | "already_addressed";
    explanation: string;
  }) {
    const unit = await units.findUnitForIssue(input.companyId, input.issueId);
    if (!unit) throw notFound("This issue has no delivery unit");
    await units.recordFindingDisposition({
      companyId: input.companyId,
      unitId: unit.id,
      actor: input.actor,
      findingId: input.findingId,
      disposition: input.disposition,
      explanation: input.explanation,
    });
    // A disposition is not acceptance: re-reconcile so a disputed finding still
    // blocks until native review evidence clears it.
    await reconciler.reconcileIssue({ companyId: input.companyId, issueId: input.issueId });
    return await units.buildSummary(input.companyId, input.issueId);
  }

  async function recordDisposition(input: {
    companyId: string;
    issueId: string;
    actor: DeliveryActor;
    kind: "code" | "non_code";
    reasonCode: string;
    message: string;
    owner?: string | null;
    nextAction?: string | null;
  }) {
    const issue = await loadIssue(input.companyId, input.issueId);
    await units.recordDisposition({
      companyId: input.companyId,
      issue,
      actor: input.actor,
      kind: input.kind,
      reasonCode: input.reasonCode,
      message: input.message,
      owner: input.owner,
      nextAction: input.nextAction,
    });
    return await units.buildSummary(input.companyId, input.issueId);
  }

  async function setDependencies(input: {
    companyId: string;
    issueId: string;
    actor: DeliveryActor;
    needsArtifactIssueIds?: string[];
    mustMergeAfterIssueIds?: string[];
  }) {
    const unit = await units.findUnitForIssue(input.companyId, input.issueId);
    if (!unit) throw notFound("This issue has no delivery unit");
    await units.setDependencies({
      companyId: input.companyId,
      unitId: unit.id,
      actor: input.actor,
      needsArtifactIssueIds: input.needsArtifactIssueIds,
      mustMergeAfterIssueIds: input.mustMergeAfterIssueIds,
    });
    return await units.buildSummary(input.companyId, input.issueId);
  }

  async function pause(input: { companyId: string; issueId: string; actor: DeliveryActor; reason?: string }) {
    const unit = await units.findUnitForIssue(input.companyId, input.issueId);
    if (!unit) throw notFound("This issue has no delivery unit");
    await units.pauseUnit({ companyId: input.companyId, unitId: unit.id, actor: input.actor, reason: input.reason });
    return await units.buildSummary(input.companyId, input.issueId);
  }

  async function resume(input: { companyId: string; issueId: string; actor: DeliveryActor }) {
    const unit = await units.findUnitForIssue(input.companyId, input.issueId);
    if (!unit) throw notFound("This issue has no delivery unit");
    await units.resumeUnit({ companyId: input.companyId, unitId: unit.id, actor: input.actor });
    await reconciler.reconcileIssue({ companyId: input.companyId, issueId: input.issueId });
    return await units.buildSummary(input.companyId, input.issueId);
  }

  async function cancel(input: { companyId: string; issueId: string; actor: DeliveryActor; reason?: string }) {
    const unit = await units.findUnitForIssue(input.companyId, input.issueId);
    if (!unit) throw notFound("This issue has no delivery unit");
    await units.cancelUnit({ companyId: input.companyId, unitId: unit.id, actor: input.actor, reason: input.reason });
    return await units.buildSummary(input.companyId, input.issueId);
  }

  async function getPolicy(companyId: string, projectId: string) {
    return await policy.getForProject(companyId, projectId);
  }

  async function putPolicy(input: {
    companyId: string;
    projectId: string;
    actorUserId: string | null;
    patch: PolicyWriteInput;
  }) {
    return await policy.upsertPolicy(input);
  }

  async function listSummaries(companyId: string, projectId?: string | null) {
    const enrolledProjects = await db
      .select({ projectId: deliveryPolicies.projectId })
      .from(deliveryPolicies)
      .where(and(eq(deliveryPolicies.companyId, companyId), eq(deliveryPolicies.enabled, true)));
    const enrolledIds = enrolledProjects.map((row) => row.projectId);
    const candidates = await db
      .select({ issueId: issues.id })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        ne(issues.status, "cancelled"),
        ...(projectId ? [eq(issues.projectId, projectId)] : []),
        or(
          // Explicit enrollment only: a durable unit link (candidate or
          // covered-by handoff), an operator-classified delivery kind, or a
          // project whose delivery policy is enabled. A pull request that
          // merely mentions or links the issue is not a delivery candidate and
          // never enrolls it.
          sql`exists (select 1 from ${deliveryUnitIssues} dui where dui.issue_id = ${issues.id})`,
          sql`${issues.deliveryKind} is not null`,
          enrolledIds.length > 0 ? inArray(issues.projectId, enrolledIds) : sql`false`,
        ),
      ))
      .orderBy(desc(issues.updatedAt))
      .limit(DELIVERY_LIST_LIMIT);
    const summaries: DeliverySummary[] = [];
    for (const candidate of candidates) {
      summaries.push(await units.buildSummary(companyId, candidate.issueId));
    }
    return summaries;
  }

  async function readReview(companyId: string, issueId: string): Promise<DeliveryReviewSummary> {
    const unit = await units.findUnitForIssue(companyId, issueId);
    if (!unit) {
      return {
        issueId,
        repository: null,
        targetBranch: null,
        prNumber: null,
        headSha: null,
        reviewedHeadSha: null,
        status: "none",
        blockingFindings: 0,
        findings: [],
        nextAction: "Submit a delivery candidate first.",
        fetchedAt: null,
      };
    }
    const repository = await units.loadRepository(companyId, unit.repositoryId);
    const policyRow = await policy.getRowForIssueProject(companyId, unit.projectId);
    const findings = await units.listFindings(companyId, unit.id);
    const unavailable = (nextAction: string): DeliveryReviewSummary => ({
      issueId,
      repository: repository ? `${repository.owner}/${repository.name}` : null,
      targetBranch: unit.targetBranch,
      prNumber: unit.prNumber,
      headSha: unit.headSha,
      reviewedHeadSha: readUnitMetadata(unit.metadata).greptileReviewedHeadSha ?? null,
      status: "unavailable",
      blockingFindings: findings.filter((finding) => finding.state === "open").length,
      findings,
      nextAction,
      fetchedAt: null,
    });
    if (!policyRow?.greptileConnectionId) {
      return unavailable("Connect Greptile and set greptileConnectionId on the delivery policy.");
    }
    if (!repository || !unit.prNumber) {
      return unavailable("Open a pull request before reading Greptile feedback.");
    }
    if (!unit.headSha) {
      return unavailable("Wait for the pull request head to synchronize before reading Greptile feedback.");
    }
    const result = await greptile.read({
      companyId,
      connectionId: policyRow.greptileConnectionId,
      repositoryName: `${repository.owner}/${repository.name}`,
      defaultBranch: unit.targetBranch,
      prNumber: unit.prNumber,
      correlation: {
        host: repository.host,
        connectionId: policyRow.githubConnectionId,
        owner: repository.owner,
        repo: repository.name,
        headSha: unit.headSha,
      },
    });
    if (!result.ok) {
      return {
        issueId,
        repository: `${repository.owner}/${repository.name}`,
        targetBranch: unit.targetBranch,
        prNumber: unit.prNumber,
        headSha: unit.headSha,
        reviewedHeadSha: readUnitMetadata(unit.metadata).greptileReviewedHeadSha ?? null,
        status: "unavailable",
        blockingFindings: findings.filter((finding) => finding.state === "open").length,
        findings,
        nextAction: result.message,
        fetchedAt: new Date().toISOString(),
      };
    }
    // A successful read is durable evidence: persist what the provider actually
    // reported, on the revision it actually reviewed, before any requirement is
    // judged.
    await recordObservedFindings(db, {
      companyId,
      unitId: unit.id,
      candidateGeneration: unit.candidateGeneration,
      headSha: result.headSha,
      findings: result.findings,
    });
    const persisted = await units.listFindings(companyId, unit.id);
    return {
      issueId,
      repository: `${repository.owner}/${repository.name}`,
      targetBranch: unit.targetBranch,
      prNumber: unit.prNumber,
      headSha: unit.headSha,
      reviewedHeadSha: result.headSha,
      status: result.status,
      blockingFindings: result.blockingFindings,
      findings: persisted,
      nextAction: result.status === "pending"
        ? "Wait for Greptile to finish reviewing the current head, then refresh."
        : result.blockingFindings > 0
          ? "Resolve or disposition the blocking findings."
          : null,
      fetchedAt: new Date().toISOString(),
    };
  }

  async function sweepCompany(input: { companyId: string }) {
    const reconciled = await reconciler.reconcileCompany({ companyId: input.companyId });
    const mergeOutcomes = await merge.sweepCompany({
      companyId: input.companyId,
      leaseOwner: `delivery-${process.pid}-${Date.now()}`,
    });
    const mergedFromMerge = mergeOutcomes.filter((outcome) => outcome.merged).length;
    return { reconciled: reconciled.reconciled, merged: reconciled.merged + mergedFromMerge, mergeOutcomes };
  }

  async function sweepAllCompanies() {
    const rows = await db
      .select({ companyId: deliveryUnits.companyId })
      .from(deliveryUnits)
      .where(inArray(deliveryUnits.status, ["submitted", "in_review", "ready_to_merge", "merging", "blocked", "closed_unmerged"]));
    const companyIds = [...new Set(rows.map((row) => row.companyId))];
    let reconciled = 0;
    let merged = 0;
    for (const companyId of companyIds) {
      const result = await sweepCompany({ companyId });
      reconciled += result.reconciled;
      merged += result.merged;
    }
    return { companies: companyIds.length, reconciled, merged };
  }

  return {
    getSummary: (companyId, issueId) => units.buildSummary(companyId, issueId),
    listSummaries,
    getUnitDetail: (companyId, unitId) => units.buildUnitDetail(companyId, unitId),
    submit,
    reconcileIssue,
    retry,
    recordFeedback,
    recordDisposition,
    setDependencies,
    pause,
    resume,
    cancel,
    getPolicy,
    putPolicy,
    readReview,
    inventory: reconciliation.inventory,
    recordReconciliation: reconciliation.record,
    listReconciliations: reconciliation.list,
    sweepCompany,
    sweepAllCompanies,
    setWakeDispatcher(dispatcher: DeliveryWakeEnqueue | undefined) {
      ownerWake = dispatcher;
    },
    services: { policy, queue, events, units, reconciler, merge, reconciliation, greptile, github },
  };
}

