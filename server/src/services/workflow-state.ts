import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkflowInstances,
  issueWorkflowLanes,
  issueWorkflowLaneArtifacts,
  issues,
} from "@paperclipai/db";
import type {
  IssueWorkflowArtifactRequirement,
  IssueWorkflowLaneRole,
  IssueWorkflowTemplateKey,
  IssueWorkProductType,
} from "@paperclipai/shared";

type WorkflowArtifactInput = IssueWorkflowArtifactRequirement;

type UpsertWorkflowLaneInput = {
  issueId: string;
  laneRole: IssueWorkflowLaneRole;
  requiredArtifacts: WorkflowArtifactInput[];
  invalidatedAt?: Date | null;
  reviewerAgentId?: string | null;
};

type UpsertWorkflowStateInput = {
  companyId: string;
  rootIssueId: string;
  templateKey: IssueWorkflowTemplateKey;
  lanes: UpsertWorkflowLaneInput[];
};

type HydratableWorkflowIssue = {
  id: string;
  companyId: string;
  parentId?: string | null;
  workflowTemplateKey?: string | null;
  workflowLaneRole?: string | null;
  workflowRequiredArtifacts?: IssueWorkflowArtifactRequirement[] | Record<string, unknown>[] | null;
  workflowInvalidatedAt?: Date | null;
  qaReviewerAgentId?: string | null;
};

const ISSUE_WORK_PRODUCT_TYPES = new Set<IssueWorkProductType>([
  "preview_url",
  "runtime_service",
  "pull_request",
  "branch",
  "commit",
  "artifact",
  "document",
]);

function normalizeWorkflowRequirements(
  raw: IssueWorkflowArtifactRequirement[] | Record<string, unknown>[] | null | undefined,
): IssueWorkflowArtifactRequirement[] {
  if (!Array.isArray(raw)) return [];
  const normalized: IssueWorkflowArtifactRequirement[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.key !== "string"
      || typeof candidate.label !== "string"
      || typeof candidate.kind !== "string"
    ) {
      continue;
    }
    normalized.push({
      key: candidate.key,
      label: candidate.label,
      kind: candidate.kind as IssueWorkflowArtifactRequirement["kind"],
      blocking: candidate.blocking !== false,
      documentKey: typeof candidate.documentKey === "string" ? candidate.documentKey : undefined,
      workProductTypes: Array.isArray(candidate.workProductTypes)
        ? candidate.workProductTypes.filter(
            (value): value is IssueWorkProductType => (
              typeof value === "string" && ISSUE_WORK_PRODUCT_TYPES.has(value as IssueWorkProductType)
            ),
          )
        : undefined,
      commentMarkers: Array.isArray(candidate.commentMarkers)
        ? candidate.commentMarkers.filter((value): value is string => typeof value === "string")
        : undefined,
    });
  }
  return normalized;
}

export function workflowStateService(db: Db) {
  async function replaceLaneArtifacts(
    workflowLaneId: string,
    companyId: string,
    requirements: WorkflowArtifactInput[],
    dbOrTx: any = db,
  ) {
    await dbOrTx
      .delete(issueWorkflowLaneArtifacts)
      .where(eq(issueWorkflowLaneArtifacts.workflowLaneId, workflowLaneId));

    if (requirements.length === 0) return;

    await dbOrTx.insert(issueWorkflowLaneArtifacts).values(
      requirements.map((requirement) => ({
        companyId,
        workflowLaneId,
        artifactKey: requirement.key,
        label: requirement.label,
        kind: requirement.kind,
        blocking: requirement.blocking !== false,
        documentKey: requirement.documentKey ?? null,
        workProductTypes: requirement.workProductTypes ?? null,
        commentMarkers: requirement.commentMarkers ?? null,
      })),
    );
  }

  async function upsertWorkflowState(input: UpsertWorkflowStateInput, dbOrTx: any = db) {
    const now = new Date();
    const [instance] = await dbOrTx
      .insert(issueWorkflowInstances)
      .values({
        companyId: input.companyId,
        rootIssueId: input.rootIssueId,
        templateKey: input.templateKey,
      })
      .onConflictDoUpdate({
        target: issueWorkflowInstances.rootIssueId,
        set: {
          templateKey: input.templateKey,
          updatedAt: now,
        },
      })
      .returning();

    for (const lane of input.lanes) {
      const [persistedLane] = await dbOrTx
        .insert(issueWorkflowLanes)
        .values({
          companyId: input.companyId,
          workflowInstanceId: instance.id,
          rootIssueId: input.rootIssueId,
          issueId: lane.issueId,
          laneRole: lane.laneRole,
          reviewerAgentId: lane.reviewerAgentId ?? null,
          invalidatedAt: lane.invalidatedAt ?? null,
        })
        .onConflictDoUpdate({
          target: [issueWorkflowLanes.workflowInstanceId, issueWorkflowLanes.laneRole],
          set: {
            issueId: lane.issueId,
            reviewerAgentId: lane.reviewerAgentId ?? null,
            invalidatedAt: lane.invalidatedAt ?? null,
            updatedAt: now,
          },
        })
        .returning();

      await replaceLaneArtifacts(
        persistedLane.id,
        input.companyId,
        normalizeWorkflowRequirements(lane.requiredArtifacts),
        dbOrTx,
      );
    }

    return instance;
  }

  async function ensureWorkflowStateForRootIssue(rootIssueId: string, dbOrTx: any = db) {
    const existing = await dbOrTx
      .select({ id: issueWorkflowInstances.id })
      .from(issueWorkflowInstances)
      .where(eq(issueWorkflowInstances.rootIssueId, rootIssueId))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (existing) return existing;

    const rootIssue = await dbOrTx
      .select({
        id: issues.id,
        companyId: issues.companyId,
        workflowTemplateKey: issues.workflowTemplateKey,
      })
      .from(issues)
      .where(eq(issues.id, rootIssueId))
      .then((rows: Array<{
        id: string;
        companyId: string;
        workflowTemplateKey: string | null;
      }>) => rows[0] ?? null);
    if (!rootIssue?.workflowTemplateKey) return null;

    const laneRows: Array<{
      id: string;
      workflowLaneRole: string | null;
      workflowRequiredArtifacts: IssueWorkflowArtifactRequirement[] | Record<string, unknown>[] | null;
      workflowInvalidatedAt: Date | null;
      qaReviewerAgentId: string | null;
    }> = await dbOrTx
      .select({
        id: issues.id,
        workflowLaneRole: issues.workflowLaneRole,
        workflowRequiredArtifacts: issues.workflowRequiredArtifacts,
        workflowInvalidatedAt: issues.workflowInvalidatedAt,
        qaReviewerAgentId: issues.qaReviewerAgentId,
      })
      .from(issues)
      .where(and(eq(issues.parentId, rootIssueId), eq(issues.companyId, rootIssue.companyId)));

    const lanes = laneRows
      .filter((lane): lane is typeof laneRows[number] & { workflowLaneRole: IssueWorkflowLaneRole } => (
        typeof lane.workflowLaneRole === "string"
      ))
      .map((lane) => ({
        issueId: lane.id,
        laneRole: lane.workflowLaneRole,
        requiredArtifacts: normalizeWorkflowRequirements(lane.workflowRequiredArtifacts),
        invalidatedAt: lane.workflowInvalidatedAt ?? null,
        reviewerAgentId: lane.qaReviewerAgentId ?? null,
      }));

    if (lanes.length === 0) return null;

    return upsertWorkflowState({
      companyId: rootIssue.companyId,
      rootIssueId: rootIssue.id,
      templateKey: rootIssue.workflowTemplateKey as IssueWorkflowTemplateKey,
      lanes,
    }, dbOrTx);
  }

  async function hydrateIssue<TIssue extends HydratableWorkflowIssue>(
    issue: TIssue,
    dbOrTx: any = db,
  ): Promise<TIssue> {
    if (issue.parentId) {
      await ensureWorkflowStateForRootIssue(issue.parentId, dbOrTx);
    } else if (issue.workflowTemplateKey) {
      await ensureWorkflowStateForRootIssue(issue.id, dbOrTx);
    }

    const lane = await dbOrTx
      .select({
        laneRole: issueWorkflowLanes.laneRole,
        invalidatedAt: issueWorkflowLanes.invalidatedAt,
        reviewerAgentId: issueWorkflowLanes.reviewerAgentId,
        templateKey: issueWorkflowInstances.templateKey,
      })
      .from(issueWorkflowLanes)
      .innerJoin(issueWorkflowInstances, eq(issueWorkflowInstances.id, issueWorkflowLanes.workflowInstanceId))
      .where(eq(issueWorkflowLanes.issueId, issue.id))
      .then((rows: Array<{
        laneRole: string;
        invalidatedAt: Date | null;
        reviewerAgentId: string | null;
        templateKey: string;
      }>) => rows[0] ?? null);
    if (lane) {
      const artifactRows: Array<{
        artifactKey: string;
        label: string;
        kind: string;
        blocking: boolean;
        documentKey: string | null;
        workProductTypes: IssueWorkProductType[] | null;
        commentMarkers: string[] | null;
      }> = await dbOrTx
        .select({
          artifactKey: issueWorkflowLaneArtifacts.artifactKey,
          label: issueWorkflowLaneArtifacts.label,
          kind: issueWorkflowLaneArtifacts.kind,
          blocking: issueWorkflowLaneArtifacts.blocking,
          documentKey: issueWorkflowLaneArtifacts.documentKey,
          workProductTypes: issueWorkflowLaneArtifacts.workProductTypes,
          commentMarkers: issueWorkflowLaneArtifacts.commentMarkers,
        })
        .from(issueWorkflowLaneArtifacts)
        .innerJoin(issueWorkflowLanes, eq(issueWorkflowLanes.id, issueWorkflowLaneArtifacts.workflowLaneId))
        .where(eq(issueWorkflowLanes.issueId, issue.id));

      const workflowRequiredArtifacts = artifactRows.map((artifact) => ({
        key: artifact.artifactKey,
        label: artifact.label,
        kind: artifact.kind as IssueWorkflowArtifactRequirement["kind"],
        blocking: artifact.blocking,
        documentKey: artifact.documentKey ?? undefined,
        workProductTypes: artifact.workProductTypes ?? undefined,
        commentMarkers: artifact.commentMarkers ?? undefined,
      })) satisfies IssueWorkflowArtifactRequirement[];

      return {
        ...issue,
        workflowTemplateKey: lane.templateKey,
        workflowLaneRole: lane.laneRole,
        workflowRequiredArtifacts:
          workflowRequiredArtifacts.length > 0
            ? workflowRequiredArtifacts
            : normalizeWorkflowRequirements(issue.workflowRequiredArtifacts),
        workflowInvalidatedAt: lane.invalidatedAt ?? issue.workflowInvalidatedAt ?? null,
        qaReviewerAgentId: issue.qaReviewerAgentId ?? lane.reviewerAgentId ?? null,
      };
    }

    const instance = await dbOrTx
      .select({
        templateKey: issueWorkflowInstances.templateKey,
      })
      .from(issueWorkflowInstances)
      .where(eq(issueWorkflowInstances.rootIssueId, issue.id))
      .then((rows: Array<{ templateKey: string }>) => rows[0] ?? null);
    if (!instance) return issue;
    return {
      ...issue,
      workflowTemplateKey: instance.templateKey,
    };
  }

  async function updateLaneState(
    issueId: string,
    patch: {
      invalidatedAt?: Date | null;
      reviewerAgentId?: string | null;
      requiredArtifacts?: IssueWorkflowArtifactRequirement[] | Record<string, unknown>[] | null;
    },
    dbOrTx: any = db,
  ) {
    const lane = await dbOrTx
      .select({
        id: issueWorkflowLanes.id,
        companyId: issueWorkflowLanes.companyId,
      })
      .from(issueWorkflowLanes)
      .where(eq(issueWorkflowLanes.issueId, issueId))
      .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
    if (!lane) return null;

    const [updated] = await dbOrTx
      .update(issueWorkflowLanes)
      .set({
        ...(patch.invalidatedAt !== undefined ? { invalidatedAt: patch.invalidatedAt } : {}),
        ...(patch.reviewerAgentId !== undefined ? { reviewerAgentId: patch.reviewerAgentId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(issueWorkflowLanes.id, lane.id))
      .returning();

    if (patch.requiredArtifacts !== undefined) {
      await replaceLaneArtifacts(
        lane.id,
        lane.companyId,
        normalizeWorkflowRequirements(patch.requiredArtifacts),
        dbOrTx,
      );
    }

    return updated ?? null;
  }

  return {
    upsertWorkflowState,
    ensureWorkflowStateForRootIssue,
    hydrateIssue,
    updateLaneState,
  };
}
