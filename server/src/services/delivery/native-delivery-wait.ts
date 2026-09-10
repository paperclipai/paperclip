import { and, eq, inArray, notInArray } from "drizzle-orm";
import {
  deliveryPolicies,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  type Db,
} from "@paperclipai/db";
import type { DeliveryBlocker, DeliveryPhase, DeliveryUnitStatus } from "@paperclipai/shared";
import { deriveDeliveryPhase, readUnitMetadata, type DeliveryUnitRow } from "./units.js";

/**
 * Native delivery as an owned waiting path.
 *
 * A delivery unit whose project policy is enabled and unpaused keeps a live
 * next action without any issue-thread interaction: the delivery controller
 * re-reads GitHub on every webhook and scheduler sweep, and it wakes the
 * implementation owner through the bounded repair loop when a real code
 * repair is required. The generic recovery engines (review-path recovery,
 * successful-run handoff, disposition repair, stranded-work and productivity
 * reconciliation) must therefore treat that unit as a durable waiting path
 * instead of inventing a second, wrong-flavoured wake.
 *
 * This is deliberately narrow. A unit only counts as an owned wait when all of
 * the following hold, so no operator gate is silently swallowed:
 *
 * - the unit is linked to the issue through `delivery_unit_issues`;
 * - the unit status is non-terminal and the unit is not paused;
 * - the unit's project policy exists, is enabled, and is not paused;
 * - when the unit is `blocked`, its machine reason is one the controller
 *   itself re-evaluates. Every operator/worker gate (missing or disabled
 *   policy, unverified repository, missing connection, missing authorization,
 *   Greptile unavailable, exhausted repair attempts, operator pause/cancel,
 *   missing candidate, unready artifact, re-target) keeps its own precedence
 *   and is never claimed here.
 */

const NATIVE_DELIVERY_WAIT_TERMINAL_UNIT_STATUSES: readonly DeliveryUnitStatus[] = [
  "merged",
  "cancelled",
  "closed_unmerged",
];

/**
 * Blocker reasons the delivery controller resolves by itself: the next
 * reconcile sweep retries the remote read, or the bounded owner-repair loop
 * already woke the implementation owner for this exact head.
 */
export const NATIVE_DELIVERY_WAIT_CONTROLLER_REASON_CODES: Record<string, true> = {
  checks_pending: true,
  checks_failing: true,
  review_pending: true,
  review_approval_required: true,
  review_blocking_findings: true,
  review_head_stale: true,
  head_stale: true,
  conflict: true,
  merge_queue_blocked: true,
  merge_rejected: true,
  merge_unknown: true,
  lease_lost: true,
  provider_unknown: true,
  dependency_needs_artifact: true,
  dependency_must_merge_after: true,
};

/** Reasons whose next action is the implementation owner's bounded repair wake. */
const NATIVE_DELIVERY_WAIT_OWNER_REPAIR_REASON_CODES: Record<string, true> = {
  checks_failing: true,
  review_blocking_findings: true,
  head_stale: true,
  conflict: true,
  merge_queue_blocked: true,
  merge_rejected: true,
};

const NATIVE_DELIVERY_WAIT_QUERY_CHUNK_SIZE = 250;

/** Why a linked unit is not an owned wait. Exported for diagnostics and tests. */
export type NativeDeliveryWaitSkipReason =
  | "terminal_unit"
  | "paused_unit"
  | "policy_missing"
  | "policy_disabled"
  | "policy_paused"
  | "repository_mismatch"
  | "blocker_not_controller_owned";

export type NativeDeliveryWaitNextActor = "controller" | "implementation_owner";

export type NativeDeliveryWait = {
  issueId: string;
  unitId: string;
  unitStatus: DeliveryUnitStatus;
  phase: DeliveryPhase;
  /**
   * Candidate identity epoch of the waited-on unit. A consumer that acts on
   * this wait (queue parking, repair context) must re-validate against this
   * generation: evidence for a replaced candidate never describes the current
   * one.
   */
  candidateGeneration: number;
  repositoryId: string;
  repository: string;
  targetBranch: string;
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  acceptedHeadSha: string | null;
  ownerAgentId: string | null;
  policyId: string;
  since: Date;
  blocker: DeliveryBlocker | null;
  nextActor: NativeDeliveryWaitNextActor;
};

/** The persisted fields the classifier reads. Kept structural for tests. */
export type NativeDeliveryWaitUnitInput = {
  id: string;
  status: string;
  repositoryId: string;
  targetBranch: string;
  pausedAt: Date | null;
  blocker: unknown;
};

export type NativeDeliveryWaitPolicyInput = {
  id: string;
  enabled: boolean;
  paused: boolean;
  repositoryId: string | null;
};

export type NativeDeliveryWaitClaim =
  | { kind: "wait"; blocker: DeliveryBlocker | null; nextActor: NativeDeliveryWaitNextActor }
  | { kind: "none"; reason: NativeDeliveryWaitSkipReason };

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readDeliveryBlocker(value: unknown): DeliveryBlocker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const reasonCode = readNonEmptyString(record.reasonCode);
  if (!reasonCode) return null;
  return {
    reasonCode,
    message: readNonEmptyString(record.message) ?? reasonCode,
    owner: readNonEmptyString(record.owner),
    nextAction: readNonEmptyString(record.nextAction),
  };
}

/**
 * Decides whether one persisted unit + its project policy is an owned wait.
 * Pure: callers supply the persisted rows, so no caller boolean, task prose, or
 * head fallback can manufacture a wait.
 */
export function classifyNativeDeliveryWait(input: {
  unit: NativeDeliveryWaitUnitInput;
  policy: NativeDeliveryWaitPolicyInput | null;
}): NativeDeliveryWaitClaim {
  const { unit, policy } = input;
  if (NATIVE_DELIVERY_WAIT_TERMINAL_UNIT_STATUSES.includes(unit.status as DeliveryUnitStatus)) {
    return { kind: "none", reason: "terminal_unit" };
  }
  if (unit.pausedAt != null) return { kind: "none", reason: "paused_unit" };
  if (!policy) return { kind: "none", reason: "policy_missing" };
  if (!policy.enabled) return { kind: "none", reason: "policy_disabled" };
  if (policy.paused) return { kind: "none", reason: "policy_paused" };
  if (policy.repositoryId != null && policy.repositoryId !== unit.repositoryId) {
    return { kind: "none", reason: "repository_mismatch" };
  }

  if (unit.status === "blocked") {
    const blocker = readDeliveryBlocker(unit.blocker);
    if (!blocker || NATIVE_DELIVERY_WAIT_CONTROLLER_REASON_CODES[blocker.reasonCode] !== true) {
      return { kind: "none", reason: "blocker_not_controller_owned" };
    }
    return {
      kind: "wait",
      blocker,
      nextActor: NATIVE_DELIVERY_WAIT_OWNER_REPAIR_REASON_CODES[blocker.reasonCode] === true
        ? "implementation_owner"
        : "controller",
    };
  }

  // submitted | in_review | ready_to_merge | merging: the controller owns the
  // next remote action (review/checks evidence, queue admission, merge).
  return { kind: "wait", blocker: null, nextActor: "controller" };
}

function toWait(input: {
  issueId: string;
  unit: DeliveryUnitRow;
  repositoryOwner: string | null;
  repositoryName: string | null;
  policyId: string;
  claim: Extract<NativeDeliveryWaitClaim, { kind: "wait" }>;
}): NativeDeliveryWait {
  const metadata = readUnitMetadata(input.unit.metadata);
  const remoteUpdatedAt = metadata.lastRemoteUpdatedAt ? new Date(metadata.lastRemoteUpdatedAt) : null;
  return {
    issueId: input.issueId,
    unitId: input.unit.id,
    unitStatus: input.unit.status,
    phase: deriveDeliveryPhase(input.unit),
    candidateGeneration: input.unit.candidateGeneration,
    repositoryId: input.unit.repositoryId,
    repository: input.repositoryOwner && input.repositoryName
      ? `${input.repositoryOwner}/${input.repositoryName}`
      : input.unit.repositoryId,
    targetBranch: input.unit.targetBranch,
    prNumber: input.unit.prNumber,
    prUrl: input.unit.prUrl,
    headSha: input.unit.headSha,
    acceptedHeadSha: input.unit.acceptedHeadSha,
    ownerAgentId: input.unit.ownerAgentId,
    policyId: input.policyId,
    since: input.unit.lastEventAt ?? remoteUpdatedAt ?? input.unit.updatedAt,
    blocker: input.claim.blocker,
    nextActor: input.claim.nextActor,
  };
}

/**
 * Batch form for issue attention lists: a fixed set of queries per issue-id
 * chunk (link rows, units, policies, repositories), never one round trip per
 * issue. Returns only issues with an owned wait, keyed by issue id. An issue
 * linked to several units resolves to the most recently updated owned wait.
 */
export async function listNativeDeliveryWaits(
  db: Db,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, NativeDeliveryWait>> {
  const waits = new Map<string, NativeDeliveryWait>();
  const uniqueIssueIds = [...new Set(issueIds.filter((issueId) => issueId.length > 0))];
  if (uniqueIssueIds.length === 0) return waits;

  for (let index = 0; index < uniqueIssueIds.length; index += NATIVE_DELIVERY_WAIT_QUERY_CHUNK_SIZE) {
    const chunk = uniqueIssueIds.slice(index, index + NATIVE_DELIVERY_WAIT_QUERY_CHUNK_SIZE);
    const linkRows = await db
      .select({ issueId: deliveryUnitIssues.issueId, unitId: deliveryUnitIssues.unitId })
      .from(deliveryUnitIssues)
      .where(and(
        eq(deliveryUnitIssues.companyId, companyId),
        inArray(deliveryUnitIssues.issueId, chunk),
      ));

    const unitIdsByIssueId = new Map<string, string[]>();
    for (const row of linkRows) {
      const { issueId, unitId } = row;
      if (typeof issueId !== "string" || typeof unitId !== "string" || unitId.length === 0) continue;
      const unitIds = unitIdsByIssueId.get(issueId);
      if (unitIds) unitIds.push(unitId);
      else unitIdsByIssueId.set(issueId, [unitId]);
    }
    const unitIds = [...new Set([...unitIdsByIssueId.values()].flat())];
    if (unitIds.length === 0) continue;

    const unitRows = await db
      .select()
      .from(deliveryUnits)
      .where(and(
        eq(deliveryUnits.companyId, companyId),
        inArray(deliveryUnits.id, unitIds),
        notInArray(deliveryUnits.status, [...NATIVE_DELIVERY_WAIT_TERMINAL_UNIT_STATUSES]),
      ));
    const unitsById = new Map(unitRows.map((unit) => [unit.id, unit]));
    const projectIds = [...new Set(unitRows.flatMap((unit) => unit.projectId ? [unit.projectId] : []))];
    const repositoryIds = [...new Set(unitRows.map((unit) => unit.repositoryId))];
    const [policyRows, repositoryRows] = await Promise.all([
      projectIds.length === 0
        ? Promise.resolve([])
        : db
            .select()
            .from(deliveryPolicies)
            .where(and(
              eq(deliveryPolicies.companyId, companyId),
              inArray(deliveryPolicies.projectId, projectIds),
            )),
      repositoryIds.length === 0
        ? Promise.resolve([])
        : db
            .select({ id: deliveryRepositories.id, owner: deliveryRepositories.owner, name: deliveryRepositories.name })
            .from(deliveryRepositories)
            .where(and(
              eq(deliveryRepositories.companyId, companyId),
              inArray(deliveryRepositories.id, repositoryIds),
            )),
    ]);
    const policyByProjectId = new Map(policyRows.map((policy) => [policy.projectId, policy]));
    const repositoryById = new Map(repositoryRows.map((repository) => [repository.id, repository]));

    for (const [issueId, linkedUnitIds] of unitIdsByIssueId) {
      for (const unitId of linkedUnitIds) {
        const unit = unitsById.get(unitId);
        if (!unit) continue;
        const policyRow = unit.projectId ? policyByProjectId.get(unit.projectId) ?? null : null;
        if (!policyRow) continue;
        const claim = classifyNativeDeliveryWait({
          unit,
          policy: {
            id: policyRow.id,
            enabled: policyRow.enabled,
            paused: policyRow.paused,
            repositoryId: policyRow.repositoryId,
          },
        });
        if (claim.kind !== "wait") continue;
        const repository = repositoryById.get(unit.repositoryId);
        const wait = toWait({
          issueId,
          unit,
          repositoryOwner: repository?.owner ?? null,
          repositoryName: repository?.name ?? null,
          policyId: policyRow.id,
          claim,
        });
        const existing = waits.get(issueId);
        if (!existing || existing.since < wait.since) waits.set(issueId, wait);
      }
    }
  }

  return waits;
}

/** Single-issue form; shares the batch query so classification cannot drift. */
export async function getNativeDeliveryWait(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<NativeDeliveryWait | null> {
  return (await listNativeDeliveryWaits(db, companyId, [issueId])).get(issueId) ?? null;
}
