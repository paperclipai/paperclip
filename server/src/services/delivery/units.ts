import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  deliveryDependencies,
  deliveryFindings,
  deliveryReceipts,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  issues,
  type Db,
} from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import type {
  DeliveryBlocker,
  DeliveryCheck,
  DeliveryDisposition,
  DeliveryFinding,
  DeliveryNativeReviewEvidence,
  DeliveryPhase,
  DeliveryProvenance,
  DeliverySummary,
  DeliveryUnitDetail,
} from "@paperclipai/shared";
import type { DeliveryEventService } from "./events.js";
import type { DeliveryPolicyService, DeliveryPolicyRow } from "./policy.js";
import type { DeliveryQueueService } from "./queue.js";
import type { GitHubDeliveryClient } from "./github-client.js";
import { repositoryFullName } from "./policy.js";
import { createDeliveryDoneGate } from "./done-gate.js";

export type DeliveryIssueRow = typeof issues.$inferSelect;
export type DeliveryUnitRow = typeof deliveryUnits.$inferSelect;
export type DeliveryReceiptRow = typeof deliveryReceipts.$inferSelect;
export type DeliveryFindingRow = typeof deliveryFindings.$inferSelect;
export type DeliveryRepositoryRow = typeof deliveryRepositories.$inferSelect;

export type DeliveryActor = {
  type: "user" | "agent" | "system";
  id: string;
  agentId?: string | null;
  userId?: string | null;
};

/**
 * Narrow heartbeat enqueue callback injected by the host (heartbeat
 * `wakeup`). Delivery never imports the heartbeat service: without a wired
 * dispatcher the durable intent row is still recorded, but no run is queued.
 */
export type DeliveryWakeEnqueue = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    /**
     * Controller-owned context the run must carry (for example the exact
     * `deliveryRepair` identity). Forwarded verbatim to the heartbeat
     * dispatcher; never derived from worker-authored text.
     */
    contextSnapshot?: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "system";
    requestedByActorId: "delivery-controller";
  },
) => Promise<unknown>;

export type DeliveryUnitMetadata = {
  checks?: DeliveryCheck[];
  reviewStatus?: string;
  reviewHeadSha?: string | null;
  blockingFindings?: number;
  blockedPhase?: DeliveryPhase;
  artifactRoot?: string | null;
  greptileFetchedAt?: string | null;
  /** Latest governed Greptile review state (`completed` | `pending`). */
  greptileReviewState?: "completed" | "pending";
  /**
   * Candidate generation the cached display evidence (`checks`,
   * `reviewStatus`, `reviewHeadSha`, `blockingFindings`, `checksHeadSha`) was
   * read at. Evidence from an older generation is history: it is retained for
   * the timeline but never presented as the current candidate's review.
   */
  evidenceGeneration?: number;
  /** Head the cached checks were read for; null when never read. */
  checksHeadSha?: string | null;
  /**
   * The most recent authoritative evidence read for the current generation
   * failed. Cached display evidence must then present as unknown, never as a
   * pass, until a fresh read succeeds.
   */
  lastReadFailed?: boolean;
  /** Revision Greptile's findings were correlated to, never a candidate guess. */
  greptileReviewedHeadSha?: string | null;
  /** Findings the provider reports across the pull request. */
  greptileProviderFindings?: number;
  lastRemoteUpdatedAt?: string | null;
  submittedHeadSha?: string;
  authorLogin?: string | null;
  /** Latest-state approvals with the commit each reviewer approved. */
  approvals?: Array<{ login: string; commitSha: string | null }>;
  /**
   * Last actionable repair signal per reason code. Reconciliation polls, so a
   * repeated signal for unchanged evidence must not spend another attempt.
   */
  lastRepairSignal?: Record<string, string>;
  /**
   * Verified native independent review of the head under evaluation, when the
   * policy's review regime is a native agent review. It names the reviewer, the
   * reviewer's model and the exact reviewed revision.
   */
  nativeReview?: DeliveryNativeReviewEvidence | null;
};

const TERMINAL_UNIT_STATUSES = ["merged", "cancelled", "closed_unmerged"] as const;

/**
 * Unit statuses that still describe a live candidate. The complement of
 * {@link TERMINAL_UNIT_STATUSES}: a write that may only apply to a live
 * candidate carries this set as an atomic predicate so a unit that became
 * terminal mid-flight is never resurrected.
 */
const OPEN_UNIT_STATUSES = ["submitted", "in_review", "ready_to_merge", "merging", "blocked"] as const;

export function readUnitMetadata(value: unknown): DeliveryUnitMetadata {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as DeliveryUnitMetadata)
    : {};
}

export function deriveDeliveryPhase(unit: DeliveryUnitRow | null): DeliveryPhase {
  if (!unit) return "not_started";
  const metadata = readUnitMetadata(unit.metadata);
  switch (unit.status) {
    case "merged":
      return "done";
    case "merging":
      return "merging";
    case "ready_to_merge":
      return "ready_to_merge";
    case "blocked":
      return metadata.blockedPhase ?? (unit.acceptedHeadSha ? "ready_to_merge" : "in_review");
    case "cancelled":
    case "closed_unmerged":
      return unit.artifactReady ? "in_review" : "not_started";
    case "submitted":
    case "in_review":
    default:
      return "in_review";
  }
}

export interface DeliveryUnitService {
  getUnit(companyId: string, unitId: string): Promise<DeliveryUnitRow | null>;
  findUnitForIssue(companyId: string, issueId: string): Promise<DeliveryUnitRow | null>;
  listUnitsForIssue(companyId: string, issueId: string): Promise<DeliveryUnitRow[]>;
  getReceipt(companyId: string, unitId: string): Promise<DeliveryReceiptRow | null>;
  loadRepository(companyId: string, repositoryId: string | null): Promise<DeliveryRepositoryRow | null>;
  classifyCodeDelivery(companyId: string, issue: DeliveryIssueRow): Promise<boolean>;
  buildSummary(companyId: string, issueId: string): Promise<DeliverySummary>;
  buildUnitDetail(companyId: string, unitId: string): Promise<DeliveryUnitDetail>;
  registerCandidate(input: RegisterCandidateInput): Promise<{ unit: DeliveryUnitRow; created: boolean }>;
  setDependencies(input: {
    companyId: string;
    unitId: string;
    actor: DeliveryActor;
    needsArtifactIssueIds?: string[];
    mustMergeAfterIssueIds?: string[];
  }): Promise<void>;
  recordDisposition(input: {
    companyId: string;
    issue: DeliveryIssueRow;
    actor: DeliveryActor;
    kind: "code" | "non_code";
    reasonCode: string;
    message: string;
    owner?: string | null;
    nextAction?: string | null;
  }): Promise<void>;
  recordFindingDisposition(input: {
    companyId: string;
    unitId: string;
    actor: DeliveryActor;
    findingId: string;
    disposition: "fixed" | "disputed" | "already_addressed";
    explanation: string;
  }): Promise<DeliveryFindingRow>;
  listFindings(companyId: string, unitId: string): Promise<DeliveryFinding[]>;
  dispatchOwnerWake(input: {
    companyId: string;
    agentId: string;
    reason: string;
    payload: Record<string, unknown>;
    contextSnapshot?: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ intentId: string | null; dispatched: boolean }>;
  pauseUnit(input: { companyId: string; unitId: string; actor: DeliveryActor; reason?: string }): Promise<DeliveryUnitRow>;
  notifyArtifactDependents(companyId: string, unit: DeliveryUnitRow): Promise<void>;
  resumeUnit(input: { companyId: string; unitId: string; actor: DeliveryActor }): Promise<DeliveryUnitRow>;
  cancelUnit(input: { companyId: string; unitId: string; actor: DeliveryActor; reason?: string }): Promise<DeliveryUnitRow>;
  markBlocked(input: {
    companyId: string;
    unitId: string;
    blocker: DeliveryBlocker;
    nextAction?: string | null;
    /** Read generation fence; a stale write is dropped. */
    candidateGeneration?: number | null;
  }): Promise<boolean>;
  clearBlocker(companyId: string, unitId: string, candidateGeneration?: number | null): Promise<void>;
  setUnitStatus(input: {
    companyId: string;
    unitId: string;
    status: DeliveryUnitRow["status"];
    nextAction?: string | null;
    candidateGeneration?: number | null;
  }): Promise<DeliveryUnitRow | null>;
}

export type RegisterCandidateInput = {
  companyId: string;
  issue: DeliveryIssueRow;
  actor: DeliveryActor;
  headSha: string;
  baseSha?: string | null;
  sourceBranch: string;
  targetBranch?: string;
  artifactReady: boolean;
  coveredIssueIds?: string[];
  prNumberHint?: number | null;
  artifactRoot?: string | null;
};

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function normalizeSha(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return GIT_SHA_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

function blockerToMetadataPhase(unit: DeliveryUnitRow, metadata: DeliveryUnitMetadata): DeliveryUnitMetadata {
  if (metadata.blockedPhase) return metadata;
  return { ...metadata, blockedPhase: deriveDeliveryPhase({ ...unit, status: "in_review" }) };
}

export function deliveryUnitService(
  db: Db,
  deps: {
    policy: DeliveryPolicyService;
    queue: DeliveryQueueService;
    events: DeliveryEventService;
    github: GitHubDeliveryClient;
    requestOwnerWake?: DeliveryWakeEnqueue;
  },
): DeliveryUnitService {
  const { policy, queue, events, github } = deps;

  /**
   * Real owner feedback: the durable intent row is recorded first (idempotent
   * per key), then the injected heartbeat dispatcher queues an actual run.
   * Without a dispatcher the row stays queued and the repair loop still
   * escalates on the bound — a bare row is never mistaken for dispatch.
   */
  async function dispatchOwnerWake(input: {
    companyId: string;
    agentId: string;
    reason: string;
    payload: Record<string, unknown>;
    contextSnapshot?: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ intentId: string | null; dispatched: boolean }> {
    const [existing] = await db
      .select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);
    if (existing) return { intentId: existing.id, dispatched: existing.runId != null || existing.status === "coalesced" };
    const [intent] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: input.reason,
        payload: {
          ...input.payload,
          _paperclipWakeContext: {
            ...((input.payload._paperclipWakeContext as Record<string, unknown> | undefined) ?? {}),
            wakeReason: input.reason,
            source: "delivery_controller",
          },
        },
        requestedByActorType: "system",
        requestedByActorId: "delivery-controller",
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning({ id: agentWakeupRequests.id });
    const intentId = intent?.id ?? null;
    if (!intentId || !deps.requestOwnerWake) return { intentId, dispatched: false };
    try {
      const run = await deps.requestOwnerWake(input.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: input.reason,
        payload: input.payload,
        ...(input.contextSnapshot ? { contextSnapshot: input.contextSnapshot } : {}),
        idempotencyKey: input.idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: "delivery-controller",
      }) as { id?: string } | null;
      await db
        .update(agentWakeupRequests)
        .set({
          status: run?.id ? "coalesced" : "queued",
          runId: run?.id ?? null,
          error: run?.id ? null : "Heartbeat dispatcher queued no run; intent remains for the next sweep",
          updatedAt: new Date(),
        })
        .where(eq(agentWakeupRequests.id, intentId));
      return { intentId, dispatched: Boolean(run?.id) };
    } catch (error) {
      await db
        .update(agentWakeupRequests)
        .set({
          error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(eq(agentWakeupRequests.id, intentId));
      return { intentId, dispatched: false };
    }
  }

  async function getUnit(companyId: string, unitId: string) {
    return await db
      .select()
      .from(deliveryUnits)
      .where(and(eq(deliveryUnits.companyId, companyId), eq(deliveryUnits.id, unitId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function loadRepository(companyId: string, repositoryId: string | null) {
    if (!repositoryId) return null;
    return await db
      .select()
      .from(deliveryRepositories)
      .where(and(eq(deliveryRepositories.companyId, companyId), eq(deliveryRepositories.id, repositoryId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function listUnitsForIssue(companyId: string, issueId: string) {
    return await db
      .select({ unit: deliveryUnits })
      .from(deliveryUnitIssues)
      .innerJoin(deliveryUnits, eq(deliveryUnits.id, deliveryUnitIssues.unitId))
      .where(and(eq(deliveryUnitIssues.companyId, companyId), eq(deliveryUnitIssues.issueId, issueId)))
      .orderBy(desc(deliveryUnits.createdAt))
      .then((rows) => rows.map((row) => row.unit));
  }

  /**
   * The active unit for an issue: the newest unit that is still open, else the
   * newest terminal unit (so a merged receipt remains visible).
   */
  async function findUnitForIssue(companyId: string, issueId: string) {
    const units = await listUnitsForIssue(companyId, issueId);
    if (units.length === 0) return null;
    return units.find((unit) => !TERMINAL_UNIT_STATUSES.includes(unit.status as never)) ?? units[0]!;
  }

  async function getReceipt(companyId: string, unitId: string) {
    return await db
      .select()
      .from(deliveryReceipts)
      .where(and(eq(deliveryReceipts.companyId, companyId), eq(deliveryReceipts.unitId, unitId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Display and completion must agree, including projects awaiting enrollment.
  const { classifyCodeDelivery } = createDeliveryDoneGate(db);

  async function listFindings(companyId: string, unitId: string): Promise<DeliveryFinding[]> {
    const rows = await db
      .select()
      .from(deliveryFindings)
      .where(and(eq(deliveryFindings.companyId, companyId), eq(deliveryFindings.unitId, unitId)))
      .orderBy(desc(deliveryFindings.lastSeenAt));
    return rows.map((row) => ({
      id: row.id,
      externalId: row.externalId,
      severity: row.severity,
      title: row.title,
      body: row.body,
      filePath: row.filePath,
      line: row.line,
      url: row.url,
      headSha: row.headSha,
      candidateGeneration: row.candidateGeneration,
      state: row.state,
      disposition: row.disposition,
      dispositionExplanation: row.dispositionExplanation,
      dispositionAt: row.dispositionAt?.toISOString() ?? null,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
  }

  function toProvenance(receipt: DeliveryReceiptRow): DeliveryProvenance {
    return receipt.provenance;
  }

  async function buildSummary(companyId: string, issueId: string): Promise<DeliverySummary> {
    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const codeDelivery = await classifyCodeDelivery(companyId, issue);
    const unit = await findUnitForIssue(companyId, issueId);
    const policyRow = await policy.getRowForIssueProject(companyId, issue.projectId);
    if (!unit) {
      const eventsForIssue = await events.listForIssue(companyId, issueId);
      const blocker = await blockerForUnstarted(companyId, issue, policyRow);
      return {
        issueId,
        codeDelivery,
        artifactReady: false,
        paused: Boolean(policyRow?.paused),
        phase: "not_started",
        repository: policyRow ? await repositoryName(companyId, policyRow.repositoryId) : null,
        targetBranch: policyRow?.targetBranch ?? null,
        unitId: null,
        prUrl: null,
        prNumber: null,
        headSha: null,
        candidateGeneration: null,
        mergedSha: null,
        ownerAgentId: issue.assigneeAgentId ?? null,
        queuePosition: null,
        checks: [],
        review: { status: "none", headSha: null, blockingFindings: 0, candidateGeneration: null },
        blocker,
        nextAction: blocker?.nextAction ?? (codeDelivery ? "Publish a candidate revision for this issue." : null),
        lastEventAt: eventsForIssue.at(-1)?.createdAt ?? null,
        events: eventsForIssue,
      };
    }

    const repository = await loadRepository(companyId, unit.repositoryId);
    const metadata = readUnitMetadata(unit.metadata);
    const receipt = await getReceipt(companyId, unit.id);
    const queueEntry = await queue.getEntry(companyId, unit.id);
    const queuePosition = queueEntry ? await queue.position({ companyId, unitId: unit.id }) : null;
    const unitEvents = await events.list(companyId, unit.id);
    // Only findings reported for this unit's current candidate generation and
    // current head count as unresolved evidence. Older findings stay as history
    // in `listFindings` but never block or explain the current candidate. A
    // `disputed` finding is unresolved too: a human dispute still blocks, so it
    // is counted here exactly as the reconciler counts it.
    const unresolvedFindings = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryFindings)
      .where(and(
        eq(deliveryFindings.companyId, companyId),
        eq(deliveryFindings.unitId, unit.id),
        eq(deliveryFindings.candidateGeneration, unit.candidateGeneration),
        unit.headSha != null ? eq(deliveryFindings.headSha, unit.headSha) : sql`true`,
        inArray(deliveryFindings.state, ["open", "disputed"]),
      ))
      .then((rows) => rows[0]?.count ?? 0);
    const phase = deriveDeliveryPhase(unit);
    const blocker = unit.blocker ?? null;
    // Display evidence is fenced by the generation it was read at and by the
    // head it was read for. A cached pass for an older generation, or a failed
    // read of the current generation, presents as unknown — never as a pass.
    const evidenceGeneration = metadata.evidenceGeneration ?? null;
    const evidenceFresh = evidenceGeneration != null && evidenceGeneration === unit.candidateGeneration;
    const readFailed = evidenceFresh && metadata.lastReadFailed === true;
    const reviewHeadSha = evidenceFresh ? metadata.reviewHeadSha ?? null : null;
    const reviewCurrent = !readFailed && reviewHeadSha !== null && reviewHeadSha === unit.headSha;
    const checksCurrent = !readFailed
      && evidenceFresh
      && metadata.checksHeadSha != null
      && metadata.checksHeadSha === unit.headSha;
    const reviewUnknown = unit.headSha != null && !reviewCurrent;
    return {
      issueId,
      codeDelivery,
      // Reviewed artifact readiness: the worker boolean counts only while the
      // exact head stands accepted on fresh evidence. A bare submit flag never
      // presents as accepted and never wakes dependents.
      artifactReady: unit.artifactReady && unit.acceptedHeadSha != null && unit.acceptedHeadSha === unit.headSha,
      paused: Boolean(policyRow?.paused) || unit.pausedAt != null,
      phase,
      repository: repository ? repositoryFullName(repository.owner, repository.name) : null,
      targetBranch: unit.targetBranch,
      unitId: unit.id,
      candidateGeneration: unit.candidateGeneration,
      prUrl: unit.prUrl,
      prNumber: unit.prNumber,
      headSha: unit.headSha,
      mergedSha: unit.mergedSha ?? receipt?.mergedSha ?? null,
      ownerAgentId: unit.ownerAgentId ?? issue.assigneeAgentId ?? null,
      queuePosition,
      checks: checksCurrent ? metadata.checks ?? [] : [],
      review: {
        status: reviewCurrent ? metadata.reviewStatus ?? "none" : reviewUnknown ? "unknown" : "none",
        headSha: reviewCurrent ? reviewHeadSha : null,
        blockingFindings: Math.max(unresolvedFindings, reviewCurrent ? metadata.blockingFindings ?? 0 : 0),
        candidateGeneration: reviewCurrent ? unit.candidateGeneration : null,
        // A native review is presented only for the head it names: it is
        // evidence about one exact revision and never about a later one.
        nativeReview: metadata.nativeReview && metadata.nativeReview.revision === reviewHeadSha
          ? metadata.nativeReview
          : null,
      },
      blocker,
      nextAction: unit.nextAction ?? blocker?.nextAction ?? defaultNextAction(phase),
      lastEventAt: unitEvents.at(-1)?.createdAt ?? unit.lastEventAt?.toISOString() ?? null,
      events: unitEvents,
    };
  }

  async function repositoryName(companyId: string, repositoryId: string | null) {
    const repository = await loadRepository(companyId, repositoryId);
    return repository ? repositoryFullName(repository.owner, repository.name) : null;
  }

  async function blockerForUnstarted(
    companyId: string,
    issue: DeliveryIssueRow,
    policyRow: DeliveryPolicyRow | null,
  ): Promise<DeliveryBlocker | null> {
    const codeDelivery = await classifyCodeDelivery(companyId, issue);
    if (!codeDelivery) return null;
    if (issue.deliveryKind === "non_code" && issue.deliveryDisposition) return null;
    if (!policyRow) {
      return {
        reasonCode: "policy_missing",
        message: "Project has no delivery policy",
        owner: null,
        nextAction: "Configure a delivery policy for this project.",
      };
    }
    if (!policyRow.repositoryId) {
      return {
        reasonCode: "repository_unverified",
        message: "Project has no verified GitHub repository",
        owner: null,
        nextAction: "Set the project repository and re-save the policy.",
      };
    }
    if (!policyRow.enabled) {
      return {
        reasonCode: "policy_disabled",
        message: "Delivery is not enabled for this project",
        owner: null,
        nextAction: "Enable the delivery policy.",
      };
    }
    if (policyRow.paused) {
      return {
        reasonCode: "policy_paused",
        message: "Delivery is paused for this project",
        owner: null,
        nextAction: "Resume the delivery policy.",
      };
    }
    return {
      reasonCode: "candidate_required",
      message: "No delivery candidate has been submitted for this issue",
      owner: issue.assigneeAgentId ?? null,
      nextAction: "Publish or submit the reviewed candidate revision.",
    };
  }

  function defaultNextAction(phase: DeliveryPhase) {
    switch (phase) {
      case "not_started":
        return "Publish or submit the reviewed candidate revision.";
      case "in_review":
        return "Wait for required checks and review evidence on the accepted revision.";
      case "ready_to_merge":
        return "Merge is queued under the repository delivery policy.";
      case "merging":
        return "Await the remote merge result.";
      case "done":
        return null;
      default:
        return null;
    }
  }

  async function buildUnitDetail(companyId: string, unitId: string): Promise<DeliveryUnitDetail> {
    const unit = await getUnit(companyId, unitId);
    if (!unit) throw notFound("Delivery unit not found");
    const repository = await loadRepository(companyId, unit.repositoryId);
    const covered = await db
      .select({ issueId: deliveryUnitIssues.issueId, role: deliveryUnitIssues.role })
      .from(deliveryUnitIssues)
      .where(and(eq(deliveryUnitIssues.companyId, companyId), eq(deliveryUnitIssues.unitId, unitId)));
    const dependencies = await db
      .select({
        kind: deliveryDependencies.kind,
        unitId: deliveryDependencies.dependsOnUnitId,
        status: deliveryUnits.status,
        artifactReady: deliveryUnits.artifactReady,
        primaryIssueId: deliveryUnits.primaryIssueId,
      })
      .from(deliveryDependencies)
      .innerJoin(deliveryUnits, eq(deliveryUnits.id, deliveryDependencies.dependsOnUnitId))
      .where(and(eq(deliveryDependencies.companyId, companyId), eq(deliveryDependencies.unitId, unitId)));
    const queueEntry = await queue.getEntry(companyId, unitId);
    const queuePosition = queueEntry ? await queue.position({ companyId, unitId }) : null;
    const receipt = await getReceipt(companyId, unitId);
    return {
      unitId: unit.id,
      companyId: unit.companyId,
      projectId: unit.projectId,
      issueId: unit.primaryIssueId,
      coveredIssueIds: covered.map((row) => row.issueId),
      status: unit.status,
      candidateGeneration: unit.candidateGeneration,
      repository: repository ? repositoryFullName(repository.owner, repository.name) : "",
      targetBranch: unit.targetBranch,
      sourceBranch: unit.sourceBranch,
      baseSha: unit.baseSha,
      headSha: unit.headSha,
      acceptedHeadSha: unit.acceptedHeadSha,
      mergedSha: unit.mergedSha,
      prNumber: unit.prNumber,
      prUrl: unit.prUrl,
      mergeMethod: unit.mergeMethod,
      ownerAgentId: unit.ownerAgentId,
      artifactReady: unit.artifactReady,
      queue: queueEntry && queuePosition !== null
        ? queue.toQueueEntry(queueEntry, unit.primaryIssueId, repository ? repositoryFullName(repository.owner, repository.name) : "", queuePosition)
        : null,
      provenance: receipt ? toProvenance(receipt) : null,
      dependencies: dependencies.map((row) => ({
        kind: row.kind,
        unitId: row.unitId,
        issueId: row.primaryIssueId,
        satisfied: row.kind === "needs_artifact" ? row.artifactReady : row.status === "merged" || row.status === "cancelled",
      })),
      createdAt: unit.createdAt.toISOString(),
      updatedAt: unit.updatedAt.toISOString(),
    };
  }

  async function assertCoveredIssuesInScope(input: {
    companyId: string;
    projectId: string | null;
    repositoryId: string;
    coveredIssueIds: string[];
    primaryIssueId: string;
    actor: DeliveryActor;
  }) {
    const unique = [...new Set(input.coveredIssueIds)].filter((id) => id !== input.primaryIssueId);
    if (unique.length === 0) return [];
    const rows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, unique)));
    if (rows.length !== unique.length) {
      throw unprocessable("Covered issues must belong to the same company", {
        missingIssueIds: unique.filter((id) => !rows.some((row) => row.id === id)),
      });
    }
    for (const row of rows) {
      // An agent may only cover issues assigned to itself; a board operator or
      // the controller may cover any same-company issue. Without this an agent
      // could attach another owner's work to its unit.
      if (input.actor.type === "agent" && row.assigneeAgentId !== input.actor.agentId) {
        throw forbidden("Covered issue is not assigned to the submitting agent", { issueId: row.id });
      }
      const rowPolicy = await policy.getRowForIssueProject(input.companyId, row.projectId);
      if (rowPolicy?.repositoryId && rowPolicy.repositoryId !== input.repositoryId) {
        throw unprocessable("Covered issue belongs to a different repository", {
          issueId: row.id,
          repositoryId: rowPolicy.repositoryId,
        });
      }
      const otherUnits = await db
        .select({ unitId: deliveryUnitIssues.unitId, status: deliveryUnits.status })
        .from(deliveryUnitIssues)
        .innerJoin(deliveryUnits, eq(deliveryUnits.id, deliveryUnitIssues.unitId))
        .where(and(eq(deliveryUnitIssues.companyId, input.companyId), eq(deliveryUnitIssues.issueId, row.id)));
      const conflicting = otherUnits.find((unit) => !TERMINAL_UNIT_STATUSES.includes(unit.status as never));
      if (conflicting) {
        throw conflict("Covered issue already belongs to an open delivery unit", {
          issueId: row.id,
          unitId: conflicting.unitId,
        });
      }
    }
    return unique;
  }

  async function registerCandidate(input: RegisterCandidateInput) {
    const headSha = normalizeSha(input.headSha);
    if (!headSha) throw unprocessable("headSha must be an exact 40-hex git revision");
    if (input.baseSha != null && !normalizeSha(input.baseSha)) {
      throw unprocessable("baseSha must be an exact 40-hex git revision");
    }
    const baseSha = normalizeSha(input.baseSha ?? null);
    const sourceBranch = input.sourceBranch.trim();
    if (!sourceBranch) throw unprocessable("sourceBranch is required");

    const policyRow = await policy.getRowForIssueProject(input.companyId, input.issue.projectId);
    if (!policyRow) {
      throw unprocessable("Project has no delivery policy; configure one before submitting a candidate");
    }
    if (!policyRow.repositoryId) {
      throw unprocessable("Delivery policy has no verified repository");
    }
    const repository = await loadRepository(input.companyId, policyRow.repositoryId);
    if (!repository) throw unprocessable("Delivery policy repository is missing");
    const targetBranch = input.targetBranch?.trim() || policyRow.targetBranch;
    if (targetBranch !== policyRow.targetBranch) {
      throw unprocessable(`Delivery policy targets ${policyRow.targetBranch}, not ${targetBranch}`);
    }
    const covered = await assertCoveredIssuesInScope({
      companyId: input.companyId,
      projectId: input.issue.projectId,
      repositoryId: repository.id,
      coveredIssueIds: input.coveredIssueIds ?? [],
      primaryIssueId: input.issue.id,
      actor: input.actor,
    });

    // Verify before changing any durable candidate or coverage state.
    const pullRequest = await bindAuthoritativePullRequest(
      input.companyId,
      policyRow.githubConnectionId,
      repository,
      { sourceBranch, targetBranch },
      input.prNumberHint ?? null,
      headSha,
    );

    const existing = await db
      .select()
      .from(deliveryUnits)
      .where(and(
        eq(deliveryUnits.companyId, input.companyId),
        eq(deliveryUnits.primaryIssueId, input.issue.id),
        ne(deliveryUnits.status, "merged"),
        ne(deliveryUnits.status, "cancelled"),
        ne(deliveryUnits.status, "closed_unmerged"),
      ))
      .orderBy(desc(deliveryUnits.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const now = new Date();
    const ownerAgentId = input.issue.assigneeAgentId ?? input.actor.agentId ?? null;
    // Material candidate identity: the reviewed revision, the pull request it
    // is published on, the source/target branch pair, and the repository the
    // unit delivers into. Submission on the same pull request always counts,
    // because re-registering a candidate is itself a new review cycle.
    const materialChanges: string[] = [];
    if (existing) {
      if (existing.headSha !== headSha) materialChanges.push("head");
      if (existing.prNumber !== pullRequest.number) materialChanges.push("pullRequest");
      if (existing.sourceBranch !== sourceBranch) materialChanges.push("sourceBranch");
      if (existing.targetBranch !== targetBranch) materialChanges.push("targetBranch");
      if (existing.repositoryId !== repository.id) materialChanges.push("repository");
    }
    const identityChanged = materialChanges.length > 0;
    const headChanged = existing?.headSha != null && existing.headSha !== headSha;
    const metadata = { ...readUnitMetadata(existing?.metadata) };
    if (identityChanged) {
      // Evidence belongs to the candidate it was read for. The generation
      // increment below makes any in-flight write for the previous candidate
      // stale; the display state is reset with it so nothing is inherited.
      metadata.checks = [];
      metadata.reviewStatus = "none";
      metadata.reviewHeadSha = null;
      metadata.checksHeadSha = null;
      metadata.blockingFindings = 0;
      metadata.lastReadFailed = false;
      delete metadata.blockedPhase;
    }
    if (input.artifactRoot !== undefined) metadata.artifactRoot = input.artifactRoot;
    if (!metadata.submittedHeadSha || identityChanged) metadata.submittedHeadSha = headSha;

    const basePatch = {
      // Submission records the candidate head only. `acceptedHeadSha` is set by
      headSha,
      acceptedHeadSha: null,
      baseSha: pullRequest.baseSha ?? baseSha ?? existing?.baseSha ?? null,
      sourceBranch,
      targetBranch,
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
      artifactReady: input.artifactReady,
      mergeMethod: policyRow.mergeMethod,
      ownerAgentId,
      projectId: input.issue.projectId,
      // Every submission returns the unit to pending acceptance. Readiness is
      // re-derived by the reconciler from fresh evidence, never inherited.
      status: "in_review" as DeliveryUnitRow["status"],
      blocker: null,
      nextAction: null,
      nextActionAt: null,
      lastEventAt: now,
      metadata,
      updatedAt: now,
    } satisfies Partial<typeof deliveryUnits.$inferInsert>;

    let unit: DeliveryUnitRow;
    let created = false;
    if (existing) {
      const [updated] = await db
        .update(deliveryUnits)
        .set({
          ...basePatch,
          // The increment is a single atomic SQL expression, so two racing
          // submissions can never share one generation, and every in-flight
          // write fenced at the previous generation is voided.
          ...(identityChanged ? {
            candidateGeneration: sql`${deliveryUnits.candidateGeneration} + 1`,
            readyAt: null,
            queueEnteredAt: null,
            mergeRequestedAt: null,
            pausedAt: null,
          } : {}),
        })
        // The write is conditional on the unit still being open. The candidate
        // was verified against GitHub before this statement, so the unit can
        // have merged, been cancelled, or closed unmerged in the meantime — a
        // submission must never resurrect a terminal unit (nor steal its
        // accepted head).
        .where(and(
          eq(deliveryUnits.id, existing.id),
          inArray(deliveryUnits.status, [...OPEN_UNIT_STATUSES]),
        ))
        .returning();
      if (updated) {
        unit = updated;
      } else {
        // The unit left the open set while the candidate was being verified: it
        // is terminal now, so this candidate registers as a new unit instead.
        const [inserted] = await db
          .insert(deliveryUnits)
          .values({
            companyId: input.companyId,
            repositoryId: repository.id,
            primaryIssueId: input.issue.id,
            ...basePatch,
          })
          .returning();
        unit = inserted!;
        created = true;
      }
    } else {
      const [inserted] = await db
        .insert(deliveryUnits)
        .values({
          companyId: input.companyId,
          repositoryId: repository.id,
          primaryIssueId: input.issue.id,
          ...basePatch,
        })
        .returning();
      unit = inserted!;
      created = true;
    }

    await db
      .insert(deliveryUnitIssues)
      .values([
        { companyId: input.companyId, unitId: unit.id, issueId: input.issue.id, role: "primary" },
        ...covered.map((issueId) => ({ companyId: input.companyId, unitId: unit.id, issueId, role: "covered" })),
      ])
      .onConflictDoNothing();
    // A repair submission advances the candidate, not its explicit coverage.
    // Only a supplied list replaces the handoff; [] explicitly removes it.
    if (input.coveredIssueIds !== undefined) {
      const existingCovered = await db
        .select({ id: deliveryUnitIssues.id, issueId: deliveryUnitIssues.issueId })
        .from(deliveryUnitIssues)
        .where(and(
          eq(deliveryUnitIssues.companyId, input.companyId),
          eq(deliveryUnitIssues.unitId, unit.id),
          eq(deliveryUnitIssues.role, "covered"),
        ));
      const staleCovered = existingCovered.filter((row) => !covered.includes(row.issueId));
      if (staleCovered.length > 0) {
        await db.delete(deliveryUnitIssues).where(inArray(deliveryUnitIssues.id, staleCovered.map((row) => row.id)));
      }
    }

    // The queue holds only accepted candidates: the reconciler enqueues when a
    // unit becomes ready_to_merge, so a not-yet-accepted head never blocks the
    // repository queue. A prior entry is held until re-acceptance.
    await queue.setStatus({
      companyId: input.companyId,
      unitId: unit.id,
      status: "blocked",
      lastErrorCode: "pending_acceptance",
      lastError: "Awaiting fresh review/check acceptance",
    });

    // Findings belong to the candidate that reported them. When the identity
    // changed, the previous generation's unresolved findings become history in
    // the same transition that replaces the candidate: they stay visible in the
    // timeline and never block or explain the new one.
    if (identityChanged) {
      await db
        .update(deliveryFindings)
        .set({ state: "stale", updatedAt: now })
        .where(and(
          eq(deliveryFindings.companyId, input.companyId),
          eq(deliveryFindings.unitId, unit.id),
          ne(deliveryFindings.candidateGeneration, unit.candidateGeneration),
          inArray(deliveryFindings.state, ["open"]),
        ));
    }

    await events.append({
      companyId: input.companyId,
      unitId: unit.id,
      issueId: input.issue.id,
      type: identityChanged ? "head_changed" : "candidate_submitted",
      message: identityChanged
        ? `Candidate ${headSha.slice(0, 12)} registered as generation ${unit.candidateGeneration} (${materialChanges.join(", ")}); readiness was revoked`
        : `Candidate ${headSha.slice(0, 12)} submitted on ${sourceBranch}`,
      dedupeKey: `candidate:${unit.candidateGeneration}`,
      url: unit.prUrl,
      payload: { sourceBranch, targetBranch, headSha, artifactReady: unit.artifactReady, candidateGeneration: unit.candidateGeneration, materialChanges },
    });
    // `artifactReady` records worker development readiness only. It never wakes
    // dependents here: the reconciler wakes `needs_artifact` dependents after
    // the exact head is accepted on fresh evidence, never on a bare boolean.
    if (unit.artifactReady) {
      await events.append({
        companyId: input.companyId,
        unitId: unit.id,
        issueId: input.issue.id,
        type: "artifact_ready",
        message: "Reviewed artifact is ready for dependent development",
        dedupeKey: `artifact_ready:${headSha}`,
        url: unit.prUrl,
        payload: { headSha },
      });
    }
    // Submission is a controller-owned review transition: the candidate and the
    // issues it covers are now under review. The write is a conditional update,
    // so a concurrent terminal, blocked, or operator-owned status is never
    // reopened and the transition cannot race into a fabricated confirmation.
    if (unit.pausedAt == null && policyRow.enabled && !policyRow.paused) {
      const coveredIssueIds = await db
        .select({ issueId: deliveryUnitIssues.issueId })
        .from(deliveryUnitIssues)
        .where(and(
          eq(deliveryUnitIssues.companyId, input.companyId),
          eq(deliveryUnitIssues.unitId, unit.id),
        ))
        .then((rows) => rows.map((row) => row.issueId));
      const moved = await db
        .update(issues)
        .set({ status: "in_review", updatedAt: now })
        .where(and(
          eq(issues.companyId, input.companyId),
          inArray(issues.id, coveredIssueIds),
          inArray(issues.status, ["todo", "in_progress", "in_review"]),
        ))
        .returning({ id: issues.id });
      for (const issue of moved) {
        if (issue.id === input.issue.id) continue;
        await events.append({
          companyId: input.companyId,
          unitId: unit.id,
          issueId: issue.id,
          type: "reconciled",
          message: `Moved to review by the candidate covering this issue (${headSha.slice(0, 12)})`,
          dedupeKey: `covered_review:${issue.id}:${headSha}`,
          payload: { headSha, primaryIssueId: input.issue.id },
        });
      }
    }
    return { unit, created };
  }

  /**
   * A reviewed artifact unblocks development on units that declared a
   * `needs_artifact` dependency on this unit. Called only by the reconciler
   * after the exact head is accepted on fresh evidence — never on a worker
   * `artifactReady` boolean alone. Each wake goes through the real heartbeat
   * dispatcher and is idempotent per (dependent unit, accepted head).
   */
  async function notifyArtifactDependents(companyId: string, unit: DeliveryUnitRow) {
    const acceptedHead = unit.acceptedHeadSha;
    if (!acceptedHead || acceptedHead !== unit.headSha) return;
    const dependents = await db
      .select({
        unitId: deliveryUnits.id,
        issueId: deliveryUnits.primaryIssueId,
        ownerAgentId: deliveryUnits.ownerAgentId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(deliveryDependencies)
      .innerJoin(deliveryUnits, eq(deliveryUnits.id, deliveryDependencies.unitId))
      .innerJoin(issues, eq(issues.id, deliveryUnits.primaryIssueId))
      .where(and(
        eq(deliveryDependencies.companyId, companyId),
        eq(deliveryDependencies.dependsOnUnitId, unit.id),
        eq(deliveryDependencies.kind, "needs_artifact"),
      ));
    for (const dependent of dependents) {
      const agentId = dependent.ownerAgentId ?? dependent.assigneeAgentId;
      if (!agentId) continue;
      const { dispatched } = await dispatchOwnerWake({
        companyId,
        agentId,
        reason: "delivery_artifact_ready",
        payload: {
          issueId: dependent.issueId,
          taskId: dependent.issueId,
          dependencyUnitId: unit.id,
          acceptedHeadSha: acceptedHead,
        },
        idempotencyKey: `delivery_artifact_ready:${dependent.unitId}:${unit.id}:${acceptedHead}`,
      });
      await events.append({
        companyId,
        unitId: dependent.unitId,
        issueId: dependent.issueId,
        type: "reconciled",
        message: dispatched
          ? `Reviewed artifact ${acceptedHead.slice(0, 12)} is ready for dependent development`
          : `Reviewed artifact ${acceptedHead.slice(0, 12)} is ready; owner wake is pending dispatch`,
        dedupeKey: `artifact_wake:${dependent.unitId}:${acceptedHead}`,
        payload: { dependencyUnitId: unit.id, acceptedHeadSha: acceptedHead, dispatched },
      });
    }
  }

  /**
   * Fail-closed authoritative bind for submit: the GitHub read must succeed,
   * an open pull request must exist, and its head ref and exact head revision
   * must match the submitted candidate. Anything else blocks registration.
   */
  async function bindAuthoritativePullRequest(
    companyId: string,
    connectionId: string | null,
    repository: DeliveryRepositoryRow,
    unit: Pick<DeliveryUnitRow, "sourceBranch" | "targetBranch">,
    prNumberHint: number | null,
    headSha: string,
  ) {
    const result = prNumberHint
      ? await github.getPullRequest(companyId, connectionId, repository.host, repository.owner, repository.name, prNumberHint)
      : await github.findOpenPullRequest(
        companyId, connectionId, repository.host, repository.owner, repository.name, unit.sourceBranch, unit.targetBranch,
      );
    if (!result.ok) {
      throw unprocessable(`Could not verify the pull request before registration: ${result.message}`, {
        reasonCode: result.errorCode === "connection_missing" ? "connection_missing" : "provider_unknown",
      });
    }
    const pr = result.value;
    if (!pr) {
      throw unprocessable("No open pull request exists for the candidate branch; publish it before submitting", {
        reasonCode: "candidate_required",
      });
    }
    if (pr.state !== "open" || pr.merged) {
      throw unprocessable("The pull request is not open; submit tracks the authoritative open pull request only", {
        reasonCode: "candidate_required",
        prNumber: pr.number,
      });
    }
    if (pr.baseRef !== unit.targetBranch) {
      throw unprocessable(`The pull request targets ${pr.baseRef}, not the delivery branch ${unit.targetBranch}`, {
        reasonCode: "base_stale",
      });
    }
    if (pr.headRef !== unit.sourceBranch) {
      throw unprocessable("The pull request head branch does not match the submitted source branch", {
        reasonCode: "head_stale",
      });
    }
    if (pr.headSha !== headSha) {
      throw unprocessable("The pull request head is not the submitted revision; re-submit the current remote head", {
        reasonCode: "head_stale",
        remoteHeadSha: pr.headSha,
      });
    }
    return pr;
  }

  /**
   * Explicit delivery dependency edges between units. Cycles are rejected
   * before insert so the queue can never deadlock on a dependency loop.
   */
  async function setDependencies(input: {
    companyId: string;
    unitId: string;
    actor: DeliveryActor;
    needsArtifactIssueIds?: string[];
    mustMergeAfterIssueIds?: string[];
  }) {
    const unit = await getUnit(input.companyId, input.unitId);
    if (!unit) throw notFound("Delivery unit not found");
    const resolveUnitId = async (issueId: string) => {
      const other = await findUnitForIssue(input.companyId, issueId);
      if (!other) {
        throw unprocessable("Dependency issue has no delivery unit", { issueId });
      }
      if (other.id === unit.id) {
        throw unprocessable("A delivery unit cannot depend on itself", { issueId });
      }
      if (other.repositoryId !== unit.repositoryId && other.status !== "merged") {
        throw unprocessable("Dependency unit belongs to a different repository", { issueId, unitId: other.id });
      }
      return other.id;
    };
    const needsArtifact = await Promise.all((input.needsArtifactIssueIds ?? []).map(resolveUnitId));
    const mustMergeAfter = await Promise.all((input.mustMergeAfterIssueIds ?? []).map(resolveUnitId));

    await db
      .delete(deliveryDependencies)
      .where(and(eq(deliveryDependencies.companyId, input.companyId), eq(deliveryDependencies.unitId, unit.id)));
    const rows = [
      ...needsArtifact.map((dependsOnUnitId) => ({ kind: "needs_artifact" as const, dependsOnUnitId })),
      ...mustMergeAfter.map((dependsOnUnitId) => ({ kind: "must_merge_after" as const, dependsOnUnitId })),
    ];
    if (rows.length > 0) {
      await assertNoDependencyCycle(input.companyId, unit.id, rows.map((row) => row.dependsOnUnitId));
      await db.insert(deliveryDependencies).values(rows.map((row) => ({
        companyId: input.companyId,
        unitId: unit.id,
        dependsOnUnitId: row.dependsOnUnitId,
        kind: row.kind,
        createdByActorType: input.actor.type,
        createdByActorId: input.actor.id,
      }))).onConflictDoNothing();
    }
    await events.append({
      companyId: input.companyId,
      unitId: unit.id,
      issueId: unit.primaryIssueId,
      type: "reconciled",
      message: `Dependencies updated: ${needsArtifact.length} needs-artifact, ${mustMergeAfter.length} must-merge-after`,
      dedupeKey: `dependencies:${[...needsArtifact, ...mustMergeAfter].sort().join(",")}`,
      payload: { needsArtifact, mustMergeAfter },
    });
  }

  async function assertNoDependencyCycle(companyId: string, unitId: string, dependencyUnitIds: string[]) {
    const edges = await db
      .select({ from: deliveryDependencies.unitId, to: deliveryDependencies.dependsOnUnitId })
      .from(deliveryDependencies)
      .where(eq(deliveryDependencies.companyId, companyId));
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      const list = adjacency.get(edge.from) ?? [];
      list.push(edge.to);
      adjacency.set(edge.from, list);
    }
    for (const dependency of dependencyUnitIds) {
      const list = adjacency.get(unitId) ?? [];
      if (!list.includes(dependency)) list.push(dependency);
      adjacency.set(unitId, list);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = (node: string): boolean => {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const next of adjacency.get(node) ?? []) {
        if (walk(next)) return true;
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    if (walk(unitId)) {
      throw unprocessable("Delivery dependency cycle detected", { unitId });
    }
  }

  async function recordDisposition(input: {
    companyId: string;
    issue: DeliveryIssueRow;
    actor: DeliveryActor;
    kind: "code" | "non_code";
    reasonCode: string;
    message: string;
    owner?: string | null;
    nextAction?: string | null;
  }) {
    // A delivery disposition is operator-governed: only a board session may
    // classify an issue as code or non-code. Without this any worker could
    // self-serve a non_code closure and bypass the Done gate.
    if (input.actor.type !== "user") {
      throw forbidden("Delivery dispositions require an operator session", { issueId: input.issue.id });
    }
    const disposition: DeliveryDisposition = {
      reasonCode: input.reasonCode,
      message: input.message,
      owner: input.owner ?? null,
      nextAction: input.nextAction ?? null,
      actorType: input.actor.type,
      actorId: input.actor.id,
      at: new Date().toISOString(),
    };
    await db
      .update(issues)
      .set({ deliveryKind: input.kind, deliveryDisposition: disposition, updatedAt: new Date() })
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issue.id)));
  }

  async function recordFindingDisposition(input: {
    companyId: string;
    unitId: string;
    actor: DeliveryActor;
    findingId: string;
    disposition: "fixed" | "disputed" | "already_addressed";
    explanation: string;
  }) {
    const [existing] = await db
      .select()
      .from(deliveryFindings)
      .where(and(
        eq(deliveryFindings.companyId, input.companyId),
        eq(deliveryFindings.unitId, input.unitId),
        eq(deliveryFindings.id, input.findingId),
      ))
      .limit(1);
    if (!existing) throw notFound("Delivery finding not found");
    const now = new Date();
    const [updated] = await db
      .update(deliveryFindings)
      .set({
        state: input.disposition,
        disposition: input.disposition,
        dispositionExplanation: input.explanation,
        dispositionActorType: input.actor.type,
        dispositionActorId: input.actor.id,
        dispositionAt: now,
        updatedAt: now,
      })
      .where(eq(deliveryFindings.id, existing.id))
      .returning();
    await events.append({
      companyId: input.companyId,
      unitId: input.unitId,
      type: "finding_disposition",
      message: `Finding ${existing.externalId} recorded as ${input.disposition}`,
      dedupeKey: `finding:${existing.externalId}:${input.disposition}:${now.getTime()}`,
      payload: { findingId: existing.id, disposition: input.disposition },
    });
    return updated!;
  }

  async function markBlocked(input: {
    companyId: string;
    unitId: string;
    blocker: DeliveryBlocker;
    nextAction?: string | null;
    /**
     * Candidate generation the caller read its evidence at. A write fenced at
     * an older generation is dropped: evidence read for a previous candidate
     * must never describe — or block — the current one.
     */
    candidateGeneration?: number | null;
  }): Promise<boolean> {
    const unit = await getUnit(input.companyId, input.unitId);
    if (!unit) return false;
    if (input.candidateGeneration != null && unit.candidateGeneration !== input.candidateGeneration) return false;
    // Terminal units and operator pauses are never overwritten by in-flight
    // reconciliation writes. A paused unit keeps its operator blocker until an
    // explicit resume; a merged or cancelled unit keeps its terminal state.
    if (unit.status === "merged" || unit.status === "cancelled") return false;
    if (unit.pausedAt != null) return false;
    if (unit.blocker?.reasonCode === input.blocker.reasonCode) return false;
    const metadata = blockerToMetadataPhase(unit, readUnitMetadata(unit.metadata));
    const now = new Date();
    const updated = await db
      .update(deliveryUnits)
      .set({
        status: "blocked",
        blocker: input.blocker,
        nextAction: input.nextAction ?? input.blocker.nextAction,
        metadata,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(deliveryUnits.id, unit.id),
        // Terminal is permanent. The status is re-checked inside the write, not
        // only before it: a merge that commits between the read above and this
        // statement would otherwise be overwritten back to `blocked`.
        notInArray(deliveryUnits.status, [...TERMINAL_UNIT_STATUSES]),
        ...(input.candidateGeneration != null
          ? [eq(deliveryUnits.candidateGeneration, input.candidateGeneration)]
          : []),
      ))
      .returning({ id: deliveryUnits.id });
    if (updated.length === 0) return false;
    await events.append({
      companyId: input.companyId,
      unitId: unit.id,
      issueId: unit.primaryIssueId,
      type: "blocked",
      message: input.blocker.message,
      dedupeKey: `blocked:${input.blocker.reasonCode}:g${unit.candidateGeneration}`,
      payload: { reasonCode: input.blocker.reasonCode, candidateGeneration: unit.candidateGeneration },
    });
    return true;
  }

  async function clearBlocker(companyId: string, unitId: string, candidateGeneration?: number | null) {
    const unit = await getUnit(companyId, unitId);
    if (!unit || !unit.blocker) return;
    if (candidateGeneration != null && unit.candidateGeneration !== candidateGeneration) return;
    const metadata = { ...readUnitMetadata(unit.metadata) };
    delete metadata.blockedPhase;
    const now = new Date();
    const updated = await db
      .update(deliveryUnits)
      .set({
        status: unit.status === "blocked" ? "in_review" : unit.status,
        blocker: null,
        nextAction: null,
        metadata,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(deliveryUnits.id, unitId),
        notInArray(deliveryUnits.status, [...TERMINAL_UNIT_STATUSES]),
        ...(candidateGeneration != null ? [eq(deliveryUnits.candidateGeneration, candidateGeneration)] : []),
      ))
      .returning({ id: deliveryUnits.id });
    if (updated.length === 0) return;
    await events.append({
      companyId,
      unitId,
      issueId: unit.primaryIssueId,
      type: "unblocked",
      message: `Blocker ${unit.blocker.reasonCode} cleared`,
      dedupeKey: `unblocked:${unit.blocker.reasonCode}:${now.getTime()}`,
    });
  }

  async function setUnitStatus(input: {
    companyId: string;
    unitId: string;
    status: DeliveryUnitRow["status"];
    nextAction?: string | null;
    /** Read generation fence; see `markBlocked`. */
    candidateGeneration?: number | null;
  }) {
    const unit = await getUnit(input.companyId, input.unitId);
    if (!unit) return unit;
    if (input.candidateGeneration != null && unit.candidateGeneration !== input.candidateGeneration) return unit;
    // Terminal units never leave their state via a status sync: a merged or
    // cancelled unit that receives a late event keeps its terminal state.
    if (unit.status === "merged" || unit.status === "cancelled") return unit;
    const now = new Date();
    const [updated] = await db
      .update(deliveryUnits)
      .set({
        status: input.status,
        ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
        lastEventAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(deliveryUnits.companyId, input.companyId),
        eq(deliveryUnits.id, input.unitId),
        notInArray(deliveryUnits.status, [...TERMINAL_UNIT_STATUSES]),
        ...(input.candidateGeneration != null
          ? [eq(deliveryUnits.candidateGeneration, input.candidateGeneration)]
          : []),
      ))
      .returning();
    return updated ?? null;
  }

  async function pauseUnit(input: { companyId: string; unitId: string; actor: DeliveryActor; reason?: string }) {
    const unit = await getUnit(input.companyId, input.unitId);
    if (!unit) throw notFound("Delivery unit not found");
    if (unit.status === "merged" || unit.status === "cancelled" || unit.status === "closed_unmerged") {
      throw conflict("Terminal delivery units cannot be paused", { unitId: unit.id, status: unit.status });
    }
    if (unit.pausedAt != null) return unit;
    const now = new Date();
    const metadata = { ...readUnitMetadata(unit.metadata), blockedPhase: deriveDeliveryPhase(unit) };
    const [updated] = await db
      .update(deliveryUnits)
      .set({
        status: "blocked",
        pausedAt: now,
        blocker: {
          reasonCode: "operator_paused",
          message: input.reason?.trim() || "Delivery paused by operator",
          owner: null,
          nextAction: "Resume the delivery unit to continue.",
        },
        metadata,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(deliveryUnits.id, unit.id),
        // Atomically non-terminal and still unpaused: a merge that lands during
        // this write must not be paused back into an open state.
        notInArray(deliveryUnits.status, [...TERMINAL_UNIT_STATUSES]),
        isNull(deliveryUnits.pausedAt),
      ))
      .returning();
    if (!updated) {
      throw conflict("Delivery unit is no longer open to pause", { unitId: unit.id });
    }
    await queue.setStatus({ companyId: input.companyId, unitId: unit.id, status: "blocked" });
    await events.append({
      companyId: input.companyId,
      unitId: unit.id,
      issueId: unit.primaryIssueId,
      type: "paused",
      message: input.reason?.trim() || "Delivery paused by operator",
      dedupeKey: `paused:${now.getTime()}`,
    });
    return updated;
  }

  async function resumeUnit(input: { companyId: string; unitId: string; actor: DeliveryActor }) {
    const unit = await getUnit(input.companyId, input.unitId);
    if (!unit) throw notFound("Delivery unit not found");
    if (unit.status === "merged" || unit.status === "cancelled" || unit.status === "closed_unmerged") {
      throw conflict("Terminal delivery units cannot be resumed", { unitId: unit.id, status: unit.status });
    }
    if (unit.pausedAt == null) {
      throw conflict("Delivery unit is not paused", { unitId: unit.id, status: unit.status });
    }
    const metadata = { ...readUnitMetadata(unit.metadata) };
    delete metadata.blockedPhase;
    const now = new Date();
    const [updated] = await db
      .update(deliveryUnits)
      .set({ status: "in_review", pausedAt: null, blocker: null, nextAction: null, metadata, lastEventAt: now, updatedAt: now })
      .where(and(
        eq(deliveryUnits.id, unit.id),
        // Still non-terminal and still the paused row this resume was decided
        // from; a concurrent terminal transition is never reopened.
        notInArray(deliveryUnits.status, [...TERMINAL_UNIT_STATUSES]),
        isNotNull(deliveryUnits.pausedAt),
      ))
      .returning();
    if (!updated) {
      throw conflict("Delivery unit is no longer paused", { unitId: unit.id });
    }
    await events.append({
      companyId: input.companyId,
      unitId: unit.id,
      issueId: unit.primaryIssueId,
      type: "resumed",
      message: "Delivery resumed by operator",
      dedupeKey: `resumed:${now.getTime()}`,
    });
    return updated!;
  }

  async function cancelUnit(input: { companyId: string; unitId: string; actor: DeliveryActor; reason?: string }) {
    const unit = await getUnit(input.companyId, input.unitId);
    if (!unit) throw notFound("Delivery unit not found");
    if (unit.status === "merged") {
      throw conflict("Merged delivery units cannot be cancelled", { unitId: unit.id });
    }
    if (unit.status === "cancelled") return unit;
    const now = new Date();
    const [updated] = await db
      .update(deliveryUnits)
      .set({ status: "cancelled", cancelledAt: now, nextAction: null, lastEventAt: now, updatedAt: now })
      .where(and(
        eq(deliveryUnits.id, unit.id),
        // A merge that lands between the read and this write keeps its state.
        ne(deliveryUnits.status, "merged"),
      ))
      .returning();
    if (!updated) {
      throw conflict("Merged delivery units cannot be cancelled", { unitId: unit.id });
    }
    await queue.setStatus({ companyId: input.companyId, unitId: unit.id, status: "cancelled" });
    await events.append({
      companyId: input.companyId,
      unitId: unit.id,
      issueId: unit.primaryIssueId,
      type: "cancelled",
      message: input.reason?.trim() || "Delivery cancelled by operator",
      dedupeKey: `cancelled:${now.getTime()}`,
    });
    return updated!;
  }

  return {
    getUnit,
    findUnitForIssue,
    listUnitsForIssue,
    getReceipt,
    loadRepository,
    classifyCodeDelivery,
    buildSummary,
    buildUnitDetail,
    registerCandidate,
    setDependencies,
    recordDisposition,
    recordFindingDisposition,
    dispatchOwnerWake,
    notifyArtifactDependents,
    pauseUnit,
    resumeUnit,
    listFindings,
    cancelUnit,
    markBlocked,
    clearBlocker,
    setUnitStatus,
  };
}
