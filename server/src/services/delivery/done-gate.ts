import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  deliveryPolicies,
  deliveryReceipts,
  deliveryUnitIssues,
  deliveryUnits,
  issueWorkProducts,
  issues,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import { conflict, unprocessable } from "../../errors.js";
import type { DeliveryPhase } from "@paperclipai/shared";
import { RECOVERY_ORIGIN_KINDS } from "../recovery/origins.js";
import { parseGitHubRepositoryUrl } from "./policy.js";
/**
 * Unforgeable code-delivery Done gate.
 *
 * Every status write to `done` funnels through `issues.update`, and every
 * `ready_to_merge`/`merging` write must carry the controller context below.
 * The gate never trusts a caller-supplied fact: it reads the persisted delivery
 * unit and its receipt, which only the reconciler can create after verifying
 * remote inclusion.
 */

export type DeliveryControllerContext = {
  controller: "delivery-controller";
  unitId: string;
  reason: string;
};

export type DeliveryGateReasonCode =
  | "delivery_candidate_required"
  | "delivery_disposition_required"
  | "delivery_not_verified"
  | "delivery_children_incomplete"
  | "delivery_status_controller_only";

export type DeliveryGateResult =
  | { allowed: true }
  | {
    allowed: false;
    reasonCode: DeliveryGateReasonCode;
    message: string;
    details?: Record<string, unknown>;
  };

export type DeliveryGateIssue = typeof issues.$inferSelect;

export type DeliveryClassifiableIssue = Pick<DeliveryGateIssue, "id" | "deliveryKind" | "projectId" | "originKind">;

const OPEN_UNIT_STATUSES = ["submitted", "in_review", "ready_to_merge", "merging", "blocked"] as const;

const OPEN_CHILD_STATUSES = ["backlog", "todo", "in_progress", "in_review", "ready_to_merge", "merging", "blocked"] as const;

export interface DeliveryDoneGate {
  evaluateDone(input: { companyId: string; issue: DeliveryGateIssue }): Promise<DeliveryGateResult>;
  assertStatusWriteAllowed(input: {
    companyId: string;
    issue: DeliveryGateIssue;
    nextStatus: string;
    controller?: DeliveryControllerContext | null;
  }): Promise<void>;
  assertDeliverableOrThrow(input: { companyId: string; issueId: string }): Promise<void>;
  classifyCodeDelivery(companyId: string, issue: DeliveryClassifiableIssue): Promise<boolean>;
  countOpenDeliveryObligations(companyId: string, issueId: string): Promise<number>;
}

function deliveryPhaseForUnitStatus(status: string): DeliveryPhase {
  if (status === "merged") return "done";
  if (status === "merging") return "merging";
  if (status === "ready_to_merge") return "ready_to_merge";
  return "in_review";
}

export function createDeliveryDoneGate(db: Db): DeliveryDoneGate {
  async function classifyCodeDelivery(companyId: string, issue: DeliveryClassifiableIssue): Promise<boolean> {
    if (issue.deliveryKind === "code") return true;
    if (issue.deliveryKind === "non_code") return false;
    // An explicit code artifact decides first: a task that carries a delivery
    // unit or a pull-request work product is code delivery whatever its origin.
    const unit = await db
      .select({ id: deliveryUnitIssues.id })
      .from(deliveryUnitIssues)
      .where(and(eq(deliveryUnitIssues.companyId, companyId), eq(deliveryUnitIssues.issueId, issue.id)))
      .limit(1);
    if (unit.length > 0) return true;
    const pr = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, issue.id),
        eq(issueWorkProducts.type, "pull_request"),
      ))
      .limit(1);
    if (pr.length > 0) return true;
    // A productivity-review task assesses an agent's work: its deliverable is a
    // review, and it has no code revision to merge. Only after the artifact
    // checks above — a review task that did acquire a candidate or a pull
    // request is still code delivery — does its origin exempt it from the
    // merge-receipt gate, so a review-only task is not refused Done with a
    // code-merge obligation it can never satisfy.
    if (issue.originKind === RECOVERY_ORIGIN_KINDS.issueProductivityReview) return false;
    if (!issue.projectId) return false;
    const [policy] = await db
      .select({ enabled: deliveryPolicies.enabled, repositoryId: deliveryPolicies.repositoryId })
      .from(deliveryPolicies)
      .where(and(eq(deliveryPolicies.companyId, companyId), eq(deliveryPolicies.projectId, issue.projectId)))
      .limit(1);
    if (policy?.enabled && policy.repositoryId) return true;
    // Missing-policy enrollment gate: a project whose workspace points at a
    // GitHub repository is a code-delivery project even when no delivery
    // policy row exists yet. Absence of a policy must not let new code tasks
    // reach Done without a verified receipt or an operator disposition.
    const workspaces = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, issue.projectId)))
      .limit(5);
    return workspaces.some((workspace) => parseGitHubRepositoryUrl(workspace.repoUrl) != null);
  }

  /**
   * A receipt only counts when it names a merged unit for this issue, carries a
   * merged revision, and was verified for the same target branch the unit
   * delivered into.
   */
  async function verifiedReceipt(companyId: string, issueId: string) {
    const rows = await db
      .select({
        unitId: deliveryUnits.id,
        unitTargetBranch: deliveryUnits.targetBranch,
        unitStatus: deliveryUnits.status,
        mergedSha: deliveryReceipts.mergedSha,
        targetBranch: deliveryReceipts.targetBranch,
        verifiedAt: deliveryReceipts.verifiedAt,
      })
      .from(deliveryUnits)
      .innerJoin(deliveryUnitIssues, eq(deliveryUnitIssues.unitId, deliveryUnits.id))
      .innerJoin(deliveryReceipts, eq(deliveryReceipts.unitId, deliveryUnits.id))
      .where(and(
        eq(deliveryUnits.companyId, companyId),
        eq(deliveryUnitIssues.issueId, issueId),
        eq(deliveryUnits.status, "merged"),
      ))
      .limit(5);
    return rows.find((row) =>
      row.mergedSha
      && row.verifiedAt
      && row.targetBranch === row.unitTargetBranch) ?? null;
  }

  async function evaluateDone(input: { companyId: string; issue: DeliveryGateIssue }): Promise<DeliveryGateResult> {
    const { companyId, issue } = input;
    if (issue.deliveryKind === "non_code") {
      const disposition = issue.deliveryDisposition;
      // Only an operator-recorded disposition counts. A worker-written kind or
      // disposition can never self-serve a non-code closure around the gate.
      if (!disposition?.reasonCode || !disposition.message || disposition.actorType !== "user") {
        return {
          allowed: false,
          reasonCode: "delivery_disposition_required",
          message: "Non-code completion requires an operator-recorded disposition",
        };
      }
    }

    const verified = issue.deliveryKind === "non_code" ? null : await verifiedReceipt(companyId, issue.id);
    const codeDelivery = issue.deliveryKind !== "non_code"
      && (verified != null || await classifyCodeDelivery(companyId, issue));
    if (codeDelivery && !verified) {
      const [openUnit] = await db
        .select({ id: deliveryUnits.id, status: deliveryUnits.status })
        .from(deliveryUnits)
        .innerJoin(deliveryUnitIssues, eq(deliveryUnitIssues.unitId, deliveryUnits.id))
        .where(and(
          eq(deliveryUnits.companyId, companyId),
          eq(deliveryUnitIssues.issueId, issue.id),
        ))
        .orderBy(sql`case when ${deliveryUnits.status} = 'merged' then 0 else 1 end`)
        .limit(1);
      if (openUnit) {
        return {
          allowed: false,
          reasonCode: "delivery_not_verified",
          message: openUnit.status === "closed_unmerged"
            ? "The pull request was closed without merging; remote inclusion is not proven"
            : "Code delivery is not verified as merged into the intended target branch",
          details: {
            unitId: openUnit.id,
            unitStatus: openUnit.status,
            phase: deliveryPhaseForUnitStatus(openUnit.status),
          },
        };
      }
      return {
        allowed: false,
        reasonCode: "delivery_candidate_required",
        message: "Code delivery requires a verified merge receipt before it can be completed",
        details: { issueId: issue.id },
      };
    }

    // A parent's own acceptance is not enough: every linked child delivery
    // obligation must be resolved as well.
    const children = await db
      .select({
        id: issues.id,
        status: issues.status,
        deliveryKind: issues.deliveryKind,
        projectId: issues.projectId,
        // Classification reads the origin: a review-only child must be
        // recognised as such here exactly as it is for the issue itself.
        originKind: issues.originKind,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.parentId, issue.id),
        isNull(issues.hiddenAt),
        inArray(issues.status, [...OPEN_CHILD_STATUSES]),
      ));
    if (children.length > 0) {
      const unresolved: string[] = [];
      for (const child of children) {
        if (await verifiedReceipt(companyId, child.id)) continue;
        const childCode = await classifyCodeDelivery(companyId, child);
        if (childCode || child.deliveryKind === "non_code") unresolved.push(child.id);
      }
      if (unresolved.length > 0) {
        return {
          allowed: false,
          reasonCode: "delivery_children_incomplete",
          message: "Child delivery obligations are still open",
          details: { childIssueIds: unresolved },
        };
      }
    }
    return { allowed: true };
  }

  async function assertStatusWriteAllowed(input: {
    companyId: string;
    issue: DeliveryGateIssue;
    nextStatus: string;
    controller?: DeliveryControllerContext | null;
  }): Promise<void> {
    const { companyId, issue, nextStatus } = input;
    if (nextStatus === issue.status) return;

    if (nextStatus === "ready_to_merge" || nextStatus === "merging") {
      if (!input.controller) {
        throw conflict("Delivery statuses are written by the delivery controller only", {
          reasonCode: "delivery_status_controller_only",
          status: nextStatus,
        });
      }
      const [unit] = await db
        .select({ id: deliveryUnits.id })
        .from(deliveryUnits)
        .where(and(
          eq(deliveryUnits.companyId, companyId),
          eq(deliveryUnits.id, input.controller.unitId),
          inArray(deliveryUnits.status, [...OPEN_UNIT_STATUSES, "merged"]),
        ))
        .limit(1);
      if (!unit) {
        throw conflict("Delivery controller referenced an unknown unit", {
          reasonCode: "delivery_status_controller_only",
          unitId: input.controller.unitId,
        });
      }
      return;
    }

    if (nextStatus !== "done") return;
    const decision = await evaluateDone({ companyId, issue });
    if (decision.allowed) return;
    throw conflict(decision.message, {
      reasonCode: decision.reasonCode,
      ...decision.details,
    });
  }

  async function assertDeliverableOrThrow(input: { companyId: string; issueId: string }): Promise<void> {
    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!issue) throw unprocessable("Issue not found");
    const decision = await evaluateDone({ companyId: input.companyId, issue });
    if (decision.allowed) return;
    throw conflict(decision.message, { reasonCode: decision.reasonCode, ...decision.details });
  }

  async function countOpenDeliveryObligations(companyId: string, issueId: string) {
    return await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryUnits)
      .innerJoin(deliveryUnitIssues, eq(deliveryUnitIssues.unitId, deliveryUnits.id))
      .where(and(
        eq(deliveryUnits.companyId, companyId),
        eq(deliveryUnitIssues.issueId, issueId),
        inArray(deliveryUnits.status, [...OPEN_UNIT_STATUSES]),
      ))
      .then((rows) => rows[0]?.count ?? 0);
  }

  return {
    evaluateDone,
    assertStatusWriteAllowed,
    assertDeliverableOrThrow,
    classifyCodeDelivery,
    countOpenDeliveryObligations,
  };
}
