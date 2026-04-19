import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issueDocuments, issueWorkProducts, issues } from "@paperclipai/db";
import type {
  IssueBoardState,
  IssueWorkflowArtifactRequirement,
  IssueWorkflowArtifactStatus,
  IssueWorkflowLaneRole,
  IssueWorkflowLaneSummary,
  IssueWorkflowSummary,
  IssueWorkflowTemplateKey,
  IssueWorkProductType,
} from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { pickOperationsAssignmentCandidate, type OpenAssignedIssueForRouting, type OperationsAssignmentCandidate } from "./issue-routing-heuristics.js";
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
  requiredArtifacts: IssueWorkflowArtifactRequirement[];
  desiredSkills?: string[];
};

type WorkflowArtifactCarrier = {
  id: string;
  workflowRequiredArtifacts?: IssueWorkflowArtifactRequirement[] | Record<string, unknown>[] | null;
};

type WorkflowLaneCompletionIssue = WorkflowArtifactCarrier & {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  workflowLaneRole?: string | null;
};

type WorkflowDecoratableIssue = WorkflowLaneCompletionIssue & {
  companyId: string;
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
const LANE_ORDER: IssueWorkflowLaneRole[] = ["pm", "designer", "engineer", "security", "qa"];

const ENGINEERING_DELIVERY_V1_TEMPLATE: WorkflowTemplateDefinition = {
  key: "engineering_delivery_v1",
  label: "Engineering delivery",
  lanes: [
    {
      role: "pm",
      titlePrefix: "PM",
      description: "Define plan, acceptance criteria, dependencies, and scope guardrails. Complete with a `plan` document.",
      isolatedWorkspace: false,
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
      description: "Validate the delivery and confirm release readiness. Complete with a `qa-verdict` document plus `[QA PASS]` and `[RELEASE CONFIRMED]` comments.",
      isolatedWorkspace: true,
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

const WORKFLOW_TEMPLATES: Record<IssueWorkflowTemplateKey, WorkflowTemplateDefinition> = {
  engineering_delivery_v1: ENGINEERING_DELIVERY_V1_TEMPLATE,
};

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

  const [documents, workProducts, comments] = await Promise.all([
    documentKeys.length > 0
      ? db
          .select({ key: issueDocuments.key })
          .from(issueDocuments)
          .where(and(eq(issueDocuments.issueId, issue.id), inArray(issueDocuments.key, documentKeys)))
      : Promise.resolve([]),
    workProductTypes.length > 0
      ? db
          .select({ type: issueWorkProducts.type, title: issueWorkProducts.title })
          .from(issueWorkProducts)
          .where(and(eq(issueWorkProducts.issueId, issue.id), inArray(issueWorkProducts.type, workProductTypes)))
      : Promise.resolve([]),
    requiresCommentScan
      ? db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(eq(issueComments.issueId, issue.id))
      : Promise.resolve([]),
  ]);

  const documentKeySet = new Set(documents.map((document) => document.key));
  const workProductTypeSet = new Set(workProducts.map((workProduct) => workProduct.type));
  const commentBodies = comments.map((comment) => comment.body);

  return requirements.map((requirement) => {
    let satisfied = false;
    if (requirement.kind === "document") {
      satisfied = Boolean(requirement.documentKey && documentKeySet.has(requirement.documentKey));
    } else if (requirement.kind === "work_product") {
      satisfied = (requirement.workProductTypes ?? []).some((type) => workProductTypeSet.has(type));
    } else if (requirement.kind === "document_or_work_product") {
      satisfied = Boolean(
        (requirement.documentKey && documentKeySet.has(requirement.documentKey))
        || (requirement.workProductTypes ?? []).some((type) => workProductTypeSet.has(type)),
      );
    } else if (requirement.kind === "comment_marker") {
      satisfied = commentBodies.some((body) => hasMatchingCommentMarker(body, requirement.commentMarkers));
    }

    return {
      key: requirement.key,
      label: requirement.label,
      kind: requirement.kind,
      blocking: requirement.blocking,
      satisfied,
      detail: satisfied ? null : artifactMissingDetail(requirement),
    } satisfies IssueWorkflowArtifactStatus;
  });
}

async function computeLaneBlockingReasons(
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

async function decorateWorkflowLaneIssue<TIssue extends WorkflowDecoratableIssue>(db: Db, issue: TIssue) {
  const workflowArtifactStatus = issue.workflowRequiredArtifacts?.length
    ? await computeWorkflowArtifactStatus(db, issue)
    : [];
  return {
    ...issue,
    workflowArtifactStatus,
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

  const lanes: IssueWorkflowLaneSummary[] = [];
  for (const laneRole of LANE_ORDER) {
    const laneDefinition = getLaneDefinition(parentIssue.workflowTemplateKey, laneRole);
    if (!laneDefinition) continue;
    const childIssue = childIssueByRole.get(laneRole) ?? null;
    if (!childIssue) {
      lanes.push({
        issueId: null,
        role: laneRole,
        title: `${laneDefinition.titlePrefix}: missing lane`,
        status: "missing",
        assigneeAgentId: null,
        assigneeUserId: null,
        workspaceMode: laneDefinition.isolatedWorkspace ? "isolated_workspace" : null,
        unresolvedOwnership: true,
        artifactStatuses: [],
        blockingReasons: ["Lane issue is missing."],
      });
      continue;
    }

    const decoratedLane = await decorateWorkflowLaneIssue(db, childIssue);
    const blockingReasons = await computeLaneBlockingReasons(db, childIssue, decoratedLane.workflowArtifactStatus ?? []);
      lanes.push({
        issueId: childIssue.id,
        role: laneRole,
        title: childIssue.title,
        status: childIssue.status as IssueWorkflowLaneSummary["status"],
      assigneeAgentId: childIssue.assigneeAgentId,
      assigneeUserId: childIssue.assigneeUserId,
      workspaceMode:
        (typeof childIssue.executionWorkspaceSettings === "object"
          && childIssue.executionWorkspaceSettings !== null
          && !Array.isArray(childIssue.executionWorkspaceSettings)
          && typeof (childIssue.executionWorkspaceSettings as Record<string, unknown>).mode === "string")
          ? String((childIssue.executionWorkspaceSettings as Record<string, unknown>).mode)
          : childIssue.executionWorkspacePreference,
      unresolvedOwnership: !childIssue.assigneeAgentId && !childIssue.assigneeUserId,
      artifactStatuses: decoratedLane.workflowArtifactStatus ?? [],
      blockingReasons,
    });
  }

  const blockingReasons = lanes.flatMap((lane) => lane.blockingReasons.map((reason) => `${lane.role.toUpperCase()}: ${reason}`));
  return {
    templateKey: template.key,
    isBlocked: blockingReasons.length > 0,
    blockingReasons,
    lanes,
  };
}

function buildWorkflowChildTitle(parentTitle: string, lane: WorkflowLaneDefinition) {
  return `${lane.titlePrefix}: ${parentTitle}`;
}

function buildWorkflowChildInput(
  parentIssue: Pick<WorkflowTemplateParentIssue, "id" | "projectId" | "goalId" | "priority" | "title">,
  lane: WorkflowLaneDefinition,
  assigneeAgentId: string | null,
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
    status: "todo",
    priority: parentIssue.priority,
    assigneeAgentId,
    assigneeUserId: null,
    workflowTemplateKey: ENGINEERING_DELIVERY_V1_TEMPLATE.key,
    workflowLaneRole: lane.role,
    workflowRequiredArtifacts: lane.requiredArtifacts as unknown as Record<string, unknown>[],
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
    desiredSkills: lane.desiredSkills ?? [],
  };
}

function resolveWorkflowLaneAssigneeId(
  lane: WorkflowLaneDefinition,
  candidate: OperationsAssignmentCandidate | null | undefined,
) {
  if (!candidate) return null;
  if (lane.role === "security" && candidate.role !== "security") {
    return null;
  }
  return candidate.id;
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
  async function evaluateLaneCompletion(issue: WorkflowLaneCompletionIssue) {
    const artifactStatuses = await computeWorkflowArtifactStatus(db, issue);
    const blockingReasons = await computeLaneBlockingReasons(db, issue, artifactStatuses);
    return {
      artifactStatuses,
      blockingReasons,
      canComplete: blockingReasons.length === 0,
    };
  }

  async function decorateIssue<TIssue extends WorkflowDecoratableIssue>(issue: TIssue) {
    const decoratedLane = await decorateWorkflowLaneIssue(db, issue);
    const workflowSummary =
      issue.workflowTemplateKey && !issue.workflowLaneRole
        ? await computeWorkflowSummary(db, issue)
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

    const candidatePool = await listWorkflowAssignmentCandidates(db, input.companyId);
    const openAssignedIssues = await listWorkflowOpenAssignedIssues(db, input.companyId);
    try {
      return await db.transaction(async (tx) => {
        const persistedParent = await tx
          .select({
            id: issues.id,
            parentId: issues.parentId,
            workflowTemplateKey: issues.workflowTemplateKey,
          })
          .from(issues)
          .where(and(eq(issues.id, input.parentIssue.id), eq(issues.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null);
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
          .then((rows) => rows.length);
        if (existingWorkflowChildren > 0) {
          throw conflict("Workflow lane issues already exist for this parent issue");
        }

        const updatedParent = await input.updateIssue(input.parentIssue.id, {
          workflowTemplateKey: template.key,
        }, tx);
        if (!updatedParent) {
          throw unprocessable("Unable to persist workflow template on parent issue");
        }

        const createdChildren: WorkflowCreatedIssue[] = [];
        for (const lane of template.lanes) {
          const candidate = pickOperationsAssignmentCandidate({
            issue: buildRoutingIssue(input.parentIssue, lane),
            openAssignedIssues,
            availableCandidates: candidatePool,
            pausedFallbackCandidates: candidatePool,
            allowPausedFallback: false,
          });
          const assigneeAgentId = resolveWorkflowLaneAssigneeId(lane, candidate);
          const created = await input.createIssue(
            buildWorkflowChildInput(
              input.parentIssue,
              lane,
              assigneeAgentId,
              { agentId: input.actorAgentId ?? null, userId: input.actorUserId ?? null },
            ),
            tx,
          );
          createdChildren.push(created);
          if (assigneeAgentId) {
            updateOpenAssignmentLoad(openAssignedIssues, candidatePool, input.parentIssue, assigneeAgentId);
          }
        }

        return {
          parentIssue: updatedParent,
          createdChildren,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("Workflow lane issues already exist for this parent issue");
      }
      throw error;
    }
  }

  return {
    getTemplate(templateKey: IssueWorkflowTemplateKey) {
      return resolveWorkflowTemplate(templateKey);
    },
    evaluateLaneCompletion,
    decorateIssue,
    applyTemplate,
  };
}
