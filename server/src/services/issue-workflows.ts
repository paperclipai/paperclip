import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, documents, issueComments, issueDocuments, issueRelations, issueWorkProducts, issues } from "@paperclipai/db";
import type {
  IssueBoardState,
  IssueWorkflowArtifactRequirement,
  IssueWorkflowArtifactStatus,
  IssueWorkflowLanePhase,
  IssueWorkflowLaneRole,
  IssueWorkflowLaneSummary,
  IssueWorkflowSummary,
  IssueWorkflowTemplateKey,
  IssueWorkProductType,
} from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { isAgentAssignableStatus } from "./agent-assignment-status.js";
import { agentHeartbeatModelService } from "./agent-heartbeat-model.js";
import { pickOperationsAssignmentCandidate, type OpenAssignedIssueForRouting, type OperationsAssignmentCandidate } from "./issue-routing-heuristics.js";
import { evaluateWorkflowQaLaneGate } from "./workflow-qa-lane-gate.js";
import { selectCompanyPooledQaReviewers } from "./qa-reviewer-pool.js";
import { workflowStateService } from "./workflow-state.js";
import { conflict, unprocessable } from "../errors.js";

type WorkflowTemplateDefinition = {
  key: IssueWorkflowTemplateKey;
  label: string;
  lanes: WorkflowLaneDefinition[];
};

type WorkflowLaneDefinition = {
  role: IssueWorkflowLaneRole;
  titlePrefix: string;
  description: string;
  isolatedWorkspace: boolean;
  dependsOnRoles: IssueWorkflowLaneRole[];
  handbackRole: IssueWorkflowLaneRole | null;
  requiredArtifacts: IssueWorkflowArtifactRequirement[];
  desiredSkills?: string[];
};

type WorkflowArtifactCarrier = {
  id: string;
  workflowInvalidatedAt?: Date | null;
  workflowRequiredArtifacts?: IssueWorkflowArtifactRequirement[] | Record<string, unknown>[] | null;
};

type WorkflowLaneCompletionIssue = WorkflowArtifactCarrier & {
  companyId: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  workflowLaneRole?: string | null;
};

type WorkflowDecoratableIssue = WorkflowLaneCompletionIssue & {
  companyId: string;
  parentId: string | null;
  title: string;
  description: string | null;
  identifier: string | null;
  projectId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  status: string;
  workflowTemplateKey?: string | null;
};

type WorkflowTemplateParentIssue = {
  id: string;
  companyId: string;
  parentId: string | null;
  projectId: string | null;
  goalId: string | null;
  priority: string;
  title: string;
  description: string | null;
  identifier: string | null;
  workflowTemplateKey?: string | null;
};

type WorkflowCreatedIssue = WorkflowDecoratableIssue & {
  parentId: string | null;
  priority: string;
  workflowLaneRole?: string | null;
  workflowTemplateKey?: string | null;
};

type WorkflowTemplateApplyIssueInput = Omit<typeof issues.$inferInsert, "companyId"> & {
  blockedByIssueIds?: string[];
  labelIds?: string[];
  inheritExecutionWorkspaceFromIssueId?: string | null;
};

type WorkflowTemplateApplyCreateIssue = (data: WorkflowTemplateApplyIssueInput, dbOrTx?: any) => Promise<WorkflowCreatedIssue>;

type WorkflowTemplateApplyUpdateIssue = (id: string, data: Partial<typeof issues.$inferInsert>, dbOrTx?: any) => Promise<WorkflowCreatedIssue | null>;

const OPEN_ASSIGNMENT_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const QA_PASS_MARKER = "[QA PASS]";
const RELEASE_CONFIRMED_MARKER = "[RELEASE CONFIRMED]";
const SECURITY_FAIL_MARKER_REGEX = /\[(SECURITY FAIL|SECURITY BLOCKED)\]/i;
const LANE_ORDER: IssueWorkflowLaneRole[] = ["pm", "designer", "cto", "engineer", "security", "qa"];

const ENGINEERING_DELIVERY_V1_TEMPLATE: WorkflowTemplateDefinition = {
  key: "engineering_delivery_v1",
  label: "Engineering delivery",
  lanes: [
    {
      role: "pm",
      titlePrefix: "PM",
      description: "Define plan, acceptance criteria, dependencies, and scope guardrails. Complete with a `plan` document.",
      isolatedWorkspace: false,
      dependsOnRoles: [],
      handbackRole: null,
      requiredArtifacts: [
        {
          key: "plan",
          label: "Plan document",
          kind: "document",
          blocking: true,
          documentKey: "plan",
        },
      ],
    },
    {
      role: "designer",
      titlePrefix: "Design",
      description: "Produce a design-ready spec for the implementation lane. Complete with a `design` document or design work product.",
      isolatedWorkspace: false,
      dependsOnRoles: ["pm"],
      handbackRole: "pm",
      requiredArtifacts: [
        {
          key: "design",
          label: "Design artifact",
          kind: "document_or_work_product",
          blocking: true,
          documentKey: "design",
          workProductTypes: ["document", "artifact"],
        },
      ],
    },
    {
      role: "engineer",
      titlePrefix: "Build",
      description: "Implement the requested change. Complete with an `implementation-summary` document or a concrete implementation work product.",
      isolatedWorkspace: true,
      dependsOnRoles: ["designer"],
      handbackRole: "designer",
      requiredArtifacts: [
        {
          key: "implementation-summary",
          label: "Implementation artifact",
          kind: "document_or_work_product",
          blocking: true,
          documentKey: "implementation-summary",
          workProductTypes: ["branch", "commit", "pull_request", "artifact", "document"],
        },
      ],
    },
    {
      role: "security",
      titlePrefix: "Security",
      description: "Perform threat review and capture blocking findings. Complete with a `threat-review` document.",
      isolatedWorkspace: true,
      dependsOnRoles: ["engineer"],
      handbackRole: "engineer",
      requiredArtifacts: [
        {
          key: "threat-review",
          label: "Threat review document",
          kind: "document",
          blocking: true,
          documentKey: "threat-review",
        },
      ],
    },
    {
      role: "qa",
      titlePrefix: "QA",
      description: "Validate the delivery and confirm release readiness. Complete with a `qa-verdict` document and a latest assigned QA verdict comment that includes Smart Review, verification evidence, `[QA PASS]`, and `[RELEASE CONFIRMED]`.",
      isolatedWorkspace: true,
      dependsOnRoles: ["engineer"],
      handbackRole: "engineer",
      requiredArtifacts: [
        {
          key: "qa-verdict",
          label: "QA verdict document",
          kind: "document",
          blocking: true,
          documentKey: "qa-verdict",
        },
        {
          key: "qa-pass",
          label: "[QA PASS] marker",
          kind: "comment_marker",
          blocking: true,
          commentMarkers: [QA_PASS_MARKER],
        },
        {
          key: "release-confirmed",
          label: "[RELEASE CONFIRMED] marker",
          kind: "comment_marker",
          blocking: true,
          commentMarkers: [RELEASE_CONFIRMED_MARKER],
        },
      ],
    },
  ],
};

const CTO_REVIEW_LANE: WorkflowLaneDefinition = {
  role: "cto",
  titlePrefix: "CTO",
  description: "Review the product/design plan for technical approach, sequencing, risk, and delivery constraints. Complete with a `technical-plan` or `architecture-review` document.",
  isolatedWorkspace: false,
  dependsOnRoles: ["designer"],
  handbackRole: "designer",
  requiredArtifacts: [
    {
      key: "technical-plan",
      label: "Technical plan",
      kind: "document",
      blocking: true,
      documentKey: "technical-plan",
    },
  ],
};

const ENGINEERING_DELIVERY_V2_TEMPLATE: WorkflowTemplateDefinition = {
  key: "engineering_delivery_v2",
  label: "Engineering delivery with CTO review",
  lanes: ENGINEERING_DELIVERY_V1_TEMPLATE.lanes.flatMap((lane): WorkflowLaneDefinition[] => {
    if (lane.role !== "engineer") return [lane];
    return [
      CTO_REVIEW_LANE,
      {
        ...lane,
        dependsOnRoles: ["cto"],
        handbackRole: "cto",
      },
    ];
  }),
};

const WORKFLOW_TEMPLATES: Record<IssueWorkflowTemplateKey, WorkflowTemplateDefinition> = {
  engineering_delivery_v1: ENGINEERING_DELIVERY_V1_TEMPLATE,
  engineering_delivery_v2: ENGINEERING_DELIVERY_V2_TEMPLATE,
};

function isTerminalIssueStatus(status: string | null | undefined) {
  return status === "done" || status === "cancelled";
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim();
}

function parseRuntimeConfig(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasMatchingCommentMarker(body: string, markers: string[] | null | undefined) {
  if (!markers || markers.length === 0) return false;
  const normalizedBody = body.toUpperCase();
  return markers.some((marker) => normalizedBody.includes(marker.toUpperCase()));
}

function artifactMissingDetail(requirement: IssueWorkflowArtifactRequirement) {
  switch (requirement.kind) {
    case "document":
      return `${requirement.label} is missing.`;
    case "work_product":
      return `${requirement.label} is missing.`;
    case "document_or_work_product":
      return `${requirement.label} is missing.`;
    case "comment_marker":
      return `${requirement.label} is missing.`;
    default:
      return `${requirement.label} is missing.`;
  }
}

function artifactStaleDetail(requirement: IssueWorkflowArtifactRequirement) {
  return `${requirement.label} is stale and must be refreshed after upstream changes.`;
}

function maxDate(left: Date | null, right: Date | null) {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

function resolveWorkflowTemplate(templateKey: string | null | undefined) {
  if (!templateKey || !(templateKey in WORKFLOW_TEMPLATES)) return null;
  return WORKFLOW_TEMPLATES[templateKey as IssueWorkflowTemplateKey] ?? null;
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function normalizeWorkflowRequirements(
  raw: IssueWorkflowArtifactRequirement[] | Record<string, unknown>[] | null | undefined,
): IssueWorkflowArtifactRequirement[] {
  if (!Array.isArray(raw)) return [];
  const normalized: IssueWorkflowArtifactRequirement[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.key !== "string" || typeof candidate.label !== "string" || typeof candidate.kind !== "string") {
      continue;
    }
    normalized.push({
      key: candidate.key,
      label: candidate.label,
      kind: candidate.kind as IssueWorkflowArtifactRequirement["kind"],
      blocking: candidate.blocking !== false,
      documentKey: typeof candidate.documentKey === "string" ? candidate.documentKey : undefined,
      workProductTypes: Array.isArray(candidate.workProductTypes)
        ? candidate.workProductTypes.filter((value): value is IssueWorkProductType => typeof value === "string") as IssueWorkProductType[]
        : undefined,
      commentMarkers: Array.isArray(candidate.commentMarkers)
        ? candidate.commentMarkers.filter((value): value is string => typeof value === "string")
        : undefined,
    });
  }
  return normalized;
}

function getLaneDefinition(templateKey: string | null | undefined, laneRole: string | null | undefined) {
  const template = resolveWorkflowTemplate(templateKey);
  if (!template || !laneRole) return null;
  return template.lanes.find((lane) => lane.role === laneRole) ?? null;
}

function deriveWorkflowLanePhase(input: {
  issueId: string | null;
  status: string | null | undefined;
  blockedByRoles: IssueWorkflowLaneRole[];
}): IssueWorkflowLanePhase {
  if (!input.issueId) return "missing";
  if (input.status === "done") return "done";
  if (input.blockedByRoles.length > 0) return "waiting";
  if (input.status === "in_progress" || input.status === "in_review") return "active";
  return "ready";
}

function isActionableWorkflowLanePhase(phase: IssueWorkflowLanePhase) {
  return phase === "ready" || phase === "active";
}

function sameWorkflowIssueIdSet(left: string[], right: string[]) {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

type WorkflowTemplateGraphInspection = {
  templateKey: string;
  relationUpdates: Array<{
    issueId: string;
    laneRole: IssueWorkflowLaneRole;
    blockerIssueIds: string[];
    existingBlockerIssueIds: string[];
  }>;
  statusUpdates: Array<{
    issueId: string;
    laneRole: IssueWorkflowLaneRole;
    previousStatus: string;
    status: "blocked" | "todo";
  }>;
};

async function inspectWorkflowTemplateGraph(
  db: Db,
  input: {
    companyId: string;
    parentIssueId: string;
    templateKey: string;
  },
) : Promise<WorkflowTemplateGraphInspection | null> {
  const template = resolveWorkflowTemplate(input.templateKey);
  if (!template) return null;

  const childIssues = await db
    .select({
      id: issues.id,
      status: issues.status,
      workflowLaneRole: issues.workflowLaneRole,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.parentId, input.parentIssueId),
        eq(issues.workflowTemplateKey, input.templateKey),
      ),
    );
  if (childIssues.length === 0) {
    return {
      templateKey: input.templateKey,
      relationUpdates: [],
      statusUpdates: [],
    };
  }

  const childIssueByRole = new Map(
    childIssues
      .filter((issue) => typeof issue.workflowLaneRole === "string")
      .map((issue) => [issue.workflowLaneRole as IssueWorkflowLaneRole, issue]),
  );
  const childIssueById = new Map(childIssues.map((issue) => [issue.id, issue]));
  const childIssueIds = childIssues.map((issue) => issue.id);
  const existingRelationRows = childIssueIds.length === 0
    ? []
    : await db
        .select({
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, input.companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, childIssueIds),
          ),
        );
  const existingBlockedByIssueIdsByChildId = new Map<string, string[]>();
  for (const relation of existingRelationRows) {
    const blockers = existingBlockedByIssueIdsByChildId.get(relation.blockedIssueId) ?? [];
    blockers.push(relation.blockerIssueId);
    existingBlockedByIssueIdsByChildId.set(relation.blockedIssueId, blockers);
  }

  const relationUpdates: WorkflowTemplateGraphInspection["relationUpdates"] = [];
  const statusUpdates: WorkflowTemplateGraphInspection["statusUpdates"] = [];
  for (const lane of template.lanes) {
    const childIssue = childIssueByRole.get(lane.role);
    if (!childIssue) continue;

    const expectedBlockedByIssueIds = lane.dependsOnRoles
      .map((role) => childIssueByRole.get(role)?.id)
      .filter((issueId): issueId is string => typeof issueId === "string");
    const existingBlockedByIssueIds = existingBlockedByIssueIdsByChildId.get(childIssue.id) ?? [];
    if (!sameWorkflowIssueIdSet(expectedBlockedByIssueIds, existingBlockedByIssueIds)) {
      relationUpdates.push({
        issueId: childIssue.id,
        laneRole: lane.role,
        blockerIssueIds: expectedBlockedByIssueIds,
        existingBlockerIssueIds: existingBlockedByIssueIds,
      });
    }

    if (!["backlog", "todo", "blocked"].includes(childIssue.status)) continue;
    const activeBlockedByIssueIds = expectedBlockedByIssueIds.filter((blockerIssueId) => {
      const blockerIssue = childIssueById.get(blockerIssueId);
      return blockerIssue ? !isTerminalIssueStatus(blockerIssue.status) : false;
    });
    if (activeBlockedByIssueIds.length > 0 && childIssue.status !== "blocked") {
      statusUpdates.push({
        issueId: childIssue.id,
        laneRole: lane.role,
        previousStatus: childIssue.status,
        status: "blocked",
      });
      continue;
    }
    if (childIssue.status === "backlog" && activeBlockedByIssueIds.length === 0) {
      statusUpdates.push({
        issueId: childIssue.id,
        laneRole: lane.role,
        previousStatus: childIssue.status,
        status: "todo",
      });
    }
  }

  return {
    templateKey: input.templateKey,
    relationUpdates,
    statusUpdates,
  };
}

async function reconcileWorkflowTemplateGraph(
  db: Db,
  input: {
    companyId: string;
    parentIssueId: string;
    templateKey: string;
  },
) {
  const inspection = await inspectWorkflowTemplateGraph(db, input);
  if (!inspection) {
    return {
      repaired: false,
      relationUpdates: [],
      statusUpdates: [],
    };
  }
  const { relationUpdates, statusUpdates } = inspection;

  if (relationUpdates.length === 0 && statusUpdates.length === 0) {
    return {
      repaired: false,
      relationUpdates,
      statusUpdates,
    };
  }

  await db.transaction(async (tx) => {
    for (const relationUpdate of relationUpdates) {
      await tx
        .delete(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, input.companyId),
            eq(issueRelations.relatedIssueId, relationUpdate.issueId),
            eq(issueRelations.type, "blocks"),
          ),
        );
      if (relationUpdate.blockerIssueIds.length === 0) continue;
      await tx.insert(issueRelations).values(
        relationUpdate.blockerIssueIds.map((blockerIssueId) => ({
          companyId: input.companyId,
          issueId: blockerIssueId,
          relatedIssueId: relationUpdate.issueId,
          type: "blocks" as const,
          createdByAgentId: null,
          createdByUserId: null,
        })),
      );
    }

    for (const statusUpdate of statusUpdates) {
      await tx
        .update(issues)
        .set({
          status: statusUpdate.status,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          completedAt: null,
          cancelledAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(issues.id, statusUpdate.issueId));
    }
  });

  return {
    repaired: true,
    relationUpdates,
    statusUpdates,
  };
}

async function reconcileWorkflowTemplateGraphForIssue(db: Db, issueId: string) {
  const workflowIssue = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      parentId: issues.parentId,
      workflowTemplateKey: issues.workflowTemplateKey,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  if (!workflowIssue?.workflowTemplateKey) {
    return {
      repaired: false,
      relationUpdates: [],
      statusUpdates: [],
    };
  }

  return reconcileWorkflowTemplateGraph(db, {
    companyId: workflowIssue.companyId,
    parentIssueId: workflowIssue.parentId ?? workflowIssue.id,
    templateKey: workflowIssue.workflowTemplateKey,
  });
}

async function listWorkflowOpenAssignedIssues(db: Db, companyId: string) {
  return db
    .select({
      assigneeAgentId: issues.assigneeAgentId,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        inArray(issues.status, [...OPEN_ASSIGNMENT_STATUSES]),
      ),
    );
}

async function listWorkflowAssignmentCandidates(db: Db, companyId: string): Promise<OperationsAssignmentCandidate[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      capabilities: agents.capabilities,
      status: agents.status,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  const openAssignedIssues = await listWorkflowOpenAssignedIssues(db, companyId);
  const openAssignedIssueCountById = new Map<string, number>();
  for (const openIssue of openAssignedIssues) {
    if (!openIssue.assigneeAgentId) continue;
    openAssignedIssueCountById.set(
      openIssue.assigneeAgentId,
      (openAssignedIssueCountById.get(openIssue.assigneeAgentId) ?? 0) + 1,
    );
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    title: row.title,
    capabilities: row.capabilities,
    status: row.status,
    desiredSkills: readPaperclipSkillSyncPreference(parseRuntimeConfig(row.runtimeConfig)).desiredSkills,
    openAssignedIssueCount: openAssignedIssueCountById.get(row.id) ?? 0,
  }));
}

async function computeWorkflowArtifactStatus(
  db: Db,
  issue: WorkflowArtifactCarrier,
): Promise<IssueWorkflowArtifactStatus[]> {
  const requirements = normalizeWorkflowRequirements(issue.workflowRequiredArtifacts);
  if (requirements.length === 0) return [];

  const documentKeys = Array.from(new Set(requirements.map((requirement) => requirement.documentKey).filter(Boolean) as string[]));
  const workProductTypes = Array.from(new Set(
    requirements.flatMap((requirement) => requirement.workProductTypes ?? []).filter(Boolean),
  ));
  const requiresCommentScan = requirements.some((requirement) => requirement.kind === "comment_marker");

  const [documentRows, workProducts, comments] = await Promise.all([
    documentKeys.length > 0
      ? db
          .select({ key: issueDocuments.key, updatedAt: documents.updatedAt })
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, issue.id), inArray(issueDocuments.key, documentKeys)))
      : Promise.resolve([]),
    workProductTypes.length > 0
      ? db
          .select({ type: issueWorkProducts.type, createdAt: issueWorkProducts.createdAt })
          .from(issueWorkProducts)
          .where(and(eq(issueWorkProducts.issueId, issue.id), inArray(issueWorkProducts.type, workProductTypes)))
      : Promise.resolve([]),
    requiresCommentScan
      ? db
          .select({ body: issueComments.body, createdAt: issueComments.createdAt })
          .from(issueComments)
          .where(eq(issueComments.issueId, issue.id))
      : Promise.resolve([]),
  ]);

  const invalidatedAt = issue.workflowInvalidatedAt ? new Date(issue.workflowInvalidatedAt) : null;
  const documentUpdatedAtByKey = new Map<string, Date>();
  for (const document of documentRows) {
    documentUpdatedAtByKey.set(
      document.key,
      maxDate(documentUpdatedAtByKey.get(document.key) ?? null, document.updatedAt) ?? document.updatedAt,
    );
  }
  const workProductCreatedAtByType = new Map<IssueWorkProductType, Date>();
  for (const workProduct of workProducts) {
    const workProductType = workProduct.type as IssueWorkProductType;
    workProductCreatedAtByType.set(
      workProductType,
      maxDate(workProductCreatedAtByType.get(workProductType) ?? null, workProduct.createdAt) ?? workProduct.createdAt,
    );
  }

  return requirements.map((requirement) => {
    let evidenceAt: Date | null = null;
    if (requirement.kind === "document") {
      evidenceAt = requirement.documentKey ? (documentUpdatedAtByKey.get(requirement.documentKey) ?? null) : null;
    } else if (requirement.kind === "work_product") {
      evidenceAt = (requirement.workProductTypes ?? [])
        .reduce<Date | null>((latest, type) => maxDate(latest, workProductCreatedAtByType.get(type) ?? null), null);
    } else if (requirement.kind === "document_or_work_product") {
      evidenceAt = maxDate(
        requirement.documentKey ? (documentUpdatedAtByKey.get(requirement.documentKey) ?? null) : null,
        (requirement.workProductTypes ?? [])
          .reduce<Date | null>((latest, type) => maxDate(latest, workProductCreatedAtByType.get(type) ?? null), null),
      );
    } else if (requirement.kind === "comment_marker") {
      evidenceAt = comments.reduce<Date | null>((latest, comment) =>
        hasMatchingCommentMarker(comment.body, requirement.commentMarkers)
          ? maxDate(latest, comment.createdAt)
          : latest, null);
    }

    const stale = Boolean(evidenceAt && invalidatedAt && evidenceAt.getTime() < invalidatedAt.getTime());
    const satisfied = Boolean(evidenceAt) && !stale;

    return {
      key: requirement.key,
      label: requirement.label,
      kind: requirement.kind,
      blocking: requirement.blocking,
      satisfied,
      stale,
      detail: satisfied ? null : stale ? artifactStaleDetail(requirement) : artifactMissingDetail(requirement),
    } satisfies IssueWorkflowArtifactStatus;
  });
}

async function computeStandardLaneBlockingReasons(
  db: Db,
  issue: WorkflowLaneCompletionIssue,
  artifactStatuses: IssueWorkflowArtifactStatus[],
) {
  const reasons = artifactStatuses
    .filter((artifact) => artifact.blocking && !artifact.satisfied)
    .map((artifact) => artifact.detail ?? `${artifact.label} is missing.`);

  if (!issue.assigneeAgentId && !issue.assigneeUserId) {
    reasons.unshift("Lane has no assigned owner.");
  }

  if (issue.workflowLaneRole === "security") {
    const securityComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    if (securityComments.some((comment) => SECURITY_FAIL_MARKER_REGEX.test(comment.body))) {
      reasons.unshift("Fail-level security findings are unresolved.");
    }
  }

  return Array.from(new Set(reasons));
}

async function evaluateWorkflowLaneGate(
  db: Db,
  issue: WorkflowLaneCompletionIssue,
) {
  if (issue.workflowLaneRole === "qa") {
    return evaluateWorkflowQaLaneGate(db, issue);
  }

  const artifactStatuses = issue.workflowRequiredArtifacts?.length
    ? await computeWorkflowArtifactStatus(db, issue)
    : [];
  const blockingReasons = await computeStandardLaneBlockingReasons(db, issue, artifactStatuses);
  return {
    artifactStatuses,
    blockingReasons,
    canComplete: blockingReasons.length === 0,
  };
}

async function decorateWorkflowLaneIssue<TIssue extends WorkflowDecoratableIssue>(db: Db, issue: TIssue) {
  const laneGate = await evaluateWorkflowLaneGate(db, issue);
  return {
    ...issue,
    workflowArtifactStatus: laneGate.artifactStatuses,
  };
}

async function computeWorkflowSummary(
  db: Db,
  parentIssue: Pick<WorkflowTemplateParentIssue, "id" | "companyId" | "workflowTemplateKey">,
): Promise<IssueWorkflowSummary | null> {
  const template = resolveWorkflowTemplate(parentIssue.workflowTemplateKey);
  if (!template) return null;

  const childIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, parentIssue.companyId), eq(issues.parentId, parentIssue.id)));
  const childIssueByRole = new Map(
    childIssues
      .filter((issue) => typeof issue.workflowLaneRole === "string")
      .map((issue) => [issue.workflowLaneRole as IssueWorkflowLaneRole, issue]),
  );
  const childIssueIds = childIssues.map((issue) => issue.id);
  const activeBlockerRows = childIssueIds.length === 0
    ? []
    : await db
        .select({
          blockedIssueId: issueRelations.relatedIssueId,
          blockerRole: issues.workflowLaneRole,
          blockerStatus: issues.status,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, parentIssue.companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, childIssueIds),
          ),
        );
  const activeBlockedByRolesByIssueId = new Map<string, IssueWorkflowLaneRole[]>();
  for (const blocker of activeBlockerRows) {
    if (!blocker.blockerRole || isTerminalIssueStatus(blocker.blockerStatus)) continue;
    const roles = activeBlockedByRolesByIssueId.get(blocker.blockedIssueId) ?? [];
    if (!roles.includes(blocker.blockerRole as IssueWorkflowLaneRole)) {
      roles.push(blocker.blockerRole as IssueWorkflowLaneRole);
      activeBlockedByRolesByIssueId.set(blocker.blockedIssueId, roles);
    }
  }

  const lanes: IssueWorkflowLaneSummary[] = [];
  const blockingReasons: string[] = [];
  const activeRoles: IssueWorkflowLaneRole[] = [];
  const waitingRoles: IssueWorkflowLaneRole[] = [];
  const ownerNeededRoles: IssueWorkflowLaneRole[] = [];
  for (const laneRole of LANE_ORDER) {
    const laneDefinition = getLaneDefinition(parentIssue.workflowTemplateKey, laneRole);
    if (!laneDefinition) continue;
    const childIssue = childIssueByRole.get(laneRole) ?? null;
    if (!childIssue) {
      blockingReasons.push(`${laneRole.toUpperCase()}: Lane issue is missing.`);
      lanes.push({
        issueId: null,
        role: laneRole,
        title: `${laneDefinition.titlePrefix}: missing lane`,
        status: "missing",
        phase: "missing",
        assigneeAgentId: null,
        assigneeUserId: null,
        workspaceMode: laneDefinition.isolatedWorkspace ? "isolated_workspace" : null,
        blockedByRoles: [],
        ready: false,
        unresolvedOwnership: true,
        artifactStatuses: [],
        blockingReasons: ["Lane issue is missing."],
      });
      continue;
    }

    const blockedByRoles = activeBlockedByRolesByIssueId.get(childIssue.id) ?? [];
    const phase = deriveWorkflowLanePhase({
      issueId: childIssue.id,
      status: childIssue.status,
      blockedByRoles,
    });
    const laneGate = await evaluateWorkflowLaneGate(db, childIssue);
    const actionable = isActionableWorkflowLanePhase(phase);
    const laneBlockingReasons = actionable ? laneGate.blockingReasons : [];
    if (phase === "waiting") {
      waitingRoles.push(laneRole);
    }
    if (actionable) {
      activeRoles.push(laneRole);
    }
    if (actionable && !childIssue.assigneeAgentId && !childIssue.assigneeUserId) {
      ownerNeededRoles.push(laneRole);
    }
    for (const reason of laneBlockingReasons) {
      blockingReasons.push(`${laneRole.toUpperCase()}: ${reason}`);
    }

    lanes.push({
      issueId: childIssue.id,
      role: laneRole,
      title: childIssue.title,
      status: childIssue.status as IssueWorkflowLaneSummary["status"],
      phase,
      assigneeAgentId: childIssue.assigneeAgentId,
      assigneeUserId: childIssue.assigneeUserId,
      workspaceMode:
        (typeof childIssue.executionWorkspaceSettings === "object"
          && childIssue.executionWorkspaceSettings !== null
          && !Array.isArray(childIssue.executionWorkspaceSettings)
          && typeof (childIssue.executionWorkspaceSettings as Record<string, unknown>).mode === "string")
          ? String((childIssue.executionWorkspaceSettings as Record<string, unknown>).mode)
          : childIssue.executionWorkspacePreference,
      blockedByRoles,
      ready: actionable,
      unresolvedOwnership: !childIssue.assigneeAgentId && !childIssue.assigneeUserId,
      artifactStatuses: laneGate.artifactStatuses ?? [],
      blockingReasons: laneBlockingReasons,
    });
  }

  return {
    templateKey: template.key,
    isBlocked: blockingReasons.length > 0,
    blockingReasons: Array.from(new Set(blockingReasons)),
    activeRoles,
    waitingRoles,
    ownerNeededRoles,
    lanes,
  };
}

async function listWorkflowDependentsReadyForPromotion(
  db: Db,
  blockerIssueId: string,
) {
  const blockerIssue = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      workflowTemplateKey: issues.workflowTemplateKey,
      workflowLaneRole: issues.workflowLaneRole,
    })
    .from(issues)
    .where(eq(issues.id, blockerIssueId))
    .then((rows) => rows[0] ?? null);
  if (!blockerIssue?.workflowTemplateKey || !blockerIssue.workflowLaneRole) return [];

  const candidates = await db
    .select({
      id: issues.id,
      status: issues.status,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, blockerIssue.companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.issueId, blockerIssueId),
        eq(issues.workflowTemplateKey, blockerIssue.workflowTemplateKey),
        isNull(issues.hiddenAt),
      ),
    );
  if (candidates.length === 0) return [];

  const candidateIds = candidates
    .filter((candidate) => candidate.status === "blocked")
    .map((candidate) => candidate.id);
  if (candidateIds.length === 0) return [];

  const blockerRows = await db
    .select({
      issueId: issueRelations.relatedIssueId,
      blockerStatus: issues.status,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, blockerIssue.companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, candidateIds),
      ),
    );

  const blockerStatusesByIssueId = new Map<string, string[]>();
  for (const row of blockerRows) {
    const statuses = blockerStatusesByIssueId.get(row.issueId) ?? [];
    statuses.push(row.blockerStatus);
    blockerStatusesByIssueId.set(row.issueId, statuses);
  }

  return candidateIds.filter((issueId) => {
    const blockerStatuses = blockerStatusesByIssueId.get(issueId) ?? [];
    return blockerStatuses.length > 0 && blockerStatuses.every((status) => isTerminalIssueStatus(status));
  });
}

async function getWorkflowLaneContext(
  db: Db,
  issueId: string,
) {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      parentId: issues.parentId,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      workflowTemplateKey: issues.workflowTemplateKey,
      workflowLaneRole: issues.workflowLaneRole,
      workflowInvalidatedAt: issues.workflowInvalidatedAt,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
}

async function listWorkflowDescendantIssueIds(
  db: Db,
  input: {
    companyId: string;
    parentId: string;
    workflowTemplateKey: string;
    rootIssueId: string;
  },
) {
  const descendants: string[] = [];
  const seen = new Set<string>([input.rootIssueId]);
  let frontier = [input.rootIssueId];

  while (frontier.length > 0) {
    const rows = await db
      .select({
        id: issues.id,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, input.companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.issueId, frontier),
          eq(issues.parentId, input.parentId),
          eq(issues.workflowTemplateKey, input.workflowTemplateKey),
          isNull(issues.hiddenAt),
        ),
      );
    const nextFrontier: string[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      descendants.push(row.id);
      nextFrontier.push(row.id);
    }
    frontier = nextFrontier;
  }

  return descendants;
}

function buildWorkflowChildTitle(parentTitle: string, lane: WorkflowLaneDefinition) {
  return `${lane.titlePrefix}: ${parentTitle}`;
}

function buildWorkflowChildInput(
  parentIssue: Pick<WorkflowTemplateParentIssue, "id" | "projectId" | "goalId" | "priority" | "title">,
  templateKey: IssueWorkflowTemplateKey,
  lane: WorkflowLaneDefinition,
  assigneeAgentId: string | null,
  qaReviewerAgentId: string | null,
  blockedByIssueIds: string[],
  actor: { agentId?: string | null; userId?: string | null },
): WorkflowTemplateApplyIssueInput {
  const executionWorkspaceSettings = lane.isolatedWorkspace
    ? { mode: "isolated_workspace" }
    : undefined;
  return {
    parentId: parentIssue.id,
    projectId: parentIssue.projectId,
    goalId: parentIssue.goalId,
    title: buildWorkflowChildTitle(parentIssue.title, lane),
    description: lane.description,
    status: blockedByIssueIds.length > 0 ? "blocked" : "todo",
    priority: parentIssue.priority,
    assigneeAgentId,
    assigneeUserId: null,
    ...(lane.role === "qa" ? { qaReviewerAgentId } : {}),
    workflowTemplateKey: templateKey,
    workflowLaneRole: lane.role,
    workflowRequiredArtifacts: lane.requiredArtifacts as unknown as Record<string, unknown>[],
    blockedByIssueIds,
    inheritExecutionWorkspaceFromIssueId: parentIssue.id,
    ...(lane.isolatedWorkspace ? {
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings,
    } : {}),
    createdByAgentId: actor.agentId ?? null,
    createdByUserId: actor.userId ?? null,
  };
}

function buildRoutingIssue(parentIssue: Pick<WorkflowTemplateParentIssue, "id" | "identifier" | "title" | "description" | "projectId">, lane: WorkflowLaneDefinition) {
  return {
    id: parentIssue.id,
    identifier: parentIssue.identifier ?? null,
    title: buildWorkflowChildTitle(parentIssue.title, lane),
    description: [normalizeText(parentIssue.description), normalizeText(lane.description)].filter(Boolean).join("\n\n"),
    projectId: parentIssue.projectId,
    preferredRole: lane.role,
    workflowLaneRole: lane.role,
    desiredSkills: lane.desiredSkills ?? [],
  };
}

function resolveWorkflowLaneAssigneeId(
  lane: WorkflowLaneDefinition,
  candidate: OperationsAssignmentCandidate | null | undefined,
  qaAssigneeAgentId: string | null,
) {
  if (lane.role === "qa") {
    return qaAssigneeAgentId;
  }
  if (!candidate) return null;
  if (lane.role === "security" && candidate.role !== "security") {
    return null;
  }
  if (lane.role === "cto" && candidate.role !== "cto") {
    return null;
  }
  return candidate.id;
}

function isReadyWorkflowSpecialistCandidate(candidate: Pick<OperationsAssignmentCandidate, "status">) {
  return isAgentAssignableStatus(candidate.status);
}

function hasReadyWorkflowSecuritySpecialist(candidatePool: OperationsAssignmentCandidate[]) {
  return candidatePool.some((candidate) => (
    candidate.role === "security" && isReadyWorkflowSpecialistCandidate(candidate)
  ));
}

function assertWorkflowTemplateCanBeApplied(
  template: WorkflowTemplateDefinition,
  candidatePool: OperationsAssignmentCandidate[],
) {
  const requiresSecurityLane = template.lanes.some((lane) => lane.role === "security");
  if (!requiresSecurityLane) return;

  if (!hasReadyWorkflowSecuritySpecialist(candidatePool)) {
    throw unprocessable("Engineering delivery requires an available security specialist before it can be applied");
  }
}

function updateOpenAssignmentLoad(
  openAssignedIssues: OpenAssignedIssueForRouting[],
  candidatePool: OperationsAssignmentCandidate[],
  issue: Pick<WorkflowTemplateParentIssue, "projectId">,
  assigneeAgentId: string,
) {
  openAssignedIssues.push({ assigneeAgentId, projectId: issue.projectId ?? null });
  const candidate = candidatePool.find((entry) => entry.id === assigneeAgentId);
  if (candidate) {
    candidate.openAssignedIssueCount = (candidate.openAssignedIssueCount ?? 0) + 1;
  }
}

function workflowBlockerToBoardState(issueId: string, headline: string): IssueBoardState {
  return {
    kind: "blocked",
    headline,
    reasonCode: "review",
    actorType: "issue",
    actorId: issueId,
    primaryAction: null,
  };
}

export function synthesizeWorkflowBoardState(issue: {
  id: string;
  workflowLaneRole?: string | null;
  workflowArtifactStatus?: IssueWorkflowArtifactStatus[] | null;
  workflowSummary?: IssueWorkflowSummary | null;
}) {
  if (issue.workflowLaneRole && (issue.workflowArtifactStatus?.length ?? 0) > 0) {
    const missingArtifact = issue.workflowArtifactStatus?.find((artifact) => artifact.blocking && !artifact.satisfied) ?? null;
    if (missingArtifact) {
      return workflowBlockerToBoardState(issue.id, missingArtifact.detail ?? `${missingArtifact.label} is missing.`);
    }
  }
  if (issue.workflowSummary?.isBlocked) {
    const headline = issue.workflowSummary.blockingReasons[0] ?? "Workflow lanes are blocked.";
    return workflowBlockerToBoardState(issue.id, headline);
  }
  return null;
}

export function issueWorkflowService(db: Db) {
  const heartbeatModel = agentHeartbeatModelService(db);
  const workflowState = workflowStateService(db);

  async function ensureWorkflowTemplateCoverage(
    scopeDb: Db | any,
    companyId: string,
    template: WorkflowTemplateDefinition,
  ) {
    let candidatePool = await listWorkflowAssignmentCandidates(scopeDb, companyId);
    const requiresSecurityLane = template.lanes.some((lane) => lane.role === "security");
    if (!requiresSecurityLane || hasReadyWorkflowSecuritySpecialist(candidatePool)) {
      return candidatePool;
    }

    await heartbeatModel.ensureCompanyHasSecurityEngineer(companyId, { apply: true });
    candidatePool = await listWorkflowAssignmentCandidates(scopeDb, companyId);
    assertWorkflowTemplateCanBeApplied(template, candidatePool);
    return candidatePool;
  }

  async function evaluateLaneCompletion(issue: WorkflowLaneCompletionIssue) {
    return evaluateWorkflowLaneGate(db, await workflowState.hydrateIssue(issue));
  }

  async function decorateIssue<TIssue extends WorkflowDecoratableIssue>(issue: TIssue) {
    const hydratedIssue = await workflowState.hydrateIssue(issue);
    if (hydratedIssue.workflowTemplateKey) {
      await reconcileWorkflowTemplateGraph(db, {
        companyId: hydratedIssue.companyId,
        parentIssueId: hydratedIssue.workflowLaneRole ? (hydratedIssue.parentId ?? hydratedIssue.id) : hydratedIssue.id,
        templateKey: hydratedIssue.workflowTemplateKey,
      });
    }
    const decoratedLane = await decorateWorkflowLaneIssue(db, hydratedIssue);
    const workflowSummary =
      hydratedIssue.workflowTemplateKey && !hydratedIssue.workflowLaneRole
        ? await computeWorkflowSummary(db, hydratedIssue)
        : null;
    return {
      ...decoratedLane,
      workflowSummary,
    };
  }

  async function applyTemplate(input: {
    companyId: string;
    templateKey: IssueWorkflowTemplateKey;
    parentIssue: WorkflowTemplateParentIssue;
    actorAgentId?: string | null;
    actorUserId?: string | null;
    createIssue: WorkflowTemplateApplyCreateIssue;
    updateIssue: WorkflowTemplateApplyUpdateIssue;
    dbOrTx?: any;
  }) {
    const template = resolveWorkflowTemplate(input.templateKey);
    if (!template) {
      throw unprocessable(`Unknown workflow template: ${input.templateKey}`);
    }
    if (input.parentIssue.parentId) {
      throw unprocessable("Workflow templates can only be applied to root issues");
    }
    if (input.parentIssue.workflowTemplateKey) {
      throw conflict("Workflow template already applied to this issue");
    }

    const scopeDb = input.dbOrTx ?? db;
    const existingWorkflowChildren = await scopeDb
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.parentId, input.parentIssue.id),
          inArray(issues.workflowLaneRole, template.lanes.map((lane) => lane.role)),
        ),
      )
      .then((rows: Array<{ id: string }>) => rows.length);
    if (existingWorkflowChildren > 0) {
      throw conflict("Workflow lane issues already exist for this parent issue");
    }
    const candidatePool = await ensureWorkflowTemplateCoverage(scopeDb, input.companyId, template);
    const openAssignedIssues = await listWorkflowOpenAssignedIssues(scopeDb, input.companyId);
    const workflowQaAssigneeAgentId =
      (await selectCompanyPooledQaReviewers(scopeDb, input.companyId)).selectedReviewer?.id ?? null;
    const runApply = async (tx: any) => {
      const persistedParent = await tx
        .select({
          id: issues.id,
          parentId: issues.parentId,
          workflowTemplateKey: issues.workflowTemplateKey,
        })
        .from(issues)
        .where(and(eq(issues.id, input.parentIssue.id), eq(issues.companyId, input.companyId)))
        .then((rows: Array<{
          id: string;
          parentId: string | null;
          workflowTemplateKey: string | null;
        }>) => rows[0] ?? null);
      if (!persistedParent) {
        throw unprocessable("Parent issue not found");
      }
      if (persistedParent.parentId) {
        throw unprocessable("Workflow templates can only be applied to root issues");
      }
      if (persistedParent.workflowTemplateKey) {
        throw conflict("Workflow template already applied to this issue");
      }

      const existingWorkflowChildren = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.parentId, input.parentIssue.id),
            inArray(issues.workflowLaneRole, template.lanes.map((lane) => lane.role)),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows.length);
      if (existingWorkflowChildren > 0) {
        throw conflict("Workflow lane issues already exist for this parent issue");
      }

      assertWorkflowTemplateCanBeApplied(template, candidatePool);

      const updatedParent = await input.updateIssue(input.parentIssue.id, {
        workflowTemplateKey: template.key,
      }, tx);
      if (!updatedParent) {
        throw unprocessable("Unable to persist workflow template on parent issue");
      }

      const createdChildren: WorkflowCreatedIssue[] = [];
      const childIssueIdByRole = new Map<IssueWorkflowLaneRole, string>();
      for (const lane of template.lanes) {
        const candidate = pickOperationsAssignmentCandidate({
          issue: buildRoutingIssue(input.parentIssue, lane),
          openAssignedIssues,
          availableCandidates: candidatePool,
          pausedFallbackCandidates: candidatePool,
          allowPausedFallback: false,
        });
        const assigneeAgentId = resolveWorkflowLaneAssigneeId(lane, candidate, workflowQaAssigneeAgentId);
        const blockedByIssueIds = lane.dependsOnRoles
          .map((role) => childIssueIdByRole.get(role))
          .filter((issueId): issueId is string => typeof issueId === "string");
        const created = await input.createIssue(
          buildWorkflowChildInput(
            input.parentIssue,
            template.key,
            lane,
            assigneeAgentId,
            lane.role === "qa" ? assigneeAgentId : null,
            blockedByIssueIds,
            { agentId: input.actorAgentId ?? null, userId: input.actorUserId ?? null },
          ),
          tx,
        );
        createdChildren.push(created);
        childIssueIdByRole.set(lane.role, created.id);
        if (assigneeAgentId) {
          updateOpenAssignmentLoad(openAssignedIssues, candidatePool, input.parentIssue, assigneeAgentId);
        }
      }

      await workflowState.upsertWorkflowState({
        companyId: input.companyId,
        rootIssueId: updatedParent.id,
        templateKey: template.key,
        lanes: createdChildren
          .filter((child): child is WorkflowCreatedIssue & { workflowLaneRole: IssueWorkflowLaneRole } => (
            typeof child.workflowLaneRole === "string"
          ))
          .map((child) => ({
            issueId: child.id,
            laneRole: child.workflowLaneRole,
            requiredArtifacts: normalizeWorkflowRequirements(child.workflowRequiredArtifacts),
            invalidatedAt: child.workflowInvalidatedAt ?? null,
            reviewerAgentId: child.workflowLaneRole === "qa" ? child.assigneeAgentId ?? null : null,
          })),
      }, tx);

      return {
        parentIssue: updatedParent,
        createdChildren,
      };
    };
    try {
      return input.dbOrTx ? await runApply(input.dbOrTx) : await db.transaction(runApply);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("Workflow lane issues already exist for this parent issue");
      }
      throw error;
    }
  }

  async function advanceWorkflowDependents(blockerIssueId: string) {
    await reconcileWorkflowTemplateGraphForIssue(db, blockerIssueId);
    const readyIssueIds = await listWorkflowDependentsReadyForPromotion(db, blockerIssueId);
    if (readyIssueIds.length === 0) return [] as typeof issues.$inferSelect[];
    const readyIssues = await db
      .select()
      .from(issues)
      .where(inArray(issues.id, readyIssueIds));
    if (readyIssues.length === 0) return [] as typeof issues.$inferSelect[];

    return db.transaction(async (tx) => {
      const promotedIssues: typeof issues.$inferSelect[] = [];
      for (const readyIssue of readyIssues) {
        let assigneeAgentId = readyIssue.assigneeAgentId;
        let assigneeUserId = readyIssue.assigneeUserId;
        let qaReviewerAgentId =
          readyIssue.workflowLaneRole === "qa"
            ? readyIssue.assigneeAgentId
            : null;
        if (readyIssue.workflowLaneRole === "qa") {
          assigneeAgentId = (await selectCompanyPooledQaReviewers(tx, readyIssue.companyId, {
            stickyReviewerAgentId: readyIssue.assigneeAgentId,
          })).selectedReviewer?.id ?? null;
          assigneeUserId = null;
          qaReviewerAgentId = assigneeAgentId;
        }

        const promotedIssue = await tx
          .update(issues)
          .set({
            status: "todo",
            assigneeAgentId,
            assigneeUserId,
            ...(readyIssue.workflowLaneRole === "qa" ? { qaReviewerAgentId } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(issues.id, readyIssue.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (promotedIssue) {
          if (promotedIssue.workflowLaneRole === "qa") {
            await workflowState.updateLaneState(promotedIssue.id, {
              reviewerAgentId: qaReviewerAgentId ?? null,
            }, tx);
          }
          promotedIssues.push(promotedIssue);
        }
      }
      return promotedIssues;
    });
  }

  async function invalidateWorkflowDescendants(input: {
    issueId: string;
    invalidateSelf?: boolean;
  }) {
    await reconcileWorkflowTemplateGraphForIssue(db, input.issueId);
    const workflowIssue = await getWorkflowLaneContext(db, input.issueId);
    if (!workflowIssue?.parentId || !workflowIssue.workflowTemplateKey || !workflowIssue.workflowLaneRole) {
      return {
        invalidatedSelf: null as typeof issues.$inferSelect | null,
        invalidatedDescendants: [] as typeof issues.$inferSelect[],
      };
    }

    const descendantIssueIds = await listWorkflowDescendantIssueIds(db, {
      companyId: workflowIssue.companyId,
      parentId: workflowIssue.parentId,
      workflowTemplateKey: workflowIssue.workflowTemplateKey,
      rootIssueId: workflowIssue.id,
    });
    const now = new Date();

    return await db.transaction(async (tx) => {
      const invalidatedSelf =
        input.invalidateSelf
          ? await tx
              .update(issues)
              .set({
                workflowInvalidatedAt: now,
                checkoutRunId: null,
                executionRunId: null,
                executionAgentNameKey: null,
                executionLockedAt: null,
                executionState: null,
                completedAt: null,
                cancelledAt: null,
                updatedAt: sql`now()`,
              })
              .where(eq(issues.id, workflowIssue.id))
              .returning()
              .then((rows) => rows[0] ?? null)
          : null;

      const invalidatedDescendants =
        descendantIssueIds.length === 0
          ? []
          : await tx
              .update(issues)
              .set({
                status: "blocked",
                workflowInvalidatedAt: now,
                checkoutRunId: null,
                executionRunId: null,
                executionAgentNameKey: null,
                executionLockedAt: null,
                executionState: null,
                completedAt: null,
                cancelledAt: null,
                updatedAt: sql`now()`,
              })
              .where(inArray(issues.id, descendantIssueIds))
              .returning();

      if (invalidatedSelf) {
        await workflowState.updateLaneState(invalidatedSelf.id, {
          invalidatedAt: now,
        }, tx);
      }
      for (const descendant of invalidatedDescendants) {
        await workflowState.updateLaneState(descendant.id, {
          invalidatedAt: now,
        }, tx);
      }

      return { invalidatedSelf, invalidatedDescendants };
    });
  }

  async function handbackWorkflowLane(sourceIssueId: string) {
    await reconcileWorkflowTemplateGraphForIssue(db, sourceIssueId);
    const sourceIssue = await getWorkflowLaneContext(db, sourceIssueId);
    if (!sourceIssue?.parentId || !sourceIssue.workflowTemplateKey || !sourceIssue.workflowLaneRole) {
      return null;
    }

    const laneDefinition = getLaneDefinition(sourceIssue.workflowTemplateKey, sourceIssue.workflowLaneRole);
    if (!laneDefinition?.handbackRole) {
      return null;
    }

    const targetIssue = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, sourceIssue.companyId),
          eq(issues.parentId, sourceIssue.parentId),
          eq(issues.workflowTemplateKey, sourceIssue.workflowTemplateKey),
          eq(issues.workflowLaneRole, laneDefinition.handbackRole),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!targetIssue) {
      return null;
    }

    const descendantIssueIds = await listWorkflowDescendantIssueIds(db, {
      companyId: sourceIssue.companyId,
      parentId: sourceIssue.parentId,
      workflowTemplateKey: sourceIssue.workflowTemplateKey,
      rootIssueId: targetIssue.id,
    });
    const now = new Date();

    return await db.transaction(async (tx) => {
      const reopenedTarget = await tx
        .update(issues)
        .set({
          status: "todo",
          workflowInvalidatedAt: now,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          executionState: null,
          completedAt: null,
          cancelledAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(issues.id, targetIssue.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      const invalidatedDescendants =
        descendantIssueIds.length === 0
          ? []
          : await tx
              .update(issues)
              .set({
                status: "blocked",
                workflowInvalidatedAt: now,
                checkoutRunId: null,
                executionRunId: null,
                executionAgentNameKey: null,
                executionLockedAt: null,
                executionState: null,
                completedAt: null,
                cancelledAt: null,
                updatedAt: sql`now()`,
              })
              .where(inArray(issues.id, descendantIssueIds))
              .returning();

      if (reopenedTarget) {
        await workflowState.updateLaneState(reopenedTarget.id, {
          invalidatedAt: now,
        }, tx);
      }
      for (const descendant of invalidatedDescendants) {
        await workflowState.updateLaneState(descendant.id, {
          invalidatedAt: now,
        }, tx);
      }

      return {
        sourceIssueId,
        targetIssue: reopenedTarget,
        invalidatedDescendants,
      };
    });
  }

  return {
    getTemplate(templateKey: IssueWorkflowTemplateKey) {
      return resolveWorkflowTemplate(templateKey);
    },
    evaluateLaneCompletion,
    decorateIssue,
    applyTemplate,
    inspectWorkflowTemplateGraph: async (issueId: string) => {
      const workflowIssue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          workflowTemplateKey: issues.workflowTemplateKey,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!workflowIssue?.workflowTemplateKey) return null;
      return inspectWorkflowTemplateGraph(db, {
        companyId: workflowIssue.companyId,
        parentIssueId: workflowIssue.parentId ?? workflowIssue.id,
        templateKey: workflowIssue.workflowTemplateKey,
      });
    },
    reconcileWorkflowTemplateGraph: async (issueId: string) => await reconcileWorkflowTemplateGraphForIssue(db, issueId),
    advanceWorkflowDependents,
    invalidateWorkflowDescendants,
    handbackWorkflowLane,
  };
}
